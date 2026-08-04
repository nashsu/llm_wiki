// Tests for ingest progress reporting (issue #14 P0): the stage→percent map
// is pinned (client renders these labels/numbers), persistence lands in the
// queue row, and SSE frames match the plan's contract via the event bus.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-prog-test-"))
process.env.LLM_WIKI_NO_SHARE = "1"

const { getDb } = await import("../src/store/db.js")
const { createProject, deleteProject } = await import("../src/store/projects.js")
const q = await import("../src/store/ingest-queue.js")
const { eventBus } = await import("../src/events/bus.js")
const { INGEST_STAGES, stagePercent, reportIngestProgress, emitIngestComplete, emitIngestError } = await import("../src/ingest/progress.js")

getDb()

let proj
beforeAll(() => { proj = createProject({ name: "P", path: "/tmp/prog-p" }) })
afterAll(() => {
  deleteProject(proj.id)
  rmSync(process.env.LLM_WIKI_DATA_DIR, { recursive: true, force: true })
})

function claimFresh(file) {
  const id = Number(q.enqueueIngestTask(proj.id, file))
  return q.claimNextIngestTask(Date.now())
}

describe("stage map", () => {
  it("pins the exact stage order and percents", () => {
    expect(INGEST_STAGES.map(([s]) => s)).toEqual([
      "preprocess", "mineru", "context", "cache-check", "images", "caption",
      "analysis", "generation", "review-stage", "write", "index-log",
      "reviews", "cache-save", "embed",
    ])
    expect(INGEST_STAGES.map(([, p]) => p)).toEqual([
      5, 15, 20, 25, 30, 40, 55, 75, 80, 85, 90, 92, 95, 98,
    ])
  })

  it("is strictly monotonic and stays below 100 (100 is complete-only)", () => {
    const percents = INGEST_STAGES.map(([, p]) => p)
    for (let i = 1; i < percents.length; i++) expect(percents[i]).toBeGreaterThan(percents[i - 1])
    expect(percents[percents.length - 1]).toBeLessThan(100)
  })

  it("returns 0 for unknown stages instead of throwing", () => {
    expect(stagePercent("nope")).toBe(0)
  })
})

describe("reportIngestProgress", () => {
  it("persists progress to the row and broadcasts the contract frame", () => {
    const task = claimFresh("raw/sources/prog1.md")
    const seen = []
    const unsub = eventBus.subscribe((env) => seen.push(env))
    try {
      reportIngestProgress(task, { stage: "generation", detail: "writing pages" })
    } finally {
      unsub()
    }
    expect(q.getIngestTask(task.id).progress).toBe(75)
    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe("ingest:progress")
    expect(seen[0].payload).toMatchObject({
      projectId: proj.id,
      taskId: task.id,
      status: "processing",
      progress: 75,
      stage: "generation",
      detail: "writing pages",
      attempt: 1,
    })
    q.completeIngestTask(task.id)
  })
})

describe("terminal frames", () => {
  it("emitIngestComplete carries pages/reviews/warnings/duration", () => {
    const task = claimFresh("raw/sources/prog2.md")
    const seen = []
    const unsub = eventBus.subscribe((env) => seen.push(env))
    try {
      emitIngestComplete(task, { pagesCreated: ["wiki/concepts/x.md"], reviewCount: 2, warnings: ["w"], durationMs: 1234 })
    } finally {
      unsub()
    }
    expect(seen[0].payload).toMatchObject({
      projectId: proj.id, taskId: task.id, status: "completed", progress: 100,
      pagesCreated: ["wiki/concepts/x.md"], reviewCount: 2, warnings: ["w"], durationMs: 1234,
    })
    q.completeIngestTask(task.id)
  })

  it("emitIngestError marks retryable failures pending with retryAt", () => {
    const task = claimFresh("raw/sources/prog3.md")
    const seen = []
    const unsub = eventBus.subscribe((env) => seen.push(env))
    try {
      emitIngestError(task, { error: "429 usage limit", retryable: true, retryAt: 999 })
      emitIngestError(task, { error: "fatal" })
    } finally {
      unsub()
    }
    const [retryable, terminal] = seen.map((e) => e.payload)
    expect(retryable).toMatchObject({ status: "pending", retryable: true, retryAt: 999, attempt: 1, maxAttempts: 3 })
    expect(terminal).toMatchObject({ status: "failed", retryable: false, error: "fatal" })
    q.completeIngestTask(task.id)
  })
})
