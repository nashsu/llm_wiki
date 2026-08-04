// Integration tests for the ingest API surface (issue #14 P0 stage 8):
// upload filename-suffix shape, enqueue-by-path (dedupe + traversal guards),
// manual retry (409 on non-failed), DELETE cancel via the orchestrator, and
// orchestrator kick wiring on every mutation. Runs against the real app with
// the orchestrator module mocked so no pipeline ever starts.
//
// Env vars are set BEFORE the app module is imported (it reads
// LLM_WIKI_DATA_DIR at module load).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-ingest-api-"))
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
const orch = await import("../src/ingest/orchestrator.js")
const q = await import("../src/store/ingest-queue.js")
const { eventBus } = await import("../src/events/bus.js")

const PROJECT_DIR = path.join(DATA_DIR, "proj")
let projectId

beforeAll(async () => {
  mkdirSync(path.join(PROJECT_DIR, "raw", "sources"), { recursive: true })
  mkdirSync(path.join(PROJECT_DIR, "wiki", "concepts"), { recursive: true })
  const res = await request(app)
    .post("/api/v2/projects")
    .send({ name: "Ingest API Project", path: PROJECT_DIR })
  projectId = res.body.project.id
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  vi.mocked(orch.kickIngestOrchestrator).mockClear()
  vi.mocked(orch.cancelIngestTask).mockClear()
  vi.mocked(orch.cancelIngestTask).mockResolvedValue(true)
})

const ingest = (suffix = "") => `/api/v2/projects/${projectId}/ingest${suffix}`

describe("POST /upload", () => {
  it("writes the file with a timestamp + 8-hex random suffix and kicks the orchestrator", async () => {
    const res = await request(app)
      .post(ingest("/upload"))
      .attach("file", Buffer.from("paper body"), "paper.txt")
    expect(res.status).toBe(201)
    expect(res.body.taskId).toBeGreaterThan(0)
    expect(res.body.status).toBe("pending")

    const base = path.basename(res.body.filePath)
    expect(base).toMatch(/^\d+_[0-9a-f]{8}_.+$/)
    expect(base.endsWith("_paper.txt")).toBe(true)
    expect(existsSync(res.body.filePath)).toBe(true)
    expect(orch.kickIngestOrchestrator).toHaveBeenCalledTimes(1)
  })

  it("same-millisecond uploads of the same name do not collide", async () => {
    const [r1, r2] = await Promise.all([
      request(app).post(ingest("/upload")).attach("file", Buffer.from("one"), "dup.txt"),
      request(app).post(ingest("/upload")).attach("file", Buffer.from("two"), "dup.txt"),
    ])
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r1.body.filePath).not.toBe(r2.body.filePath)
    expect(existsSync(r1.body.filePath)).toBe(true)
    expect(existsSync(r2.body.filePath)).toBe(true)
  })
})

describe("POST / (enqueue by path)", () => {
  const rel = "raw/sources/existing.md"
  beforeAll(() => {
    writeFileSync(path.join(PROJECT_DIR, rel), "# Existing source\n")
  })

  it("enqueues an existing file, emits ingest:queued, and kicks", async () => {
    const queued = []
    const unsub = eventBus.subscribe((env) => {
      if (env.type === "ingest:queued") queued.push(env)
    })
    try {
      const res = await request(app).post(ingest()).send({ filePath: rel })
      expect(res.status).toBe(201)
      expect(res.body.taskId).toBeGreaterThan(0)
      expect(res.body.status).toBe("pending")
      expect(res.body.filePath).toBe(path.join(PROJECT_DIR, rel))
      expect(orch.kickIngestOrchestrator).toHaveBeenCalledTimes(1)

      expect(queued.length).toBe(1)
      expect(queued[0].payload).toMatchObject({
        projectId,
        taskId: res.body.taskId,
        fileName: "existing.md",
      })
    } finally {
      unsub()
    }
  })

  it("dedupes against a live task for the same path (200 + deduplicated)", async () => {
    q.clearIngestTasks(projectId) // start clean so the first enqueue creates a row
    const first = await request(app).post(ingest()).send({ filePath: rel })
    expect(first.status).toBe(201)
    const second = await request(app).post(ingest()).send({ filePath: rel })
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ taskId: first.body.taskId, deduplicated: true })
  })

  it("passes folderContext through to the queue row", async () => {
    q.clearIngestTasks(projectId) // no live task for rel → deterministic enqueue
    const res = await request(app)
      .post(ingest())
      .send({ filePath: rel, folderContext: "raw/sources" })
    expect(res.status).toBe(201)
    const row = q.getIngestTask(res.body.taskId)
    expect(row.folder_context).toBe("raw/sources")
  })

  it("rejects path traversal escaping the project root", async () => {
    const res = await request(app).post(ingest()).send({ filePath: "../outside.md" })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("FORBIDDEN")
    expect(orch.kickIngestOrchestrator).not.toHaveBeenCalled()
  })

  it("rejects a missing file with NOT_FOUND", async () => {
    const res = await request(app).post(ingest()).send({ filePath: "raw/sources/missing.md" })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })

  it("rejects a directory with VALIDATION_ERROR", async () => {
    const res = await request(app).post(ingest()).send({ filePath: "raw/sources" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("rejects an invalid body with VALIDATION_ERROR", async () => {
    const res = await request(app).post(ingest()).send({ folderContext: "x" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})

describe("POST /queue/:taskId/retry", () => {
  it("409 VALIDATION_ERROR when the task is not failed", async () => {
    const enq = await request(app).post(ingest("/upload")).attach("file", Buffer.from("x"), "r1.txt")
    const taskId = enq.body.taskId
    vi.mocked(orch.kickIngestOrchestrator).mockClear() // setup upload kicked once
    const res = await request(app).post(ingest(`/queue/${taskId}/retry`))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
    expect(res.body.error.message).toBe("Task is not failed")
    expect(orch.kickIngestOrchestrator).not.toHaveBeenCalled()
  })

  it("retries a failed task, resets it to pending, and kicks", async () => {
    const enq = await request(app).post(ingest("/upload")).attach("file", Buffer.from("y"), "r2.txt")
    const taskId = enq.body.taskId
    q.failIngestTask(taskId, "boom", { retryable: false })
    vi.mocked(orch.kickIngestOrchestrator).mockClear() // setup upload kicked once

    const res = await request(app).post(ingest(`/queue/${taskId}/retry`))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const row = q.getIngestTask(taskId)
    expect(row.status).toBe("pending")
    expect(row.attempt_count).toBe(0)
    expect(row.error).toBeNull()
    expect(orch.kickIngestOrchestrator).toHaveBeenCalledTimes(1)
  })

  it("404 for a missing task", async () => {
    const res = await request(app).post(ingest("/queue/999999/retry"))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })
})

describe("DELETE /queue/:taskId (cancel)", () => {
  it("delegates to the orchestrator cancel and returns 204", async () => {
    const enq = await request(app).post(ingest("/upload")).attach("file", Buffer.from("z"), "c1.txt")
    const taskId = enq.body.taskId

    const res = await request(app).delete(ingest(`/queue/${taskId}`))
    expect(res.status).toBe(204)
    expect(orch.cancelIngestTask).toHaveBeenCalledTimes(1)
    expect(orch.cancelIngestTask).toHaveBeenCalledWith(taskId)
  })

  it("returns 404 when the task does not exist (project check first)", async () => {
    const res = await request(app).delete(ingest("/queue/999999"))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
    expect(orch.cancelIngestTask).not.toHaveBeenCalled()
  })

  it("returns 404 when cancel reports the task is gone", async () => {
    const enq = await request(app).post(ingest("/upload")).attach("file", Buffer.from("w"), "c2.txt")
    const taskId = enq.body.taskId
    vi.mocked(orch.cancelIngestTask).mockResolvedValueOnce(false)

    const res = await request(app).delete(ingest(`/queue/${taskId}`))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })
})

describe("queue routes do not collide", () => {
  it("POST /queue/clear still works alongside /queue/:taskId/retry", async () => {
    await request(app).post(ingest("/upload")).attach("file", Buffer.from("q"), "q1.txt")
    const res = await request(app).post(ingest("/queue/clear")).send({})
    expect(res.status).toBe(200)
    expect(res.body.cleared).toBeGreaterThanOrEqual(1)
    const list = await request(app).get(ingest("/queue"))
    expect(list.body.count).toBe(0)
  })
})
