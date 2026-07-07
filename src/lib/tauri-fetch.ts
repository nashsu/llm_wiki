/**
 * @deprecated This module is preserved for existing callers that route
 *   third-party HTTP through Tauri's plugin for CORS workarounds.
 *
 *   For new code that targets the **LLM Wiki Python backend** (the sidecar
 *   server at ``localhost:19828``), use the helpers in ``@/lib/api-client``
 *   instead — they talk directly to the Python HTTP API via standard
 *   ``fetch()`` and do not need the Tauri HTTP plugin.
 *
 *   Background: the Python sidecar now serves the API that used to be
 *   handled by Tauri Rust commands. The front-end should migrate all
 *   ``invoke()`` and Tauri-plugin-http calls to ``@/lib/api-client``.
 *
 * Shared HTTP helpers routed through Tauri's Rust-backed plugin so
 * third-party endpoints that don't set browser-friendly CORS headers
 * still work. Every part of the app that hits a user-configured URL
 * (LLM chat, embedding, web search, anything new) should import from
 * here rather than call `fetch` directly.
 *
 * Why it matters:
 *  - MiniMax's /anthropic endpoint: CORS allow-headers omits x-api-key
 *  - Volcengine Ark /api/coding/v3: CORS omits Authorization entirely
 *  - Any enterprise / on-prem gateway that doesn't anticipate browser
 *    origins — a common shape across domestic Chinese clouds
 *
 * In unit tests (vitest / node), the plugin's browser-only globals
 * aren't available; `getHttpFetch` lazily imports and falls back to
 * `globalThis.fetch` so helper functions in this file can be imported
 * from any environment without crashing at module load.
 */

/**
 * Returns a fetch function that falls back to the platform's native fetch
 * in all environments (browser, Node, vitest). The Tauri HTTP plugin is
 * no longer used.
 *
 *   const httpFetch = await getHttpFetch()
 *   const response = await httpFetch(url, opts)
 *
 * The promise is cached, so repeated calls don't re-import the plugin.
 */
export function getHttpFetch(): Promise<typeof globalThis.fetch> {
  return Promise.resolve(globalThis.fetch.bind(globalThis))
}

/**
 * Detect fetch-level network failures across different webview
 * backends. Each platform phrases the same failure class differently:
 *
 *   macOS / iOS (WebKit):       Error,  message === "Load failed"
 *   Windows    (Edge WebView2): TypeError, message === "Failed to fetch"
 *   Linux      (WebKitGTK):     Error,  message === "Load failed"
 *
 * They all collapse DNS / TLS / connection-refused / CORS-preflight
 * into a single opaque error with no structured detail. The only
 * reliable cross-platform signal is "not an AbortError AND one of
 * these generic network error shapes", which this helper centralizes.
 */
export function isFetchNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === "AbortError") return false
  // Chromium / Edge WebView2
  if (err.name === "TypeError") return true
  // WebKit (macOS / Linux GTK)
  if (err.message === "Load failed") return true
  // Chromium mid-stream drop
  if (err.message === "Failed to fetch") return true
  if (err.message.includes("network error")) return true
  return false
}
