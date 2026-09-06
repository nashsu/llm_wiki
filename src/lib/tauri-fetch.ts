/**
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

import { useWikiStore } from "@/stores/wiki-store"
import { isProxyActive, type ProxyConfig } from "@/lib/proxy-config"
import { getBackend } from "@/lib/backend"

let pluginFetchPromise: Promise<typeof globalThis.fetch> | null = null

type PluginRequestInit = RequestInit & {
  danger?: {
    acceptInvalidCerts?: boolean
    acceptInvalidHostnames?: boolean
  }
}

export function withProxyTlsSettings(
  init: RequestInit | undefined,
  proxy: ProxyConfig,
): PluginRequestInit | undefined {
  if (!isProxyActive(proxy) || proxy.acceptInvalidCerts !== true) return init
  const pluginInit = init as PluginRequestInit | undefined
  return {
    ...pluginInit,
    danger: {
      ...pluginInit?.danger,
      acceptInvalidCerts: true,
    },
  }
}

/**
 * Returns a fetch function for user-configured endpoints: Tauri's
 * Rust-backed HTTP plugin on the desktop, the server-side proxy in web
 * mode, and the platform fetch in tests / Node. Call this once per request:
 *
 *   const httpFetch = await getHttpFetch()
 *   const response = await httpFetch(url, opts)
 *
 * The promise is cached, so repeated calls don't re-resolve the backend.
 */
export function getHttpFetch(): Promise<typeof globalThis.fetch> {
  if (!pluginFetchPromise) {
    const host = getBackend()
    pluginFetchPromise = host.getFetch().then((hostFetch) => {
      if (host.kind !== "tauri") return hostFetch
      const configuredFetch: typeof globalThis.fetch = (input, init) => {
        // Read at request time so changing Network settings takes effect
        // immediately. The option is deliberately scoped to the proxy
        // toggle; disabling the proxy restores normal TLS verification.
        const proxy = useWikiStore.getState().proxyConfig
        const requestInit = withProxyTlsSettings(init, proxy)
        return hostFetch(input, requestInit)
      }
      return configuredFetch
    })
  }
  return pluginFetchPromise
}

/**
 * Detect fetch-level network failures across Tauri's different webview
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
