// Regression tests for three real-user-scenario findings:
//
//  #10 — token-auth mode must still serve the web client (SPA HTML / static
//        assets) unauthenticated, so the client-side LoginScreen can render.
//        Only the /api/* data surface is gated. (middleware/auth.js)
//  #11 — manual editor saves (write_file / write_file_atomic) must record a
//        File History version, so human edits show up in the history panel
//        the same way agent edits do. (commands/fs.js)
//  #12 — /api/home must be mounted on the v2 server (the web file-picker's
//        getHome() requests it); it was only on the legacy server. (index-v2.js)
//
// IMPORTANT: env vars that the app reads at MODULE LOAD (LLM_WIKI_DATA_DIR)
// are set before importing the app. AUTH_MODE / LLM_WIKI_API_TOKEN are read
// per-request by resolveAuth(), so they can be toggled at runtime per test.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// ── isolated data dir BEFORE importing the app ────────────────────────────
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-scenario-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

// A real on-disk project for the file-history test.
const PROJECT_DIR = path.join(DATA_DIR, "proj")

beforeAll(() => {
  mkdirSync(path.join(PROJECT_DIR, "wiki"), { recursive: true })
  mkdirSync(path.join(PROJECT_DIR, ".llm-wiki"), { recursive: true })
  writeFileSync(path.join(PROJECT_DIR, "schema.md"), "# Wiki Schema\n")
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

afterEach(() => {
  // Never leak token mode into another test.
  process.env.AUTH_MODE = "none"
  delete process.env.LLM_WIKI_API_TOKEN
})

describe("#10 — token-auth still serves the web client", () => {
  it("serves non-/api routes (SPA) without a token in token mode", async () => {
    process.env.AUTH_MODE = "token"
    process.env.LLM_WIKI_API_TOKEN = "secret123"

    const res = await request(app).get("/")

    // The middleware must NOT reject the SPA with a 401 UNAUTHORIZED envelope.
    // Depending on whether a web build is present this is 200 (HTML) or 503
    // ("build not found") — both prove the request reached the static/SPA
    // handler instead of being blocked by auth.
    expect(res.status).not.toBe(401)
    expect(res.body?.error?.code).not.toBe("UNAUTHORIZED")
  })

  it("still gates the /api data surface in token mode", async () => {
    process.env.AUTH_MODE = "token"
    process.env.LLM_WIKI_API_TOKEN = "secret123"

    const noToken = await request(app).get("/api/v2/projects")
    expect(noToken.status).toBe(401)
    expect(noToken.body.error.code).toBe("UNAUTHORIZED")

    const withToken = await request(app)
      .get("/api/v2/projects")
      .set("Authorization", "Bearer secret123")
    expect(withToken.status).not.toBe(401)
  })
})

describe("#12 — /api/home is mounted on the v2 server", () => {
  it("returns the HomeInfo payload", async () => {
    const res = await request(app).get("/api/home")
    expect(res.status).toBe(200)
    expect(typeof res.body.home).toBe("string")
    expect(typeof res.body.cwd).toBe("string")
    expect(typeof res.body.separator).toBe("string")
    expect(typeof res.body.platform).toBe("string")
  })
})

describe("#11 — manual writes record File History versions", () => {
  it("write_file records a human version that list_file_history returns", async () => {
    const target = path.join(PROJECT_DIR, "wiki", "manual-edit.md")

    const write = await request(app)
      .post("/api/invoke/write_file")
      .send({ path: target, contents: "# Manual\nEdited by a human.\n" })
    expect(write.status).toBe(200)
    expect(write.body.ok).toBe(true)

    const list = await request(app)
      .post("/api/invoke/list_file_history")
      .send({ projectPath: PROJECT_DIR, filePath: target })
    expect(list.status).toBe(200)
    expect(list.body.ok).toBe(true)

    const entries = list.body.result
    expect(Array.isArray(entries)).toBe(true)
    expect(entries.length).toBeGreaterThan(0)
    // The latest snapshot is the human edit we just wrote.
    const last = entries[entries.length - 1]
    expect(last.author).toBe("human")
    expect(last.content).toContain("Edited by a human.")
  })

  it("write_file_atomic also records a human version", async () => {
    const target = path.join(PROJECT_DIR, "wiki", "atomic-edit.md")

    const write = await request(app)
      .post("/api/invoke/write_file_atomic")
      .send({ path: target, contents: "atomic content\n" })
    expect(write.status).toBe(200)

    const list = await request(app)
      .post("/api/invoke/list_file_history")
      .send({ projectPath: PROJECT_DIR, filePath: target })
    const entries = list.body.result
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[entries.length - 1].author).toBe("human")
  })
})

describe("auth mode heuristic — auto is open iff no token is configured", () => {
  // Regression: in auto mode (AUTH_MODE unset) the middleware used to compute
  // authRequired as `!allowUnauth`, which is true even with NO token set — so a
  // token-less deployment (the docker-compose default) 401'd every API call
  // while /auth/status reported authRequired:false. Auto must be open when no
  // token is configured and required only once a token exists.

  it("auto mode with NO token is open (docker-compose default)", async () => {
    delete process.env.AUTH_MODE // auto
    delete process.env.LLM_WIKI_API_TOKEN
    const res = await request(app).get("/api/v2/projects")
    expect(res.status).not.toBe(401)
  })

  it("auto mode WITH a token requires it", async () => {
    delete process.env.AUTH_MODE // auto
    process.env.LLM_WIKI_API_TOKEN = "sekrit"
    const denied = await request(app).get("/api/v2/projects")
    expect(denied.status).toBe(401)
    const allowed = await request(app)
      .get("/api/v2/projects")
      .set("Authorization", "Bearer sekrit")
    expect(allowed.status).not.toBe(401)
  })

  it("AUTH_MODE=none is open even when a token is configured", async () => {
    process.env.AUTH_MODE = "none"
    process.env.LLM_WIKI_API_TOKEN = "sekrit"
    const res = await request(app).get("/api/v2/projects")
    expect(res.status).not.toBe(401)
  })

  it("AUTH_MODE=token with no token configured is closed", async () => {
    process.env.AUTH_MODE = "token"
    delete process.env.LLM_WIKI_API_TOKEN
    const res = await request(app).get("/api/v2/projects")
    expect(res.status).toBe(401)
  })
})
