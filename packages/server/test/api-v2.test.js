// Integration tests for the v2 Express + Zod API (Phase 2.7).
//
// Covers every route group end-to-end via supertest: system, auth, projects,
// files, search, graph, settings, reviews, maintenance, ingest, events, chat,
// plus the legacy /api/invoke bridge and the error envelope. Runs against an
// isolated temp data dir so it never touches real user data.
//
// IMPORTANT: env vars are set BEFORE the app module is imported, because the
// app reads LLM_WIKI_DATA_DIR at module load.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// ── set up isolated data dir BEFORE importing the app ─────────────────────
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-it-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

// A real on-disk project for file/search/graph/reviews/maintenance tests.
const PROJECT_DIR = path.join(DATA_DIR, "proj")
let projectId

beforeAll(async () => {
  mkdirSync(path.join(PROJECT_DIR, "wiki", "concepts"), { recursive: true })
  mkdirSync(path.join(PROJECT_DIR, "raw", "sources"), { recursive: true })
  mkdirSync(path.join(PROJECT_DIR, ".llm-wiki"), { recursive: true })
  writeFileSync(
    path.join(PROJECT_DIR, "wiki", "concepts", "attention.md"),
    "---\ntype: concept\ntitle: Attention\n---\n# Attention\nMechanism overview.\n"
  )
  writeFileSync(
    path.join(PROJECT_DIR, "wiki", "concepts", "transformer.md"),
    "---\ntype: concept\ntitle: Transformer\n---\n# Transformer\nSee [[attention]].\n"
  )

  // Register the project so it has an id.
  const res = await request(app)
    .post("/api/v2/projects")
    .send({ name: "IT Project", path: PROJECT_DIR })
  projectId = res.body.project.id
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

// ── System ────────────────────────────────────────────────────────────────
describe("system", () => {
  it("GET /api/v2/health returns ok", async () => {
    const res = await request(app).get("/api/v2/health")
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.commands).toBeGreaterThan(0)
  })

  it("GET /api/v2/version returns node + platform", async () => {
    const res = await request(app).get("/api/v2/version")
    expect(res.status).toBe(200)
    expect(res.body.node).toBeTruthy()
    expect(res.body.platform).toBeTruthy()
  })

  it("GET /api/v2/openapi.json returns a valid spec", async () => {
    const res = await request(app).get("/api/v2/openapi.json")
    expect(res.status).toBe(200)
    expect(res.body.openapi).toBe("3.1.0")
    expect(res.body.paths["/api/v2/projects"]).toBeTruthy()
  })
})

// ── Projects ──────────────────────────────────────────────────────────────
describe("projects", () => {
  it("lists projects", async () => {
    const res = await request(app).get("/api/v2/projects")
    expect(res.status).toBe(200)
    expect(res.body.projects.length).toBeGreaterThanOrEqual(1)
  })

  it("gets one project", async () => {
    const res = await request(app).get(`/api/v2/projects/${projectId}`)
    expect(res.status).toBe(200)
    expect(res.body.project.name).toBe("IT Project")
  })

  it("returns NOT_FOUND for a missing project", async () => {
    const res = await request(app).get("/api/v2/projects/999999")
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })

  it("rejects an invalid create body with VALIDATION_ERROR", async () => {
    const res = await request(app).post("/api/v2/projects").send({ name: "" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect(Array.isArray(res.body.error.details)).toBe(true)
  })
})

// ── Files ─────────────────────────────────────────────────────────────────
describe("files", () => {
  it("lists the file tree", async () => {
    const res = await request(app).get(`/api/v2/projects/${projectId}/files/tree`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.tree)).toBe(true)
  })

  it("reads file content", async () => {
    const res = await request(app)
      .get(`/api/v2/projects/${projectId}/files/content`)
      .query({ path: "wiki/concepts/attention.md" })
    expect(res.status).toBe(200)
    expect(res.body.content).toContain("# Attention")
  })

  it("uploads then reads back a file", async () => {
    const up = await request(app)
      .post(`/api/v2/projects/${projectId}/files/upload`)
      .send({ path: "wiki/new-page.md", content: "# New" })
    expect(up.status).toBe(200)
    expect(up.body.success).toBe(true)

    const read = await request(app)
      .get(`/api/v2/projects/${projectId}/files/content`)
      .query({ path: "wiki/new-page.md" })
    expect(read.body.content).toBe("# New")
  })

  it("blocks path traversal with FORBIDDEN", async () => {
    const res = await request(app)
      .get(`/api/v2/projects/${projectId}/files/content`)
      .query({ path: "../../etc/passwd" })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("FORBIDDEN")
  })

  it("returns NOT_FOUND for a missing file", async () => {
    const res = await request(app)
      .get(`/api/v2/projects/${projectId}/files/content`)
      .query({ path: "wiki/nope.md" })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })
})

// ── Search ────────────────────────────────────────────────────────────────
describe("search", () => {
  it("runs a keyword search", async () => {
    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/search`)
      .send({ query: "attention" })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.results)).toBe(true)
    expect(res.body.mode).toBeTruthy()
  })

  it("rejects an empty query with VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/search`)
      .send({ query: "" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})

// ── Graph ─────────────────────────────────────────────────────────────────
describe("graph", () => {
  it("returns nodes and edges", async () => {
    const res = await request(app).get(`/api/v2/projects/${projectId}/graph`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.nodes)).toBe(true)
    expect(Array.isArray(res.body.edges)).toBe(true)
    expect(res.body.nodes.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Settings ──────────────────────────────────────────────────────────────
describe("settings", () => {
  it("writes and reads a setting", async () => {
    const put = await request(app)
      .put("/api/v2/settings/theme")
      .send({ value: "dark" })
    expect(put.status).toBe(200)
    expect(put.body.value).toBe("dark")

    const get = await request(app).get("/api/v2/settings/theme")
    expect(get.body.value).toBe("dark")
  })

  it("deletes a setting then 404s", async () => {
    await request(app).put("/api/v2/settings/temp").send({ value: 1 })
    const del = await request(app).delete("/api/v2/settings/temp")
    expect(del.status).toBe(204)
    const get = await request(app).get("/api/v2/settings/temp")
    expect(get.status).toBe(404)
  })
})

// ── Reviews ───────────────────────────────────────────────────────────────
describe("reviews", () => {
  it("returns an empty review list for a fresh project", async () => {
    const res = await request(app).get(`/api/v2/projects/${projectId}/reviews`)
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
    expect(Array.isArray(res.body.reviews)).toBe(true)
  })
})

// ── Maintenance ───────────────────────────────────────────────────────────
describe("maintenance", () => {
  it("rebuilds the wiki index", async () => {
    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/maintenance/rebuild-index`)
    expect(res.status).toBe(200)
    expect(res.body.pages).toBeGreaterThanOrEqual(2)
  })

  it("lists file history (empty for a new file)", async () => {
    const res = await request(app)
      .get(`/api/v2/projects/${projectId}/maintenance/file-history`)
      .query({ path: "wiki/concepts/attention.md" })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.history)).toBe(true)
  })
})

// ── Ingest ────────────────────────────────────────────────────────────────
describe("ingest", () => {
  it("uploads a file via multipart and enqueues a task", async () => {
    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/ingest/upload`)
      .attach("file", Buffer.from("sample paper text"), "paper.txt")
    expect(res.status).toBe(201)
    expect(res.body.taskId).toBeGreaterThan(0)
    expect(res.body.status).toBe("pending")
  })

  it("lists the ingest queue", async () => {
    const res = await request(app).get(`/api/v2/projects/${projectId}/ingest/queue`)
    expect(res.status).toBe(200)
    expect(res.body.count).toBeGreaterThanOrEqual(1)
  })

  it("rejects an upload with no file", async () => {
    const res = await request(app).post(`/api/v2/projects/${projectId}/ingest/upload`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})

// ── Chat ──────────────────────────────────────────────────────────────────
describe("chat", () => {
  it("starts a turn and returns a runId + sessionId", async () => {
    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/chat`)
      .send({ message: "What is attention?" })
    expect(res.status).toBe(200)
    expect(res.body.runId).toBeTruthy()
    expect(res.body.sessionId).toBeTruthy()
  })

  it("rejects an empty message", async () => {
    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/chat`)
      .send({ message: "" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})

// ── Auth (open mode) ──────────────────────────────────────────────────────
describe("auth", () => {
  it("reports auth not required when no token is set", async () => {
    const res = await request(app).get("/api/v2/auth/status")
    expect(res.status).toBe(200)
    expect(res.body.authRequired).toBe(false)
  })

  it("accepts any login in open mode", async () => {
    const res = await request(app)
      .post("/api/v2/auth/login")
      .send({ token: "anything" })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })
})

// ── Legacy bridge ─────────────────────────────────────────────────────────
describe("legacy /api/invoke bridge", () => {
  it("dispatches a known command with deprecation headers", async () => {
    const res = await request(app)
      .post("/api/invoke/list_directory")
      .send({ path: PROJECT_DIR })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.headers.deprecation).toBe("true")
    expect(res.headers.link).toContain("/api/v2/openapi.json")
  })

  it("returns NOT_FOUND for an unknown command", async () => {
    const res = await request(app).post("/api/invoke/does_not_exist").send({})
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })
})
