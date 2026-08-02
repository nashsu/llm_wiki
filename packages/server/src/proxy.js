import { Readable } from "node:stream"

// Server-side HTTP proxy that replaces the role of Tauri's HTTP plugin
// (`@tauri-apps/plugin-http` with the `unsafe-headers` feature): the browser
// cannot set arbitrary headers or reach providers that omit CORS headers, so
// the web client routes cross-origin requests (LLM chat/ingest, etc.) through
// this endpoint. The upstream response is streamed back verbatim so SSE-style
// LLM streaming works end-to-end.

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-encoding",
  "content-length", "te", "trailer", "upgrade", "proxy-authenticate",
  "proxy-authorization",
])

export async function handleProxy(req, res) {
  let raw = ""
  for await (const chunk of req) raw += chunk
  let spec
  try { spec = JSON.parse(raw || "{}") } catch {
    res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"Invalid JSON"}'); return
  }
  const { url, method = "GET", headers = {}, body = null } = spec
  if (!url || typeof url !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"Missing url"}'); return
  }
  let parsed
  try { parsed = new URL(url) } catch {
    res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"Invalid url"}'); return
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"Only http(s) URLs may be proxied"}'); return
  }

  const fwdHeaders = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) fwdHeaders[k] = v
  }

  let upstream
  try {
    upstream = await fetch(url, {
      method,
      headers: fwdHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : (body ?? undefined),
      redirect: "follow",
    })
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" })
    res.end(JSON.stringify({ error: `Proxy upstream error: ${err.message}` }))
    return
  }

  const outHeaders = { "Access-Control-Allow-Origin": "*" }
  upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v })
  res.writeHead(upstream.status, outHeaders)

  if (!upstream.body) { res.end(); return }
  Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res)
}
