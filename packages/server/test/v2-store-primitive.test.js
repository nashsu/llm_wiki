// Regression test: the web store shim writes per-key values whose JSON body is
// a bare primitive (e.g. store.set("outputLanguage", "English") → PUT body
// `"English"`). express.json() defaults to strict mode, which only accepts a
// top-level object/array and 400s on primitives — so every string/number/
// boolean setting silently failed to persist over the web shim. The parser
// must run with strict:false so these bodies parse.

import { describe, it, expect, afterAll } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-storeprim-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

// Mirrors src/web/http-api.ts storePutKey: JSON.stringify(value) as the raw body.
function putKey(name, key, rawJson) {
  return request(app)
    .put(`/api/store/${name}/${key}`)
    .set("Content-Type", "application/json")
    .send(rawJson)
}

describe("store key API accepts primitive JSON bodies (strict:false)", () => {
  it("persists and reads back a bare string value", async () => {
    const put = await putKey("teststore", "outputLanguage", '"English"')
    expect(put.status).toBe(200)

    const get = await request(app).get("/api/store/teststore/outputLanguage")
    expect(get.status).toBe(200)
    expect(get.body).toBe("English")
  })

  it("persists and reads back a bare number value", async () => {
    const put = await putKey("teststore", "zoomLevel", "1.25")
    expect(put.status).toBe(200)

    const get = await request(app).get("/api/store/teststore/zoomLevel")
    expect(get.status).toBe(200)
    expect(get.body).toBe(1.25)
  })

  it("persists and reads back a bare boolean value", async () => {
    const put = await putKey("teststore", "fileSyncEnabled", "false")
    expect(put.status).toBe(200)

    const get = await request(app).get("/api/store/teststore/fileSyncEnabled")
    expect(get.status).toBe(200)
    expect(get.body).toBe(false)
  })
})
