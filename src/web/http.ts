// Web shim for `@tauri-apps/plugin-http`.
//
// The desktop app uses Tauri's Rust HTTP plugin so it can set arbitrary
// headers and reach providers that omit CORS headers. The browser cannot do
// either, so cross-origin requests are forwarded through the server's
// streaming `/api/proxy` endpoint (which mirrors the plugin's purpose).
// Same-origin requests (the app's own /api/* calls) go straight through.

function headersToObject(input?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input) return out
  if (input instanceof Headers) { input.forEach((v, k) => { out[k] = v }); return out }
  if (Array.isArray(input)) { for (const [k, v] of input) out[k] = v; return out }
  return { ...(input as Record<string, string>) }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function isSameOrigin(url: string): boolean {
  if (url.startsWith("/")) return true
  try {
    if (typeof location === "undefined") return false
    return new URL(url, location.href).origin === location.origin
  } catch {
    return false
  }
}

async function bodyToString(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null
  if (typeof body === "string") return body
  if (body instanceof URLSearchParams) return body.toString()
  // Blob / ArrayBuffer / TypedArray / ReadableStream → text (LLM bodies are JSON text)
  return await new Response(body as BodyInit).text()
}

export const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = urlOf(input)
  if (isSameOrigin(url)) return globalThis.fetch(input, init)

  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  const headers = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const body = (method === "GET" || method === "HEAD") ? null : await bodyToString(init?.body)

  return globalThis.fetch("/api/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, method, headers, body }),
  })
}

export default fetch
