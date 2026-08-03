// Regression tests for the legacy /api/invoke bridge error handling.
//
// When a command handler throws a plain Error (business error such as
// "Directory already exists" or "missing schema.md"), the bridge must surface
// the real message to the client as a VALIDATION_ERROR instead of letting the
// global error handler scrub it to a generic INTERNAL_ERROR. ApiErrors (e.g.
// NOT_FOUND for an unknown command) must still pass through unchanged, and the
// success envelope shape { ok: true, result } must be preserved.
//
// IMPORTANT: env vars are set BEFORE the app module is imported, because the
// app reads LLM_WIKI_DATA_DIR at module load.

import { describe, it, expect, afterAll } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// ── set up isolated data dir BEFORE importing the app ─────────────────────
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-bridge-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none" // open mode: no token required (local-first test)
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

describe("legacy /api/invoke bridge error handling", () => {
  it("surfaces a command-handler collision message (create_project)", async () => {
    const base = mkdtempSync(path.join(DATA_DIR, "base-"))
    mkdirSync(path.join(base, "exists"))

    const res = await request(app)
      .post("/api/invoke/create_project")
      .send({ name: "exists", path: base })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect(res.body.error.message).toContain("already exists")
    expect(res.body.error.message).not.toContain("Internal server error")
  })

  it("surfaces a command-handler validation message (open_project)", async () => {
    const emptyDir = mkdtempSync(path.join(DATA_DIR, "empty-"))

    const res = await request(app)
      .post("/api/invoke/open_project")
      .send({ path: emptyDir })

    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain("schema.md")
    expect(res.body.error.message).not.toContain("Internal server error")
  })

  it("passes ApiErrors through unchanged (unknown command → NOT_FOUND)", async () => {
    const res = await request(app)
      .post("/api/invoke/this_command_does_not_exist")
      .send({})

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })

  it("answers a missing-resource probe with 200 ok:false (not a 400)", async () => {
    // Optional sidecar probes (chat-history.json, lint.json, …) legitimately
    // miss on a fresh project. The web client catches the throw and treats it
    // as empty, so a 4xx would only produce a logged failed request + a server
    // stack trace on every project open. The bridge must answer 200 + ok:false
    // instead, with the real reason in the envelope so the transport re-throws.
    const missing = path.join(DATA_DIR, "does-not-exist.json")

    const res = await request(app)
      .post("/api/invoke/read_file")
      .send({ path: missing })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.code).toBe("NOT_FOUND")
    expect(res.body.error.message).toMatch(/no such file|does not exist/i)
  })

  it("answers a missing-directory probe (list_directory) with 200 ok:false", async () => {
    const missingDir = path.join(DATA_DIR, "no-such-dir")

    const res = await request(app)
      .post("/api/invoke/list_directory")
      .send({ path: missingDir })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })

  it("keeps the success envelope shape { ok: true, result }", async () => {
    const projectDir = path.join(DATA_DIR, "valid-proj")
    mkdirSync(path.join(projectDir, "wiki"), { recursive: true })
    mkdirSync(path.join(projectDir, ".llm-wiki"), { recursive: true })
    writeFileSync(path.join(projectDir, "schema.md"), "# Wiki Schema\n")

    const res = await request(app)
      .post("/api/invoke/open_project")
      .send({ path: projectDir })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.result.name).toBe("valid-proj")
    expect(res.body.result.path).toBeDefined()
    expect(res.body.result.path.endsWith("valid-proj")).toBe(true)
  })
})
