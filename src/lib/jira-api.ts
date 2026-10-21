/**
 * The Jira Server / Data Center REST v2 client (HTTP Basic, username+password).
 *
 * Everything here exists because this is an *intranet* Jira behind an SSO
 * front door, not a Cloud tenant:
 *
 *  - Redirects are never followed. Following one lands on an HTML login page
 *    that then fails as a JSON parse error, hiding the real cause; a 3xx is
 *    surfaced as an auth failure with its `Location` so the user can see they
 *    were bounced to SSO.
 *  - `btoa` cannot encode a non-Latin1 username/password (it throws
 *    `InvalidCharacterError`), so Basic credentials are built from UTF-8 bytes.
 *  - TLS verification is relaxed per request when configured — see
 *    `withTlsOverride`. Do NOT reuse `isPrivateNetworkHost` here: that is an
 *    SSRF guard for user-supplied URLs and it rejects RFC1918 hosts, which is
 *    exactly where an internal Jira resolves to.
 */

import { jiraApiUrl } from "@/lib/jira-config"
import { getHttpFetch, isFetchNetworkError, withTlsOverride } from "@/lib/tauri-fetch"
import type { JiraConfig } from "@/stores/wiki-store"
import type {
  JiraAttachment,
  JiraComment,
  JiraErrorKind,
  JiraIssueFull,
  JiraSearchResponse,
  JiraServerInfo,
} from "@/types/jira"

const SEARCH_TIMEOUT_MS = 60_000
const ATTACHMENT_TIMEOUT_MS = 120_000

/** Fields `search()` asks for by default — enough to render a result card. */
export const JIRA_SEARCH_FIELDS = [
  "summary",
  "labels",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "created",
  "updated",
  "project",
] as const

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Standard padded base64 over raw bytes — what `write_file_base64` expects. */
export function bytesToBase64(bytes: Uint8Array): string {
  let encoded = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    encoded += BASE64_ALPHABET[first >> 2]
    encoded += BASE64_ALPHABET[((first & 0b11) << 4) | ((second ?? 0) >> 4)]
    encoded += second === undefined ? "=" : BASE64_ALPHABET[((second & 0b1111) << 2) | ((third ?? 0) >> 6)]
    encoded += third === undefined ? "=" : BASE64_ALPHABET[third & 0b111111]
  }
  return encoded
}

/**
 * Base64 over the UTF-8 *bytes* of `value` — the equivalent of Python's
 * `base64.b64encode(s.encode())` that the reference skill uses. `btoa` would
 * throw on anything outside Latin-1.
 */
export function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
}

export interface JiraApiErrorInit {
  kind: JiraErrorKind
  status: number
  url: string
  message?: string
  /** Raw response body, kept for diagnostics. Never contains credentials. */
  bodyText?: string
  location?: string
}

export class JiraApiError extends Error {
  readonly kind: JiraErrorKind
  readonly status: number
  readonly url: string
  readonly bodyText: string
  readonly location: string | undefined

  constructor(init: JiraApiErrorInit) {
    super(init.message ?? `Jira request failed (HTTP ${init.status})`)
    this.name = "JiraApiError"
    this.kind = init.kind
    this.status = init.status
    this.url = init.url
    this.bodyText = init.bodyText ?? ""
    this.location = init.location
  }

  /** What Jira said, minus the noise — `errorMessages` when it is JSON. */
  private bodyExcerpt(): string {
    const raw = this.bodyText.trim()
    if (!raw) return ""
    try {
      const parsed = JSON.parse(raw) as { errorMessages?: unknown; errors?: unknown }
      const messages: string[] = []
      if (Array.isArray(parsed.errorMessages)) {
        messages.push(...parsed.errorMessages.filter((item): item is string => typeof item === "string"))
      }
      if (parsed.errors && typeof parsed.errors === "object") {
        for (const [field, detail] of Object.entries(parsed.errors as Record<string, unknown>)) {
          if (typeof detail === "string") messages.push(`${field}: ${detail}`)
        }
      }
      if (messages.length > 0) return messages.join("; ").slice(0, 300)
    } catch {
      // Not JSON (a WAF page, say) — the raw excerpt below is still useful.
    }
    return raw.replace(/\s+/g, " ").slice(0, 300)
  }

  /** One line for the UI. Built only from the status, URL and response body. */
  describe(): string {
    const parts = [this.message]
    if (this.location) parts.push(`Location: ${this.location}`)
    const excerpt = this.bodyExcerpt()
    if (excerpt) parts.push(excerpt)
    return parts.join(" · ")
  }
}

export interface JiraSendOptions {
  method?: "GET" | "POST"
  body?: string
  contentType?: string
  signal?: AbortSignal
  timeoutMs: number
}

export class JiraClient {
  private readonly config: JiraConfig
  private readonly fetchImpl: typeof globalThis.fetch | null

  /** `fetchImpl` is injectable so tests can drive the client without a network. */
  constructor(config: JiraConfig, fetchImpl?: typeof globalThis.fetch) {
    this.config = config
    this.fetchImpl = fetchImpl ?? null
  }

  private requestHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${utf8ToBase64(`${this.config.username}:${this.config.password}`)}`,
      Accept: "application/json",
    }
    const userAgent = this.config.userAgent.trim()
    if (userAgent) headers["User-Agent"] = userAgent
    if (contentType) headers["Content-Type"] = contentType
    return headers
  }

  private async send(url: string, options: JiraSendOptions): Promise<Response> {
    const httpFetch = this.fetchImpl ?? (await getHttpFetch())
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    // Bridge the caller's signal (debounce superseded, view unmounted) in.
    const forwardAbort = () => controller.abort()
    options.signal?.addEventListener("abort", forwardAbort)

    try {
      let response: Response
      try {
        // `maxRedirections` is a plugin-http transport flag; reqwest does not
        // read the standard `redirect` option, and native fetch ignores extras.
        const init: RequestInit & { maxRedirections: number } = {
          method: options.method ?? "GET",
          headers: this.requestHeaders(options.contentType),
          body: options.body,
          redirect: "manual",
          maxRedirections: 0,
          signal: controller.signal,
        }
        response = await httpFetch(url, withTlsOverride(init, this.config.acceptInvalidCerts))
      } catch (error) {
        throw this.toNetworkError(url, options.timeoutMs, timedOut, error)
      }
      await this.assertUsable(response, url)
      return response
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", forwardAbort)
    }
  }

  private toNetworkError(
    url: string,
    timeoutMs: number,
    timedOut: boolean,
    error: unknown,
  ): JiraApiError {
    if (error instanceof Error && error.name === "AbortError") {
      return new JiraApiError({
        kind: "network",
        status: 0,
        url,
        message: timedOut
          ? `Request timed out after ${Math.round(timeoutMs / 1000)}s`
          : "Request aborted",
      })
    }
    const message = error instanceof Error ? error.message : String(error)
    return new JiraApiError({
      kind: "network",
      status: 0,
      url,
      message: isFetchNetworkError(error) ? `Network error: ${message}` : message,
    })
  }

  private async assertUsable(response: Response, url: string): Promise<void> {
    const status = response.status
    if (status >= 300 && status < 400) {
      throw new JiraApiError({
        kind: "auth",
        status,
        url,
        location: response.headers.get("location") ?? undefined,
        message: "The request was redirected — Jira expects HTTP Basic auth, not an SSO login page.",
      })
    }
    if (status === 401 || status === 403) {
      throw new JiraApiError({
        kind: "auth",
        status,
        url,
        bodyText: await this.safeText(response),
      })
    }
    if (status === 404) {
      throw new JiraApiError({ kind: "not-found", status, url, bodyText: await this.safeText(response) })
    }
    if (!response.ok) {
      throw new JiraApiError({ kind: "http", status, url, bodyText: await this.safeText(response) })
    }
  }

  private async safeText(response: Response, limit = 400): Promise<string> {
    try {
      return (await response.text()).slice(0, limit)
    } catch {
      return ""
    }
  }

  private async readJson<T>(response: Response, url: string): Promise<T> {
    const contentType = response.headers.get("content-type") ?? ""
    // The body can only be read once, so read it in full and slice for errors.
    const text = await this.safeText(response, Number.MAX_SAFE_INTEGER)
    if (!/json/i.test(contentType)) {
      throw new JiraApiError({
        kind: "http",
        status: response.status,
        url,
        message: `Expected a JSON response but got "${contentType || "no content-type"}"`,
        bodyText: text.slice(0, 200),
      })
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new JiraApiError({
        kind: "http",
        status: response.status,
        url,
        message: "The response body is not valid JSON",
        bodyText: text.slice(0, 200),
      })
    }
  }

  async testConnection(signal?: AbortSignal): Promise<JiraServerInfo> {
    const url = jiraApiUrl(this.config.baseUrl, "serverInfo")
    const response = await this.send(url, { signal, timeoutMs: SEARCH_TIMEOUT_MS })
    return this.readJson<JiraServerInfo>(response, url)
  }

  /**
   * `GET /search` first (what the reference skill uses), falling back once to
   * `POST /search` for DC 9.x/10.x instances where the GET form was deprecated.
   * A failure is never swallowed into an empty result set — the status code and
   * Jira's own `errorMessages` have to reach the UI or DC version differences
   * are undiagnosable.
   */
  async search(params: {
    jql: string
    startAt?: number
    maxResults?: number
    fields?: readonly string[]
    signal?: AbortSignal
  }): Promise<JiraSearchResponse> {
    const startAt = params.startAt ?? 0
    const maxResults = params.maxResults ?? 50
    const fields = params.fields ?? JIRA_SEARCH_FIELDS
    const url =
      `${jiraApiUrl(this.config.baseUrl, "search")}?` +
      new URLSearchParams({
        jql: params.jql,
        startAt: String(startAt),
        maxResults: String(maxResults),
        fields: fields.join(","),
      }).toString()
    try {
      const response = await this.send(url, { signal: params.signal, timeoutMs: SEARCH_TIMEOUT_MS })
      return await this.readJson<JiraSearchResponse>(response, url)
    } catch (error) {
      const deprecated =
        error instanceof JiraApiError &&
        (error.status === 404 || error.status === 405 || error.status === 410)
      if (!deprecated) throw error
      const postUrl = jiraApiUrl(this.config.baseUrl, "search")
      const response = await this.send(postUrl, {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ jql: params.jql, startAt, maxResults, fields: [...fields] }),
        signal: params.signal,
        timeoutMs: SEARCH_TIMEOUT_MS,
      })
      return this.readJson<JiraSearchResponse>(response, postUrl)
    }
  }

  async getIssue(
    key: string,
    fields: readonly string[],
    options: { expandChangelog?: boolean; signal?: AbortSignal } = {},
  ): Promise<JiraIssueFull> {
    const params = new URLSearchParams({ fields: fields.join(",") })
    if (options.expandChangelog) params.set("expand", "changelog")
    const url = `${jiraApiUrl(this.config.baseUrl, `issue/${encodeURIComponent(key)}`)}?${params.toString()}`
    const response = await this.send(url, { signal: options.signal, timeoutMs: SEARCH_TIMEOUT_MS })
    return this.readJson<JiraIssueFull>(response, url)
  }

  async getCommentsPage(
    key: string,
    startAt: number,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<{ comments: JiraComment[]; total: number }> {
    const url =
      `${jiraApiUrl(this.config.baseUrl, `issue/${encodeURIComponent(key)}/comment`)}?` +
      new URLSearchParams({ startAt: String(startAt), maxResults: String(maxResults) }).toString()
    const response = await this.send(url, { signal, timeoutMs: SEARCH_TIMEOUT_MS })
    const body = await this.readJson<{ comments?: JiraComment[]; total?: number }>(response, url)
    return { comments: body.comments ?? [], total: body.total ?? body.comments?.length ?? 0 }
  }

  /** Raw bytes — an attachment is written straight to disk, never decoded as text. */
  async downloadAttachment(
    attachment: JiraAttachment,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.send(attachment.content, {
      signal,
      timeoutMs: ATTACHMENT_TIMEOUT_MS,
    })
    return new Uint8Array(await response.arrayBuffer())
  }
}
