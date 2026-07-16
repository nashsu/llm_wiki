/**
 * Global HTTP/HTTPS proxy configuration.
 *
 * Persisted to the same `app-state.json` store as other settings.
 * The Rust setup hook (src-tauri/src/proxy.rs) reads this on app
 * launch and translates it into HTTP_PROXY / HTTPS_PROXY / NO_PROXY
 * environment variables — reqwest (used by tauri-plugin-http) picks
 * those up automatically and routes every outbound HTTP request
 * through the configured proxy.
 *
 * Changes apply on app restart; the UI surfaces a "Restart now"
 * button so users don't have to do it manually.
 *
 * v1 supports HTTP and HTTPS proxies only. SOCKS5 needs a reqwest
 * cargo feature flag and is deferred.
 */

export interface ProxyConfig {
  enabled: boolean
  /**
   * Full proxy URL with scheme, e.g. `http://127.0.0.1:7890`.
   * Embedded basic auth (`http://user:pass@host:port`) is fine —
   * stored verbatim alongside other API keys (no separate secret
   * store).
   */
  url: string
  /**
   * When true, requests to localhost / 127.x / private RFC1918
   * networks / *.local hostnames bypass the proxy. Recommended
   * default — without it, Ollama / LM Studio / LAN-deployed LLMs
   * get sent to the external proxy and fail.
   */
  bypassLocal: boolean
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  enabled: false,
  url: "",
  bypassLocal: true,
}

/**
 * The list applied to NO_PROXY when bypassLocal is on. reqwest's
 * NO_PROXY parser accepts comma-separated hostnames, IP literals,
 * CIDR blocks, and `*.suffix` wildcards.
 *
 * Covers: loopback, all RFC1918 private blocks, RFC6762 multicast
 * DNS suffix. Not user-editable in v1 — toggle bypassLocal on/off
 * is the whole UI.
 */
export const DEFAULT_BYPASS_LIST =
  "localhost,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local"

const SUPPORTED_SCHEMES = ["http:", "https:"] as const

export type ValidateResult = { ok: true } | { ok: false; error: string }

export function validateProxyUrl(url: string): ValidateResult {
  const trimmed = url.trim()
  if (trimmed === "") return { ok: false, error: "URL is empty" }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: "Not a valid URL" }
  }

  if (!parsed.protocol) {
    return { ok: false, error: "URL is missing a scheme (http:// or https://)" }
  }
  if (!SUPPORTED_SCHEMES.includes(parsed.protocol as (typeof SUPPORTED_SCHEMES)[number])) {
    return {
      ok: false,
      error: `Unsupported scheme "${parsed.protocol}". Use http:// or https://`,
    }
  }
  if (!parsed.hostname) {
    return { ok: false, error: "URL is missing a host" }
  }
  return { ok: true }
}

/**
 * Build the value that should be written to the NO_PROXY env var,
 * or `null` to indicate NO_PROXY should not be set (everything goes
 * through the proxy when bypass is off).
 */
export function buildNoProxyValue(bypassLocal: boolean): string | null {
  return bypassLocal ? DEFAULT_BYPASS_LIST : null
}

/**
 * "Should the proxy actually take effect?" Composite check used by
 * the Rust startup hook and any UI element that needs to surface
 * the effective proxy state. False if disabled, URL empty, or URL
 * malformed — these all collapse to "no proxy" rather than half-
 * applying a broken config.
 */
export function isProxyActive(cfg: ProxyConfig): boolean {
  if (!cfg.enabled) return false
  if (cfg.url.trim() === "") return false
  return validateProxyUrl(cfg.url).ok
}
