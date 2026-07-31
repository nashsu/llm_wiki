// Regression test for v2 POST /api/v2/projects on-disk scaffolding (issue #2).
//
// The v2 create route used to INSERT a DB row without creating the project
// directory, so the stored path pointed at nothing and the next lookup failed
// validation. It must now scaffold the wiki tree at the project root (the v2
// contract: `path` IS the root, unlike the legacy command where it's the
// parent). Also asserts the clobber guard (409 when the dir already exists).
//
// IMPORTANT: env vars set BEFORE importing the app (it reads LLM_WIKI_DATA_DIR
// at module load). AUTH_MODE=none guarantees open mode regardless of host env.

import { describe, it, expect, afterAll } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-v2create-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

describe("v2 POST /api/v2/projects scaffolds the project on disk", () => {
  it("creates the directory tree + seed files at the given root", async () => {
    const root = path.join(DATA_DIR, "fresh-v2-proj")

    const res = await request(app)
      .post("/api/v2/projects")
      .send({ name: "fresh-v2-proj", path: root })

    expect(res.status).toBe(201)
    expect(res.body.project.id).toBeTypeOf("number")
    expect(res.body.project.path).toBe(root)

    // On-disk scaffold must exist (the whole point of #2).
    expect(existsSync(root)).toBe(true)
    expect(existsSync(path.join(root, "schema.md"))).toBe(true)
    expect(existsSync(path.join(root, "purpose.md"))).toBe(true)
    expect(existsSync(path.join(root, "wiki", "index.md"))).toBe(true)
    expect(existsSync(path.join(root, "wiki", "concepts"))).toBe(true)
    expect(existsSync(path.join(root, ".llm-wiki"))).toBe(true)
  })

  it("rejects with 409 CONFLICT when a wiki project already exists there", async () => {
    const root = path.join(DATA_DIR, "occupied-v2-proj")
    mkdirSync(root, { recursive: true })
    // schema.md is the app's canonical "this is a wiki project" marker.
    writeFileSync(path.join(root, "schema.md"), "# existing schema\n")

    const res = await request(app)
      .post("/api/v2/projects")
      .send({ name: "occupied-v2-proj", path: root })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("CONFLICT")
    expect(res.body.error.message).toContain("already exists")
  })

  it("adopts a populated folder that is not yet a wiki project", async () => {
    // A folder with user content but no schema.md may still be registered:
    // the scaffold adds the wiki tree alongside the existing files rather
    // than refusing. (This is the path the api-v2 integration suite relies on.)
    const root = path.join(DATA_DIR, "adopt-v2-proj")
    mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true })
    writeFileSync(path.join(root, "wiki", "concepts", "attention.md"), "# Attention\n")

    const res = await request(app)
      .post("/api/v2/projects")
      .send({ name: "adopt-v2-proj", path: root })

    expect(res.status).toBe(201)
    // Existing content preserved, scaffold added alongside it.
    expect(existsSync(path.join(root, "wiki", "concepts", "attention.md"))).toBe(true)
    expect(existsSync(path.join(root, "schema.md"))).toBe(true)
  })
})
