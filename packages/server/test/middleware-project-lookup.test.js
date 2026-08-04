// Tests for the projectLookup middleware's client-UUID resolution
// (issue #14 P0 stage 9). The web client only knows WikiProject.id (a UUID),
// so every /api/v2/projects/:id route must accept the UUID as well as the
// numeric projects-row id. Resolution mirrors resolveChatProject in
// api/chat.js — numeric first, then projects.uuid, then the app-state
// projectRegistry fallback — but WITHOUT row materialization.
//
// Env vars are set BEFORE the app module is imported (it reads
// LLM_WIKI_DATA_DIR at module load).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-lookup-mw-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

vi.mock("../src/ingest/orchestrator.js", () => ({
  MAX_ATTEMPTS: 3,
  startIngestOrchestrator: vi.fn(),
  stopIngestOrchestrator: vi.fn(),
  kickIngestOrchestrator: vi.fn(),
  cancelIngestTask: vi.fn(async () => true),
  activeIngestTaskCount: () => 0,
  __resetOrchestratorForTests: vi.fn(),
}))

const { app } = await import("../src/index-v2.js")
const { ensureProjectRow } = await import("../src/store/projects.js")

const PROJECT_A_DIR = path.join(DATA_DIR, "proj-a")
const PROJECT_B_DIR = path.join(DATA_DIR, "proj-b")
const UUID_WITH_ROW = "11111111-1111-4111-8111-111111111111"
const UUID_REGISTRY_ONLY = "22222222-2222-4222-8222-222222222222"

let numericA
let numericB

beforeAll(async () => {
  mkdirSync(path.join(PROJECT_A_DIR, "raw", "sources"), { recursive: true })
  mkdirSync(path.join(PROJECT_B_DIR, "raw", "sources"), { recursive: true })

  const resA = await request(app)
    .post("/api/v2/projects")
    .send({ name: "Project A", path: PROJECT_A_DIR })
  numericA = resA.body.project.id

  const resB = await request(app)
    .post("/api/v2/projects")
    .send({ name: "Project B", path: PROJECT_B_DIR })
  numericB = resB.body.project.id

  // Project A: backfill the client UUID onto its row (ensureProjectRow
  // updates the uuid column of the path-matching row).
  ensureProjectRow({ uuid: UUID_WITH_ROW, path: PROJECT_A_DIR })

  // Project B stays uuid-less; the app-state registry maps its client UUID
  // to its filesystem path (the desktop/web registry shape).
  writeFileSync(
    path.join(DATA_DIR, "stores", "app-state.json"),
    JSON.stringify({
      projectRegistry: {
        [UUID_REGISTRY_ONLY]: {
          id: UUID_REGISTRY_ONLY,
          path: PROJECT_B_DIR,
          name: "Project B",
          lastOpened: Date.now(),
        },
      },
    }),
  )
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

const queue = (id) => `/api/v2/projects/${id}/ingest/queue`

describe("projectLookup id resolution", () => {
  it("resolves the numeric projects-row id", async () => {
    const res = await request(app).get(queue(numericA))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tasks: [], count: 0 })
  })

  it("resolves the client UUID via projects.uuid", async () => {
    const res = await request(app).get(queue(UUID_WITH_ROW))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tasks: [], count: 0 })
  })

  it("resolves a UUID with no row uuid via the app-state registry", async () => {
    const res = await request(app).get(queue(UUID_REGISTRY_ONLY))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tasks: [], count: 0 })
  })

  it("never materializes rows: a registry UUID with no row at all 404s", async () => {
    const res = await request(app).get(queue("33333333-3333-4333-8333-333333333333"))
    expect(res.status).toBe(404)
  })

  it("404s for an unknown id", async () => {
    const res = await request(app).get(queue(999999))
    expect(res.status).toBe(404)
  })

  it("404s for a non-identity string", async () => {
    const res = await request(app).get(queue("not-a-project"))
    expect(res.status).toBe(404)
  })

  it("UUID resolution works for mutations too (enqueue-by-path)", async () => {
    writeFileSync(path.join(PROJECT_A_DIR, "raw", "sources", "note.md"), "# note\n")
    const res = await request(app)
      .post(`/api/v2/projects/${UUID_WITH_ROW}/ingest`)
      .send({ filePath: "raw/sources/note.md" })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe("pending")
    expect(typeof res.body.taskId).toBe("number")
  })
})
