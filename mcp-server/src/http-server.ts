#!/usr/bin/env node
// Streamable HTTP transport for the LLM Wiki MCP server — same shape as the
// vault (company-brain-kit/modules/mcp-server) and OpenWA bridges built the
// same night: session-based StreamableHTTPServerTransport, dual auth
// (static bearer for clients without OAuth support + DCR/password-gated
// OAuth for everyone else), Cloudflare Tunnel in front. Unlike those two,
// this one also auto-starts a Quick Tunnel when no custom domain is
// configured — see quick-tunnel.ts — so it works out of the box for anyone
// running LLM Wiki, not just deployments with their own domain.
import { randomUUID, timingSafeEqual } from "node:crypto"
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import type { Request, Response, NextFunction } from "express"
import { createToolServer } from "./tool-server.js"
import { LlmWikiOAuthProvider } from "./oauth-provider.js"
import { startQuickTunnel } from "./quick-tunnel.js"

const VERSION = "0.1.0"
const PORT = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT, 10) : 8931
const HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1"
const TOKEN = process.env.MCP_HTTP_TOKEN
const APPROVAL_PASSWORD = process.env.OAUTH_APPROVAL_PASSWORD

async function main(): Promise<void> {
  if (!TOKEN && HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
    console.error(
      `Refusing to start: MCP_HTTP_HOST=${HOST} exposes this server beyond localhost but MCP_HTTP_TOKEN is unset. ` +
      "Set MCP_HTTP_TOKEN or bind to 127.0.0.1.",
    )
    process.exit(1)
  }
  if (!TOKEN) {
    console.error("[llm-wiki-mcp-http] WARNING: MCP_HTTP_TOKEN unset — static bearer auth disabled.")
  }

  // Resolve the public URL BEFORE building the app: OAuth's issuer/redirect
  // metadata must exactly match how clients actually reach this server, so
  // whether it comes from env (a stable named tunnel) or a freshly-started
  // Quick Tunnel, it has to be known before mcpAuthRouter is constructed.
  let publicHostname = process.env.MCP_PUBLIC_HOSTNAME
  let quickTunnelUrl: string | undefined
  if (!publicHostname) {
    console.error("[llm-wiki-mcp-http] MCP_PUBLIC_HOSTNAME not set — starting a Cloudflare Quick Tunnel (no domain required)...")
    try {
      const tunnel = await startQuickTunnel(PORT)
      quickTunnelUrl = tunnel.url
      publicHostname = new URL(tunnel.url).hostname
      console.error(`[llm-wiki-mcp-http] Quick Tunnel ready: ${tunnel.url} (changes on every restart)`)
      process.on("SIGINT", () => { tunnel.stop(); process.exit(0) })
      process.on("SIGTERM", () => { tunnel.stop(); process.exit(0) })
    } catch (err) {
      console.error(
        `[llm-wiki-mcp-http] Could not start a Quick Tunnel: ${err instanceof Error ? err.message : String(err)}. ` +
        "Remote access (OAuth, and any client outside this machine) is unavailable. " +
        "The server still works for localhost-only clients.",
      )
    }
  }
  if (publicHostname && !APPROVAL_PASSWORD) {
    console.error(
      "Refusing to start: a public hostname is configured (OAuth/DCR would be enabled) but OAUTH_APPROVAL_PASSWORD is unset. " +
      "Without it, anyone who self-registers a client via DCR gets an auto-approved token.",
    )
    process.exit(1)
  }

  const oauthProvider = publicHostname ? new LlmWikiOAuthProvider(APPROVAL_PASSWORD!) : undefined

  function checkBearer(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization ?? ""
    if (TOKEN) {
      const expected = `Bearer ${TOKEN}`
      if (header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected))) {
        next()
        return
      }
    }
    const [scheme, token] = header.split(" ")
    if (oauthProvider && scheme === "Bearer" && token) {
      oauthProvider
        .verifyAccessToken(token)
        .then(() => next())
        .catch(() => res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }))
      return
    }
    if (!TOKEN && !oauthProvider) {
      next() // no auth configured at all — localhost-only per the guard above
      return
    }
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null })
  }

  const ALLOWED_HOSTS = process.env.MCP_HTTP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean)
    ?? (publicHostname ? [publicHostname] : undefined)
  const app = createMcpExpressApp(ALLOWED_HOSTS?.length ? { host: HOST, allowedHosts: ALLOWED_HOSTS } : { host: HOST })
  app.set("trust proxy", 1) // Cloudflare Tunnel (named or Quick) is the only reverse proxy in front
  app.get("/healthz", (_req, res) => res.json({ ok: true, version: VERSION, publicUrl: quickTunnelUrl ?? (publicHostname ? `https://${publicHostname}` : null) }))

  if (oauthProvider && publicHostname) {
    const publicUrl = new URL(`https://${publicHostname}`)
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: publicUrl,
        resourceServerUrl: new URL("/mcp", publicUrl),
        scopesSupported: ["mcp"],
      }),
    )
    app.post("/authorize/approve", async (req, res) => {
      await oauthProvider.approve(req.body?.requestId, req.body?.password, res)
    })
  }

  const transports: Record<string, StreamableHTTPServerTransport> = {}

  app.post("/mcp", checkBearer, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    try {
      let transport: StreamableHTTPServerTransport
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId]
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports[sid] = transport },
        })
        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) delete transports[sid]
        }
        const server = createToolServer()
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null })
        return
      }
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      console.error("[llm-wiki-mcp-http] error handling POST /mcp:", err)
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null })
      }
    }
  })

  async function handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    const transport = sessionId ? transports[sessionId] : undefined
    if (!transport) {
      res.status(400).send("Invalid or missing session ID")
      return
    }
    await transport.handleRequest(req, res)
  }
  app.get("/mcp", checkBearer, handleSessionRequest)
  app.delete("/mcp", checkBearer, handleSessionRequest)

  app.listen(PORT, HOST, () => {
    const publicUrl = quickTunnelUrl ? `${quickTunnelUrl}/mcp` : publicHostname ? `https://${publicHostname}/mcp` : null
    console.error(
      `LLM Wiki MCP HTTP server v${VERSION} listening on http://${HOST}:${PORT}/mcp ` +
      `(static token: ${TOKEN ? "yes" : "no"}, OAuth/DCR: ${oauthProvider ? "yes" : "no"})` +
      (publicUrl ? `\nPublic URL: ${publicUrl}` : ""),
    )
  })
}

main().catch((err) => {
  console.error("Failed to start LLM Wiki MCP HTTP server:", err)
  process.exit(1)
})
