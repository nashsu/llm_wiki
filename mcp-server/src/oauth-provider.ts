import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto"
import type { Response } from "express"
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js"
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js"
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js"

// Same pattern as company-brain-kit/modules/mcp-server (the vault MCP):
// any MCP host self-registers via DCR (POST /register, SDK-native,
// rate-limited to 20/hour) with its own real redirect_uri — no more
// hardcoding a callback URL per platform. Registration alone grants zero
// access; authorize() below gates every request behind a password only the
// vault/WhatsApp owner knows, regardless of which client is asking.
const CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
const PENDING_APPROVAL_TTL_MS = 5 * 60 * 1000

interface StoredCode {
  clientId: string
  codeChallenge: string
  scopes: string[]
  expiresAt: number
}

interface StoredToken {
  clientId: string
  scopes: string[]
  expiresAt: number
}

interface PendingApproval {
  client: OAuthClientInformationFull
  params: AuthorizationParams
  expiresAt: number
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

class DynamicClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>()

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId)
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): Promise<OAuthClientInformationFull> {
    const full = client as OAuthClientInformationFull
    this.clients.set(full.client_id, full)
    return full
  }
}

function renderApprovalForm(requestId: string, clientName: string, error?: string): string {
  const errorHtml = error ? `<p style="color:#b00020;margin:0 0 12px">${error}</p>` : ""
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Autorizza accesso</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 16px">
<h1 style="font-size:18px">Autorizza accesso a LLM Wiki</h1>
<p>Client: <strong>${clientName}</strong></p>
${errorHtml}
<form method="POST" action="/authorize/approve">
<input type="hidden" name="requestId" value="${requestId}">
<input type="password" name="password" placeholder="Password" autofocus
  style="width:100%;padding:8px;font-size:16px;box-sizing:border-box;margin-bottom:12px">
<button type="submit" style="width:100%;padding:8px;font-size:16px">Autorizza</button>
</form>
</body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

// Tokens don't survive a process restart — ponytail: acceptable for
// personal single-owner use, add persistent token storage if this ever
// needs to survive restarts without re-auth.
export class LlmWikiOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new DynamicClientsStore()
  private codes = new Map<string, StoredCode>()
  private accessTokens = new Map<string, StoredToken>()
  private refreshTokens = new Map<string, StoredToken>()
  private pendingApprovals = new Map<string, PendingApproval>()

  constructor(private readonly approvalPassword: string) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = randomUUID()
    this.pendingApprovals.set(requestId, { client, params, expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS })
    res.send(renderApprovalForm(requestId, escapeHtml(client.client_name ?? client.client_id)))
  }

  async approve(requestId: string | undefined, password: string | undefined, res: Response): Promise<void> {
    const pending = requestId ? this.pendingApprovals.get(requestId) : undefined
    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).send(`<!doctype html><p>Richiesta scaduta o non valida. Riprova il collegamento dal client MCP.</p>`)
      return
    }
    if (!password || !safeEqual(password, this.approvalPassword)) {
      res
        .status(401)
        .send(renderApprovalForm(requestId!, escapeHtml(pending.client.client_name ?? pending.client.client_id), "Password errata."))
      return
    }
    this.pendingApprovals.delete(requestId!) // one-time use

    const { client, params } = pending
    const code = randomUUID()
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
      expiresAt: Date.now() + CODE_TTL_MS,
    })
    const target = new URL(params.redirectUri)
    target.searchParams.set("code", code)
    if (params.state !== undefined) target.searchParams.set("state", params.state)
    res.redirect(target.toString())
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const stored = this.codes.get(authorizationCode)
    if (!stored || stored.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code")
    return stored.codeChallenge
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const stored = this.codes.get(authorizationCode)
    if (!stored || stored.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code")
    if (stored.clientId !== client.client_id) throw new InvalidGrantError("Authorization code was not issued to this client")
    this.codes.delete(authorizationCode) // one-time use

    const accessToken = randomBytes(32).toString("hex")
    const refreshToken = randomBytes(32).toString("hex")
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: stored.scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    })
    this.refreshTokens.set(refreshToken, { clientId: client.client_id, scopes: stored.scopes, expiresAt: Infinity })

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: stored.scopes.join(" "),
    }
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const stored = this.refreshTokens.get(refreshToken)
    if (!stored) throw new InvalidGrantError("Invalid refresh token")
    if (stored.clientId !== client.client_id) throw new InvalidGrantError("Refresh token was not issued to this client")

    const accessToken = randomBytes(32).toString("hex")
    this.accessTokens.set(accessToken, {
      clientId: client.client_id,
      scopes: stored.scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    })
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: stored.scopes.join(" "),
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.accessTokens.get(token)
    if (!stored || stored.expiresAt < Date.now()) throw new Error("Invalid or expired access token")
    return { token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: Math.floor(stored.expiresAt / 1000) }
  }
}
