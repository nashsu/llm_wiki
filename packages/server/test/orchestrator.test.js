// Tests for the ingest queue consumer (orchestrator) — issue #14 P0 stage 8.
//
// The pipeline is mocked (scripted results/throws/abort-aware gates) while
// the queue store runs against the REAL SQLite database, so claim/FIFO/
// per-project serialization semantics are exercised for real. SSE frames are
// observed on the internal event bus (emit() republishes there).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-orch-test-"))
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_INGEST_CONCURRENCY = "2"

vi.mock("../src/ingest/pipeline.js", () => ({
  runIngestPipeline: vi.fn(),
}))

vi.mock("../src/ingest/embed.js", () => ({
  removePageEmbedding: vi.fn(async () => {}),
}))

const { getDb } = await import("../src/store/db.js")
const { createProject, deleteProject } = await import("../src/store/projects.js")
const q = await import("../src/store/ingest-queue.js")
const { writeStore } = await import("../src/store.js")
const { SHARED_STORE_NAME } = await import("../src/config.js")
const { eventBus } = await import("../src/events/bus.js")
const { runIngestPipeline } = await import("../src/ingest/pipeline.js")
const { removePageEmbedding } = await import("../src/ingest/embed.js")
const orch = await import("../src/ingest/orchestrator.js")

getDb() // run migrations before any queue access

const DATA_DIR = process.env.LLM_WIKI_DATA_DIR
let projA, projB

function successResult(writtenPaths = ["wiki/concepts/page.md"]) {
  return { writtenPaths, reviewCount: 1, warnings: [], cached: false, durationMs: 42 }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(cond, timeoutMs = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

let frames = []
let unsubscribe = null

beforeAll(() => {
  const dirA = path.join(DATA_DIR, "proj-a")
  const dirB = path.join(DATA_DIR, "proj-b")
  mkdirSync(path.join(dirA, "raw", "sources"), { recursive: true })
  mkdirSync(path.join(dirB, "raw", "sources"), { recursive: true })
  projA = createProject({ name: "A", path: dirA })
  projB = createProject({ name: "B", path: dirB })
})

afterAll(() => {
  deleteProject(projA.id)
  deleteProject(projB.id)
  rmSync(DATA_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  // Default: LLM configured (overridden by the not-configured test).
  writeStore(SHARED_STORE_NAME, {
    llmConfig: { provider: "openai", apiKey: "sk-test-123", model: "gpt-test" },
  })
  frames = []
  unsubscribe = eventBus.subscribe((env) => frames.push(env))
})

afterEach(() => {
  orch.stopIngestOrchestrator()
  orch.__resetOrchestratorForTests()
  unsubscribe?.()
  unsubscribe = null
  getDb().prepare("DELETE FROM ingest_queue").run()
  vi.mocked(runIngestPipeline).mockReset()
  vi.mocked(removePageEmbedding).mockClear()
})

function enq(projectId, file) {
  return Number(q.enqueueIngestTask(projectId, file))
}

function framesOf(type, taskId) {
  return frames.filter((f) => f.type === type && f.payload?.taskId === taskId)
}

describe("concurrency cap + per-project serialization", () => {
  it("runs at most one task per project but fills the cap across projects", async () => {
    const gates = new Map()
    const started = []
    const inFlight = new Set()
    const violations = []
    vi.mocked(runIngestPipeline).mockImplementation((task) => {
      const key = `${task.project_id}:${task.file_path}`
      for (const other of inFlight) {
        if (other.startsWith(`${task.project_id}:`)) violations.push(key)
      }
      inFlight.add(key)
      started.push(task.file_path)
      const gate = deferred()
      gates.set(task.file_path, gate)
      return gate.promise.finally(() => inFlight.delete(key))
    })

    // 4 tasks in project A, 2 in project B (ids ascending in this order).
    enq(projA.id, "raw/sources/a1.md")
    enq(projA.id, "raw/sources/a2.md")
    enq(projA.id, "raw/sources/a3.md")
    enq(projA.id, "raw/sources/a4.md")
    enq(projB.id, "raw/sources/b1.md")
    enq(projB.id, "raw/sources/b2.md")

    orch.startIngestOrchestrator()
    await waitFor(() => started.length === 2)
    // Cap 2: the two claims are a1 (oldest) and b1 — never two of project A.
    expect(started).toEqual(["raw/sources/a1.md", "raw/sources/b1.md"])
    expect(orch.activeIngestTaskCount()).toBe(2)

    // Completing a1 frees project A → a2 chains in (b2 waits for a slot).
    gates.get("raw/sources/a1.md").resolve(successResult())
    await waitFor(() => started.length === 3)
    expect(started[2]).toBe("raw/sources/a2.md")
    expect(orch.activeIngestTaskCount()).toBe(2)

    gates.get("raw/sources/b1.md").resolve(successResult())
    await waitFor(() => started.length === 4)
    // a3/a4 are still blocked behind a2 (same project) → b2 takes the slot.
    expect(started[3]).toBe("raw/sources/b2.md")
    expect(orch.activeIngestTaskCount()).toBe(2)

    gates.get("raw/sources/a2.md").resolve(successResult())
    await waitFor(() => started.length === 5)
    expect(started[4]).toBe("raw/sources/a3.md")

    gates.get("raw/sources/a3.md").resolve(successResult())
    await waitFor(() => started.length === 6)
    expect(started[5]).toBe("raw/sources/a4.md")

    gates.get("raw/sources/a4.md").resolve(successResult())
    gates.get("raw/sources/b2.md").resolve(successResult())
    await waitFor(() => orch.activeIngestTaskCount() === 0)

    expect(violations).toEqual([]) // per-project serialization never broken
    expect(runIngestPipeline).toHaveBeenCalledTimes(6)
  })
})

describe("success path", () => {
  it("completes the row, emits ingest:progress + ingest:complete with pagesCreated", async () => {
    vi.mocked(runIngestPipeline).mockImplementation(async (task, env) => {
      env.onProgress("analysis", "Thinking...")
      env.onFileWritten("wiki/concepts/x.md")
      return successResult(["wiki/concepts/x.md"])
    })
    const id = enq(projA.id, "raw/sources/ok.md")

    orch.startIngestOrchestrator()
    await waitFor(() => q.getIngestTask(id)?.status === "completed")

    const row = q.getIngestTask(id)
    expect(row.progress).toBe(100)
    expect(row.error).toBeNull()

    // Pipeline env wiring: fresh store config + project path + signal + hooks.
    const [taskArg, envArg] = vi.mocked(runIngestPipeline).mock.calls[0]
    expect(taskArg.id).toBe(id)
    expect(envArg.projectPath).toBe(projA.path)
    expect(envArg.llmConfig.apiKey).toBe("sk-test-123")
    expect(envArg.signal).toBeInstanceOf(AbortSignal)
    expect(typeof envArg.onProgress).toBe("function")
    expect(typeof envArg.onFileWritten).toBe("function")

    const progress = framesOf("ingest:progress", id)
    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[0].payload).toMatchObject({
      projectId: projA.id,
      taskId: id,
      status: "processing",
      progress: 55,
      stage: "analysis",
      detail: "Thinking...",
    })

    const complete = framesOf("ingest:complete", id)
    expect(complete.length).toBe(1)
    expect(complete[0].payload).toMatchObject({
      projectId: projA.id,
      taskId: id,
      status: "completed",
      progress: 100,
      pagesCreated: ["wiki/concepts/x.md"],
      reviewCount: 1,
      warnings: [],
      durationMs: 42,
    })
  })
})

describe("failure + retry semantics", () => {
  it("retries retryable failures and goes terminal failed at attempt 3", async () => {
    vi.mocked(runIngestPipeline).mockRejectedValue(new Error("boom"))
    const id = enq(projA.id, "raw/sources/flaky.md")

    orch.startIngestOrchestrator()
    await waitFor(() => q.getIngestTask(id)?.status === "failed")

    const row = q.getIngestTask(id)
    expect(row.error).toBe("boom")
    expect(row.attempt_count).toBe(3)
    expect(runIngestPipeline).toHaveBeenCalledTimes(3)

    const errors = framesOf("ingest:error", id)
    expect(errors.length).toBe(3)
    expect(errors.filter((f) => f.payload.retryable).length).toBe(2)
    expect(errors[0].payload.status).toBe("pending")
    expect(errors[2].payload.status).toBe("failed")
    expect(errors[2].payload.retryable).toBe(false)
    expect(errors[2].payload.error).toBe("boom")
    expect(errors[2].payload.maxAttempts).toBe(3)
  })

  it("usage-limit errors pause ~15min without consuming the attempt", async () => {
    vi.mocked(runIngestPipeline).mockRejectedValue(new Error("HTTP 429: Too Many Requests"))
    const id = enq(projA.id, "raw/sources/limited.md")
    const before = Date.now()

    orch.startIngestOrchestrator()
    await waitFor(() => (q.getIngestTask(id)?.not_before ?? 0) > 0)

    const row = q.getIngestTask(id)
    expect(row.status).toBe("pending")
    expect(row.attempt_count).toBe(0) // claim increment rolled back
    expect(row.error).toBe("Paused after provider usage limit: HTTP 429: Too Many Requests")
    expect(row.not_before).toBeGreaterThanOrEqual(before + 15 * 60 * 1000)
    expect(row.not_before).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 5000)
    expect(runIngestPipeline).toHaveBeenCalledTimes(1) // no immediate retry storm

    const error = framesOf("ingest:error", id)
    expect(error.length).toBe(1)
    expect(error[0].payload).toMatchObject({
      status: "pending",
      retryable: true,
      retryAt: row.not_before,
      maxAttempts: 3,
    })
  })

  it("treats err.usageLimit === true as a usage limit too (IngestLlmError)", async () => {
    const err = Object.assign(new Error("provider busy"), { usageLimit: true })
    vi.mocked(runIngestPipeline).mockRejectedValue(err)
    const id = enq(projA.id, "raw/sources/limited-flag.md")

    orch.startIngestOrchestrator()
    await waitFor(() => (q.getIngestTask(id)?.not_before ?? 0) > 0)

    const row = q.getIngestTask(id)
    expect(row.status).toBe("pending")
    expect(row.attempt_count).toBe(0)
    expect(row.error).toBe("Paused after provider usage limit: provider busy")
  })

  it("fails terminally with the exact client message when no LLM is configured", async () => {
    writeStore(SHARED_STORE_NAME, { llmConfig: { provider: "openai", apiKey: "" } })
    vi.mocked(runIngestPipeline).mockResolvedValue(successResult())
    const id = enq(projA.id, "raw/sources/nokey.md")

    orch.startIngestOrchestrator()
    await waitFor(() => q.getIngestTask(id)?.status === "failed")

    const row = q.getIngestTask(id)
    expect(row.error).toBe("LLM not configured — set API key in Settings")
    expect(runIngestPipeline).not.toHaveBeenCalled()

    const error = framesOf("ingest:error", id)
    expect(error.length).toBe(1)
    expect(error[0].payload.retryable).toBe(false)
    expect(error[0].payload.status).toBe("failed")
    expect(error[0].payload.error).toBe("LLM not configured — set API key in Settings")
  })

  it("fails terminally for CLI-only providers (claude-code/codex-cli) without invoking the pipeline", async () => {
    // These providers are "usable" per hasUsableLlmConfig (no key needed) but
    // have no server transport - they must fail fast AT CLAIM rather than burn
    // all three attempts inside streamChat (plan §"claude-code/codex-cli").
    writeStore(SHARED_STORE_NAME, { llmConfig: { provider: "claude-code" } })
    vi.mocked(runIngestPipeline).mockResolvedValue(successResult())
    const id = enq(projA.id, "raw/sources/cli-provider.md")

    orch.startIngestOrchestrator()
    await waitFor(() => q.getIngestTask(id)?.status === "failed")

    const row = q.getIngestTask(id)
    expect(row.error).toBe("Ingest with this provider requires the desktop CLI")
    expect(row.attempt_count).toBe(1) // terminal on the first claim, no retries
    expect(runIngestPipeline).not.toHaveBeenCalled()

    const error = framesOf("ingest:error", id)
    expect(error.length).toBe(1)
    expect(error[0].payload).toMatchObject({
      retryable: false,
      status: "failed",
      maxAttempts: 3,
      error: "Ingest with this provider requires the desktop CLI",
    })
  })
})

describe("cancellation", () => {
  it("cancel mid-flight aborts the pipeline, deletes the row, removes written files + embeddings", async () => {
    const rel = "wiki/concepts/cancel-me.md"
    const full = path.join(projA.path, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, "---\ntitle: Cancel Me\n---\n# Cancel Me\n")
    // Structural pages pre-exist this ingest; the pipeline only UPDATED them.
    // Cleanup must skip them (desktop isStructuralWikiPath parity).
    const indexPath = path.join(projA.path, "wiki", "index.md")
    const logPath = path.join(projA.path, "wiki", "log.md")
    writeFileSync(indexPath, "# Index (pre-existing)\n")
    writeFileSync(logPath, "# Log (pre-existing)\n")

    let capturedEnv = null
    vi.mocked(runIngestPipeline).mockImplementation((task, env) => {
      capturedEnv = env
      env.onFileWritten(rel)
      env.onFileWritten("wiki/index.md")
      env.onFileWritten("wiki/log.md")
      return new Promise((resolve, reject) => {
        env.signal.addEventListener("abort", () => reject(new Error("Ingest cancelled")), { once: true })
      })
    })
    const id = enq(projA.id, "raw/sources/cancel-source.md")

    orch.startIngestOrchestrator()
    await waitFor(() => capturedEnv !== null && orch.activeIngestTaskCount() === 1)

    const ok = await orch.cancelIngestTask(id)
    expect(ok).toBe(true)
    expect(q.getIngestTask(id)).toBeUndefined()
    expect(capturedEnv.signal.aborted).toBe(true)

    // Cleanup: written page removed from disk + its embeddings dropped;
    // structural pages (index/log) survive.
    await waitFor(() => orch.activeIngestTaskCount() === 0)
    expect(existsSync(full)).toBe(false)
    expect(existsSync(indexPath)).toBe(true)
    expect(existsSync(logPath)).toBe(true)
    expect(removePageEmbedding).toHaveBeenCalledTimes(1)
    expect(removePageEmbedding).toHaveBeenCalledWith(projA.path, "cancel-me")

    // Taxonomy stage 2 (plans/sse-taxonomy.md): cleanup emits file:deleted
    // per SUCCESSFUL unlink — exactly one frame here (structural index/log
    // are skipped), project-relative path, row's project_id as payload
    // attribution (emit() bridge keeps the envelope projectId null).
    const deleted = frames.filter((f) => f.type === "file:deleted")
    expect(deleted).toHaveLength(1)
    expect(deleted[0].projectId).toBeNull()
    expect(deleted[0].payload).toEqual({ projectId: projA.id, path: rel })

    // Terminal frame so live clients update.
    const error = framesOf("ingest:error", id)
    const cancelFrame = error.find((f) => f.payload.error === "Cancelled")
    expect(cancelFrame).toBeTruthy()
    expect(cancelFrame.payload).toMatchObject({
      projectId: projA.id,
      taskId: id,
      status: "failed",
      retryable: false,
    })
  })

  it("cancel cleanup emits file:deleted only for SUCCESSFUL unlinks", async () => {
    // The pipeline claims it wrote a page that never reached disk (abort
    // raced the write): unlink fails ⇒ NO file:deleted frame, and the
    // cleanup still swallows the error (cancel must never throw).
    vi.mocked(runIngestPipeline).mockImplementation((task, env) => {
      env.onFileWritten("wiki/concepts/never-written.md")
      return new Promise((resolve, reject) => {
        env.signal.addEventListener("abort", () => reject(new Error("Ingest cancelled")), { once: true })
      })
    })
    const id = enq(projA.id, "raw/sources/ghost-source.md")

    orch.startIngestOrchestrator()
    await waitFor(() => orch.activeIngestTaskCount() === 1)

    const ok = await orch.cancelIngestTask(id)
    expect(ok).toBe(true)
    await waitFor(() => orch.activeIngestTaskCount() === 0)
    expect(frames.filter((f) => f.type === "file:deleted")).toHaveLength(0)
    // Nothing was actually unlinked ⇒ no graph:updated aggregate either
    // (plans/sse-taxonomy.md stage 4).
    expect(frames.filter((f) => f.type === "graph:updated")).toHaveLength(0)
  })

  it("cancel of a pending row just deletes it", async () => {
    const id = enq(projA.id, "raw/sources/pending-cancel.md")
    q.failIngestTask(id, "wait", { retryable: true, notBefore: Date.now() + 60_000 })

    orch.startIngestOrchestrator()
    expect(q.getIngestTask(id)?.status).toBe("pending") // deferred, not claimed

    const ok = await orch.cancelIngestTask(id)
    expect(ok).toBe(true)
    expect(q.getIngestTask(id)).toBeUndefined()
    expect(runIngestPipeline).not.toHaveBeenCalled()

    // Cancelling a missing task reports false.
    expect(await orch.cancelIngestTask(999_999)).toBe(false)
  })
})

describe("graph:updated emission (taxonomy stage 4)", () => {
  it("processTask success emits ONE aggregate graph:updated after ingest:complete", async () => {
    vi.mocked(runIngestPipeline).mockImplementation(async (task, env) => {
      env.onFileWritten("wiki/concepts/graph-one.md")
      env.onFileWritten("wiki/concepts/graph-two.md")
      env.onFileWritten("wiki/log.md")
      return successResult([
        "wiki/concepts/graph-one.md",
        "wiki/concepts/graph-two.md",
        "wiki/log.md",
      ])
    })
    const id = enq(projA.id, "raw/sources/graph-success.md")

    orch.startIngestOrchestrator()
    await waitFor(() => q.getIngestTask(id)?.status === "completed")

    // ONE aggregate frame for the whole task — nodesChanged =
    // result.writtenPaths.length; the orchestrator only holds paths (page
    // contents stream straight to disk), so edgesChanged is unknown ⇒ 0.
    const graph = frames.filter((f) => f.type === "graph:updated")
    expect(graph).toHaveLength(1)
    expect(graph[0].projectId).toBeNull() // emit() bridge envelope
    expect(graph[0].payload).toEqual({
      projectId: projA.id,
      nodesChanged: 3,
      edgesChanged: 0,
    })

    // The aggregate rides the bus AFTER the task's ingest:complete frame.
    const completeIdx = frames.findIndex((f) => f.type === "ingest:complete")
    expect(completeIdx).toBeGreaterThanOrEqual(0)
    expect(frames.indexOf(graph[0])).toBeGreaterThan(completeIdx)
  })

  it("success without written paths emits NO graph:updated (gated on writtenPaths.length > 0)", async () => {
    // Parity with the cancel-cleanup and chat/writes emit sites: nothing
    // written ⇒ no graph change ⇒ no frame (PR #29 review round 2). The task
    // itself still completes normally.
    vi.mocked(runIngestPipeline).mockResolvedValue(successResult([]))
    const id = enq(projA.id, "raw/sources/graph-empty.md")

    orch.startIngestOrchestrator()
    await waitFor(() => q.getIngestTask(id)?.status === "completed")

    expect(framesOf("ingest:complete", id)).toHaveLength(1)
    expect(frames.filter((f) => f.type === "graph:updated")).toHaveLength(0)
  })

  it("cancel cleanup emits ONE graph:updated with nodesChanged = pages actually unlinked", async () => {
    const relOne = "wiki/concepts/graph-a.md"
    const relTwo = "wiki/concepts/graph-b.md"
    for (const rel of [relOne, relTwo]) {
      const full = path.join(projA.path, rel)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, "---\ntitle: cancelled\n---\n# cancelled page\n")
    }

    vi.mocked(runIngestPipeline).mockImplementation((task, env) => {
      env.onFileWritten(relOne)
      env.onFileWritten(relTwo)
      env.onFileWritten("wiki/index.md") // structural ⇒ skipped by cleanup
      return new Promise((resolve, reject) => {
        env.signal.addEventListener("abort", () => reject(new Error("Ingest cancelled")), { once: true })
      })
    })
    const id = enq(projA.id, "raw/sources/graph-cancel.md")

    orch.startIngestOrchestrator()
    await waitFor(() => orch.activeIngestTaskCount() === 1)

    // cancelIngestTask awaits the cleanup, so the aggregate frame has
    // already been published when it resolves.
    expect(await orch.cancelIngestTask(id)).toBe(true)
    await waitFor(() => orch.activeIngestTaskCount() === 0)

    const graph = frames.filter((f) => f.type === "graph:updated")
    expect(graph).toHaveLength(1)
    expect(graph[0].projectId).toBeNull()
    expect(graph[0].payload).toEqual({
      projectId: projA.id,
      nodesChanged: 2, // two pages unlinked; structural index.md skipped
      edgesChanged: 0,
    })
    // file:deleted parity: one frame per successful unlink, same two pages.
    expect(frames.filter((f) => f.type === "file:deleted")).toHaveLength(2)
  })
})

describe("kick chaining + idempotent start", () => {
  it("task B starts after task A completes; double start does not double-process", async () => {
    const gates = new Map()
    const started = []
    vi.mocked(runIngestPipeline).mockImplementation((task) => {
      started.push(task.file_path)
      const gate = deferred()
      gates.set(task.file_path, gate)
      return gate.promise
    })
    enq(projA.id, "raw/sources/chain-a.md")
    enq(projA.id, "raw/sources/chain-b.md")

    orch.startIngestOrchestrator()
    orch.startIngestOrchestrator() // idempotent: no double claims, no extra timer

    await waitFor(() => started.length === 1)
    expect(started[0]).toBe("raw/sources/chain-a.md")

    gates.get("raw/sources/chain-a.md").resolve(successResult())
    await waitFor(() => started.length === 2) // the finally-kick chains B in
    expect(started[1]).toBe("raw/sources/chain-b.md")

    gates.get("raw/sources/chain-b.md").resolve(successResult())
    await waitFor(() => orch.activeIngestTaskCount() === 0)
    const rows = q.listIngestTasks(projA.id, { status: "completed" })
    expect(rows.length).toBe(2)
    expect(runIngestPipeline).toHaveBeenCalledTimes(2)
  })
})

describe("sweep timer", () => {
  it("resumes deferred (not_before) tasks without external events", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    try {
      vi.mocked(runIngestPipeline).mockResolvedValue(successResult())
      const id = enq(projA.id, "raw/sources/deferred.md")
      q.failIngestTask(id, "wait", { retryable: true, notBefore: Date.now() + 30_000 })

      orch.startIngestOrchestrator()
      expect(q.getIngestTask(id)?.status).toBe("pending") // initial kick skips it
      expect(runIngestPipeline).not.toHaveBeenCalled()

      // The 60s sweep fires after not_before has passed → claim + complete.
      await vi.advanceTimersByTimeAsync(61_000)
      expect(runIngestPipeline).toHaveBeenCalledTimes(1)
      expect(q.getIngestTask(id)?.status).toBe("completed")
    } finally {
      vi.useRealTimers()
    }
  })
})
