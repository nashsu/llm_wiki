import { describe, it, expect, beforeEach, vi } from "vitest"
import { flushMicrotasks } from "@/test-helpers/deferred"

// Mock autoIngest so tests control success/failure timing.
vi.mock("./ingest", () => ({
  autoIngest: vi.fn(),
}))

// Mock fs so we don't hit the real filesystem.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

// Mock sweep-reviews since the queue drain dynamically imports it. The
// sweep itself has its own test file; here we just confirm it's triggered.
vi.mock("./sweep-reviews", () => ({
  sweepResolvedReviews: vi.fn().mockResolvedValue(0),
}))

// Mock embedding so cleanupWrittenFiles' cascade-delete to LanceDB is
// observable. The real module is over in `./embedding` but
// cleanupWrittenFiles dynamically imports it via `@/lib/embedding`,
// hence the absolute mock target.
const removePageEmbeddingMock = vi.fn<(projectPath: string, slug: string) => Promise<void>>(
  async () => {},
)
vi.mock("@/lib/embedding", () => ({
  removePageEmbedding: (projectPath: string, slug: string) =>
    removePageEmbeddingMock(projectPath, slug),
}))

// Mock project-identity — tests don't hit Tauri plugin-store. Maps the
// test UUIDs defined below back to their assigned paths.
const TEST_ID = "test-project-uuid"
const TEST_PATH = "/project"
const TEST_ID_B = "test-project-uuid-b"
const TEST_PATH_B = "/project-b"
const idToPath: Record<string, string> = {
  [TEST_ID]: TEST_PATH,
  [TEST_ID_B]: TEST_PATH_B,
}
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => idToPath[id] ?? null),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import {
  enqueueIngest,
  enqueueBatch,
  retryTask,
  cancelTask,
  cancelAllTasks,
  clearCompletedTasks,
  clearQueueState,
  cleanupWrittenFiles,
  getQueue,
  getQueueSummary,
  restoreQueue,
} from "./ingest-queue"
import { autoIngest } from "./ingest"
import { readFile, writeFile } from "@/commands/fs"
import { sweepResolvedReviews } from "./sweep-reviews"
import { useWikiStore } from "@/stores/wiki-store"

const mockAutoIngest = vi.mocked(autoIngest)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockSweep = vi.mocked(sweepResolvedReviews)

/** Simulate the app having opened `TEST_ID` at `TEST_PATH` so the queue
 *  module's `currentProjectId` / `currentProjectPath` are set. Most
 *  tests need this — enqueue / retry / cancel guard against inactive
 *  projects. */
async function activateProject(id: string = TEST_ID): Promise<void> {
  await restoreQueue(id, idToPath[id])
}

beforeEach(async () => {
  clearQueueState()
  mockAutoIngest.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockSweep.mockReset()
  mockSweep.mockResolvedValue(0)
  removePageEmbeddingMock.mockReset()

  // Default: persisted queue file doesn't exist
  mockReadFile.mockRejectedValue(new Error("ENOENT"))
  mockWriteFile.mockResolvedValue(undefined as unknown as void)

  // Default: a valid LLM config so processNext doesn't reject.
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  await activateProject()
})

describe("ingest-queue — enqueue & basic processing", () => {
  it("enqueueIngest adds a pending task and triggers processing", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    const id = await enqueueIngest(TEST_ID, "raw/sources/a.md")
    expect(id).toMatch(/^ingest-/)

    // Let the async processing loop run
    await flushMicrotasks(10)

    // Task should have been processed and removed
    expect(mockAutoIngest).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
  })

  it("persists queue to disk on enqueue", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // never resolves
    await enqueueIngest(TEST_ID, "a.md")
    await flushMicrotasks(2)

    // writeFile should have been called to save the queue
    const calls = mockWriteFile.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const queuePath = calls[0][0]
    expect(queuePath).toContain(".llm-wiki/ingest-queue.json")
  })

  it("enqueueBatch queues multiple tasks and processes them serially", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
    ])

    await flushMicrotasks(50)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
  })
})

describe("ingest-queue — retry & failure", () => {
  it("retries a failing task up to MAX_RETRIES=3 then marks failed", async () => {
    mockAutoIngest.mockRejectedValue(new Error("LLM error"))

    await enqueueIngest(TEST_ID, "bad.md")
    await flushMicrotasks(30)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("failed")
    expect(queue[0].error).toContain("LLM error")
    expect(queue[0].retryCount).toBe(3)
  })

  it("succeeds on retry after transient failure", async () => {
    mockAutoIngest
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(["wiki/sources/foo.md"])

    await enqueueIngest(TEST_ID, "flaky.md")
    await flushMicrotasks(30)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
  })

  it("treats autoIngest resolving to an empty array as a failure (not silent success)", async () => {
    // Regression: a webview refresh could abort the LLM fetch, making
    // streamChat's error path fire, which historically caused autoIngest
    // to `return []` — processNext then removed the task from the queue
    // as if it had succeeded. The safety net in processNext now rejects
    // zero-output completions and keeps the task around to retry.
    mockAutoIngest.mockResolvedValue([])

    await enqueueIngest(TEST_ID, "refresh-abort.md")
    await flushMicrotasks(30)

    // Three retries were attempted — the task didn't just vanish.
    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("failed")
    expect(queue[0].error).toContain("未产生任何输出文件")
    expect(queue[0].retryCount).toBe(3)
  })

  it("retryTask resets a failed task to pending and reprocesses it", async () => {
    mockAutoIngest.mockRejectedValue(new Error("always fails"))

    await enqueueIngest(TEST_ID, "x.md")
    await flushMicrotasks(20)
    expect(getQueue()[0].status).toBe("failed")

    const taskId = getQueue()[0].id
    mockAutoIngest.mockResolvedValueOnce(["wiki/sources/foo.md"])
    await retryTask(taskId)
    await flushMicrotasks(10)

    expect(getQueue()).toHaveLength(0)
  })
})

describe("ingest-queue — cancel", () => {
  it("cancelTask removes a pending task without calling autoIngest", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // block first task

    await enqueueBatch(TEST_ID, [
      { sourcePath: "first.md", folderContext: "" },
      { sourcePath: "second.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    // first.md is processing; cancel second.md (still pending)
    const queue = getQueue()
    const second = queue.find((t) => t.sourcePath === "second.md")!
    await cancelTask(second.id)

    expect(getQueue().find((t) => t.sourcePath === "second.md")).toBeUndefined()
    expect(getQueue().find((t) => t.sourcePath === "first.md")).toBeDefined()
  })
})

describe("ingest-queue — cancelAllTasks", () => {
  it("drops all pending and processing tasks but keeps failed ones", async () => {
    // Block the processing task so it doesn't finish on its own.
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    // Manually set one task to "failed" so we can verify it survives.
    const failedTask = getQueue()[2]
    ;(failedTask as { status: string }).status = "failed"

    const removed = await cancelAllTasks()

    expect(removed).toBe(2) // a (processing) + b (pending) gone
    expect(getQueue()).toHaveLength(1)
    expect(getQueue()[0].sourcePath).toBe("c.md")
    expect(getQueue()[0].status).toBe("failed")
  })

  it("returns 0 when the queue is empty", async () => {
    const removed = await cancelAllTasks()
    expect(removed).toBe(0)
    expect(getQueue()).toHaveLength(0)
  })

  it("is safe to call after it has already cleared the queue", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueIngest(TEST_ID, "only.md")
    await flushMicrotasks(2)

    await cancelAllTasks()
    const secondCall = await cancelAllTasks()
    expect(secondCall).toBe(0)
  })
})

describe("ingest-queue — clearCompletedTasks & summary", () => {
  it("getQueueSummary returns accurate counts", async () => {
    mockAutoIngest.mockRejectedValue(new Error("fail"))
    await enqueueIngest(TEST_ID, "fail.md")
    await flushMicrotasks(20)

    const summary = getQueueSummary()
    expect(summary.failed).toBe(1)
    expect(summary.pending).toBe(0)
    expect(summary.total).toBe(1)
  })

  it("clearCompletedTasks drops failed tasks", async () => {
    mockAutoIngest.mockRejectedValue(new Error("fail"))
    await enqueueIngest(TEST_ID, "f.md")
    await flushMicrotasks(20)

    expect(getQueue()).toHaveLength(1)
    await clearCompletedTasks()
    expect(getQueue()).toHaveLength(0)
  })
})

describe("ingest-queue — queue-drain triggers review sweep", () => {
  it("calls sweepResolvedReviews once after a successful task drains the queue", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    await enqueueIngest(TEST_ID, "ok.md")
    await flushMicrotasks(30)

    expect(mockSweep).toHaveBeenCalledOnce()
    expect(mockSweep).toHaveBeenCalledWith("/project", expect.any(AbortSignal))
  })

  it("does NOT trigger sweep when no task has been processed since the last drain", async () => {
    // No tasks enqueued — processedSinceDrain flag stays false
    // (We simulate an idle condition by enqueueing, processing, draining once)
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])
    await enqueueIngest(TEST_ID, "a.md")
    await flushMicrotasks(20)
    expect(mockSweep).toHaveBeenCalledTimes(1)

    // Now the queue is empty. Calling cancelTask on a nonexistent id is a
    // no-op but internally may call processNext → no drain fire (nothing
    // was processed since the last drain).
    await cancelTask("nonexistent")
    await flushMicrotasks(5)
    expect(mockSweep).toHaveBeenCalledTimes(1)
  })

  it("does NOT trigger sweep when all tasks fail (nothing was successfully ingested)", async () => {
    mockAutoIngest.mockRejectedValue(new Error("always fails"))

    await enqueueIngest(TEST_ID, "bad.md")
    await flushMicrotasks(30)

    expect(mockSweep).not.toHaveBeenCalled()
  })
})

describe("ingest-queue — clearQueueState", () => {
  it("clears pending tasks and resets processing flag", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    expect(getQueue().length).toBeGreaterThan(0)

    clearQueueState()
    expect(getQueue()).toHaveLength(0)
  })

  it("processedSinceDrain flag resets so a post-switch no-op won't trigger sweep", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])
    await enqueueIngest(TEST_ID, "x.md")
    await flushMicrotasks(20)
    mockSweep.mockClear()

    clearQueueState()
    // Simulate new drain trigger on an empty queue — no sweep.
    await flushMicrotasks(5)
    expect(mockSweep).not.toHaveBeenCalled()
  })
})

describe("ingest-queue — restoreQueue", () => {
  it("resets in-memory state before loading, preventing cross-project bleed", async () => {
    // Seed in-memory state from project A
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueIngest(TEST_ID, "a.md")
    await flushMicrotasks(2)
    expect(getQueue().length).toBeGreaterThan(0)

    // Now restore project B — should reset and load B's saved queue (empty)
    mockReadFile.mockRejectedValue(new Error("ENOENT"))
    await restoreQueue(TEST_ID_B, TEST_PATH_B)
    expect(getQueue()).toHaveLength(0)
  })

  it("converts 'processing' tasks back to 'pending' on restore (interrupted by app close)", async () => {
    const saved = [
      {
        id: "ingest-abc",
        sourcePath: "a.md",
        folderContext: "",
        status: "processing",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    // Prevent the reprocessing kickoff from completing forever:
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(2)

    const queue = getQueue()
    expect(queue).toHaveLength(1)
    // After restore + kick-off of processNext, the task transitions back to
    // "processing" — but the RESTORED-from-disk value was "pending". We can
    // still assert it's not "failed" / "done".
    expect(["pending", "processing"]).toContain(queue[0].status)
  })

  it("leaves 'failed' tasks as failed on restore", async () => {
    const saved = [
      {
        id: "ingest-x",
        sourcePath: "x.md",
        folderContext: "",
        status: "failed",
        addedAt: 0,
        error: "prior failure",
        retryCount: 3,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))

    await restoreQueue(TEST_ID, TEST_PATH)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("failed")
    expect(queue[0].error).toBe("prior failure")
  })

  it("backfills projectId on older task files that predate the field", async () => {
    // Disk written before projectId was part of the schema.
    const savedLegacy = [
      {
        id: "ingest-legacy",
        sourcePath: "legacy.md",
        folderContext: "",
        status: "pending",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(savedLegacy))
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await restoreQueue(TEST_ID, TEST_PATH)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].projectId).toBe(TEST_ID)
  })
})

import { pauseQueue } from "./ingest-queue"

describe("ingest-queue — pauseQueue & switch-project survival", () => {
  it("pauseQueue persists pending/processing tasks to the paused project's disk", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)
    mockWriteFile.mockClear()

    await pauseQueue()

    // The last write call should contain BOTH tasks, with the processing
    // one demoted back to pending for resume-on-return.
    const writes = mockWriteFile.mock.calls
    expect(writes.length).toBeGreaterThan(0)
    const [pathArg, contentArg] = writes[writes.length - 1]
    expect(String(pathArg)).toContain("/project/.llm-wiki/ingest-queue.json")
    const persisted = JSON.parse(String(contentArg)) as Array<{ status: string }>
    expect(persisted).toHaveLength(2)
    for (const t of persisted) expect(t.status).toBe("pending")
  })

  it("pauseQueue then restoreQueue of SAME project brings tasks back", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueIngest(TEST_ID, "first.md")
    await flushMicrotasks(2)

    // Capture what pauseQueue writes so restore can read it back.
    let lastWrittenContent = ""
    mockWriteFile.mockImplementation(async (_path: string, content: string) => {
      lastWrittenContent = content
    })
    await pauseQueue()

    // Simulate reloading that same project: disk returns what we just wrote.
    mockReadFile.mockResolvedValue(lastWrittenContent)
    await restoreQueue(TEST_ID, TEST_PATH)

    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].sourcePath).toBe("first.md")
  })

  it("processNext bails if currentProjectId changes mid-ingest (no cross-project writes)", async () => {
    // Block autoIngest so we can pause mid-flight. Then resolve it
    // AFTER pauseQueue completes to simulate the delayed return.
    let resolveAutoIngest: (files: string[]) => void = () => {}
    mockAutoIngest.mockImplementation(
      () => new Promise<string[]>((resolve) => { resolveAutoIngest = resolve }),
    )

    await enqueueIngest(TEST_ID, "long-running.md")
    await flushMicrotasks(2)
    // Ensure the task is processing
    expect(getQueue().find((t) => t.status === "processing")).toBeTruthy()

    // Switch projects: pause then restore a different one.
    mockWriteFile.mockClear()
    await pauseQueue()
    await restoreQueue(TEST_ID_B, TEST_PATH_B)

    // Now the orphaned autoIngest for TEST_ID returns late.
    resolveAutoIngest(["wiki/sources/foo.md"])
    await flushMicrotasks(10)

    // The orphan must not have written to the ACTIVE (B) project's file.
    // Inspect every post-pause write — the path should never contain the
    // project-B queue file getting mutated by the orphan's filter result.
    const writes = mockWriteFile.mock.calls
    // Confirm no write touched project B's queue from orphan completion.
    // (The only writes should be pauseQueue's flush to /project and
    // restoreQueue's initial save of B's empty queue.)
    const bWrites = writes.filter(([p]) => String(p).includes("/project-b/"))
    // B's queue should only have been written once (during restore), and
    // that write should show an empty array — not the orphan's filtered
    // result leaking in.
    for (const [, content] of bWrites) {
      const parsed = JSON.parse(String(content))
      expect(parsed).toEqual([])
    }
  })
})

// ── cleanupWrittenFiles — file delete + LanceDB chunk cascade ──────
describe("cleanupWrittenFiles — embedding cascade", () => {
  it("deletes each file AND drops its embedding chunks (relative paths)", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    await cleanupWrittenFiles("/proj", [
      "wiki/concepts/rope.md",
      "wiki/entities/transformer.md",
    ])

    // File deletes use joined absolute paths.
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    expect(mockDeleteFile).toHaveBeenNthCalledWith(1, "/proj/wiki/concepts/rope.md")
    expect(mockDeleteFile).toHaveBeenNthCalledWith(2, "/proj/wiki/entities/transformer.md")

    // Embedding cascade uses page slugs (basename minus .md).
    expect(removePageEmbeddingMock).toHaveBeenCalledTimes(2)
    expect(removePageEmbeddingMock).toHaveBeenNthCalledWith(1, "/proj", "rope")
    expect(removePageEmbeddingMock).toHaveBeenNthCalledWith(2, "/proj", "transformer")
  })

  it("uses absolute paths verbatim (doesn't double-prefix the project path)", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    await cleanupWrittenFiles("/proj", ["/abs/elsewhere/wiki/concepts/foo.md"])

    expect(mockDeleteFile).toHaveBeenCalledWith("/abs/elsewhere/wiki/concepts/foo.md")
    // Slug derivation still works on absolute paths.
    expect(removePageEmbeddingMock).toHaveBeenCalledWith("/proj", "foo")
  })

  it("continues to subsequent files when one delete throws", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    // First file fails (e.g. already gone), second succeeds.
    mockDeleteFile
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(undefined)

    await cleanupWrittenFiles("/proj", [
      "wiki/concepts/missing.md",
      "wiki/concepts/present.md",
    ])

    // Both deleteFile attempts happened — the helper kept going.
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    // First file's embedding cascade was skipped (deleteFile threw),
    // second file's cascade still ran.
    expect(removePageEmbeddingMock).toHaveBeenCalledTimes(1)
    expect(removePageEmbeddingMock).toHaveBeenCalledWith("/proj", "present")
  })

  it("swallows removePageEmbedding errors so a LanceDB issue doesn't abort cleanup", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    // First page's embedding cascade throws; second succeeds.
    removePageEmbeddingMock
      .mockRejectedValueOnce(new Error("lancedb unavailable"))
      .mockResolvedValueOnce(undefined)

    await cleanupWrittenFiles("/proj", [
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
    ])

    // Both file deletes still happened.
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    // Second cascade still attempted despite first throwing.
    expect(removePageEmbeddingMock).toHaveBeenCalledTimes(2)
  })

  it("handles Windows backslash paths via getFileStem", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    // A path that's been rewritten with backslashes (Windows ingest
    // pipeline output before normalize). getFileStem must still
    // pull "rope" out cleanly so the cascade hits the right page.
    await cleanupWrittenFiles("C:/proj", ["wiki\\concepts\\rope.md"])

    expect(removePageEmbeddingMock).toHaveBeenCalledWith("C:/proj", "rope")
  })
})
