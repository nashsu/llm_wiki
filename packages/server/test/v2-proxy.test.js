// Regression test: the browser web client routes every cross-origin request
// (LLM chat/embedding, web search — anything a user-configured URL) through
// POST /api/proxy (see src/web/http.ts). The legacy server mounted that route,
// but the v2 server never did, so in the web build "Test connection" (and every
// other provider call) hit an Express 404 ("Cannot POST /api/proxy") instead of
// reaching the provider. The route must exist on v2, stream the upstream
// response verbatim (SSE), validate input, and honour the auth contract.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import request from "supertest"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-proxy-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

// Tiny upstream that the proxy should forward to. Returns an SSE-style body so
// we can assert streaming passthrough, and echoes a header to confirm headers
// (minus hop-by-hop) are forwarded.
let upstreamUrl = ""
const upstream = createServer((req, res) => {
  if (req.url === "/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "x-upstream-saw": req.headers["x-test-header"] ?? "none",
    })
    res.write("data: hello\n\n")
    res.write("data: world\n\n")
    res.end()
    return
  }
  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("upstream 404")
})

beforeAll(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r))
  const addr = upstream.address()
  upstreamUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise((r) => upstream.close(() => r(undefined)))
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

describe("v2 POST /api/proxy (web cross-origin transport)", () => {
  it("streams the upstream response verbatim and forwards headers", async () => {
    const res = await request(app)
      .post("/api/proxy")
      .set("Content-Type", "application/json")
      .send({
        url: `${upstreamUrl}/sse`,
        method: "POST",
        headers: { "x-test-header": "forwarded" },
        body: "{}",
      })

    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("text/event-stream")
    expect(res.headers["x-upstream-saw"]).toBe("forwarded")
    expect(res.text).toContain("data: hello")
    expect(res.text).toContain("data: world")
  })

  it("rejects a missing url with 400", async () => {
    const res = await request(app)
      .post("/api/proxy")
      .set("Content-Type", "application/json")
      .send({})
    expect(res.status).toBe(400)
  })

  it("rejects non-http(s) schemes with 400", async () => {
    const res = await request(app)
      .post("/api/proxy")
      .set("Content-Type", "application/json")
      .send({ url: "file:///etc/passwd", method: "GET", headers: {} })
    expect(res.status).toBe(400)
  })

  it("enforces the auth contract in token mode", async () => {
    process.env.AUTH_MODE = "token"
    process.env.LLM_WIKI_API_TOKEN = "secret123"
    try {
      const noAuth = await request(app)
        .post("/api/proxy")
        .set("Content-Type", "application/json")
        .send({ url: `${upstreamUrl}/sse`, method: "GET", headers: {} })
      expect(noAuth.status).toBe(401)

      const withAuth = await request(app)
        .post("/api/proxy")
        .set("Content-Type", "application/json")
        .set("Authorization", "Bearer secret123")
        .send({ url: `${upstreamUrl}/sse`, method: "GET", headers: {} })
      expect(withAuth.status).toBe(200)
    } finally {
      process.env.AUTH_MODE = "none"
      delete process.env.LLM_WIKI_API_TOKEN
    }
  })
})
