import { describe, it, expect, beforeEach, vi } from "vitest"
import { createDeferred, flushMicrotasks, waitFor } from "@/test-helpers/deferred"

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

// Mock the centralized page cascade used by cleanupWrittenFiles.
const cascadeDeleteWikiPageMock = vi.fn<(projectPath: string, filePath: string) => Promise<void>>(
  async () => {},
)
vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPage: (projectPath: string, filePath: string) =>
    cascadeDeleteWikiPageMock(projectPath, filePath),
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
  enqueueInactiveProjectBatch,
  discardInactiveProjectTasksForSources,
  retryTask,
  retryTasks,
  retryAllFailedTasks,
  cancelTask,
  cancelTasks,
  removeTask,
  removeTasks,
  hasActiveRun,
  retainQueuedSelection,
  discardTasksForSources,
  cancelAllTasks,
  movePendingTask,
  clearCompletedTasks,
  clearQueueState,
  cleanupWrittenFiles,
  getQueue,
  getQueueSummary,
  restoreQueue,
  pauseProcessing,
  resumeProcessing,
  isQueuePaused,
  setIngestWorkerLimit,
  getIngestWorkerLimit,
} from "./ingest-queue"
import { autoIngest } from "./ingest"
import { deleteFile, readFile, writeFile } from "@/commands/fs"
import { sweepResolvedReviews } from "./sweep-reviews"
import { useWikiStore } from "@/stores/wiki-store"

const mockAutoIngest = vi.mocked(autoIngest)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockDeleteFile = vi.mocked(deleteFile)
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
  mockDeleteFile.mockReset()
  mockDeleteFile.mockResolvedValue(undefined as unknown as void)
  mockSweep.mockReset()
  mockSweep.mockResolvedValue(0)
  cascadeDeleteWikiPageMock.mockReset()
  cascadeDeleteWikiPageMock.mockImplementation(async (_projectPath, filePath) => {
    const { deleteFile } = await import("@/commands/fs")
    await deleteFile(filePath)
  })

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
  it("clamps the configurable worker limit", () => {
    setIngestWorkerLimit(0)
    expect(getIngestWorkerLimit()).toBe(1)
    setIngestWorkerLimit(99)
    expect(getIngestWorkerLimit()).toBe(64)
    setIngestWorkerLimit(2.9)
    expect(getIngestWorkerLimit()).toBe(2)
  })

  it("persists inactive-project tasks and starts them when that project opens", async () => {
    const ids = await enqueueInactiveProjectBatch(TEST_ID_B, TEST_PATH_B, [
      {
        sourcePath: `${TEST_PATH_B}/raw/sources/scheduled-import/report.pdf`,
        folderContext: "scheduled-import",
      },
    ])

    expect(ids).toHaveLength(1)
    const inactiveWrite = mockWriteFile.mock.calls.find(
      ([path]) => path === `${TEST_PATH_B}/.llm-wiki/ingest-queue.json`,
    )
    expect(inactiveWrite).toBeDefined()
    const persisted = JSON.parse(String(inactiveWrite?.[1])) as Array<{
      sourcePath: string
      status: string
    }>
    expect(persisted).toMatchObject([
      {
        sourcePath: "raw/sources/scheduled-import/report.pdf",
        status: "pending",
      },
    ])

    mockReadFile.mockImplementation(async (path: string) => {
      if (path === `${TEST_PATH_B}/.llm-wiki/ingest-queue.json`) {
        return String(inactiveWrite?.[1])
      }
      throw new Error("ENOENT")
    })
    mockAutoIngest.mockResolvedValue(["wiki/sources/report.md"])

    await restoreQueue(TEST_ID_B, TEST_PATH_B)
    await flushMicrotasks(20)

    expect(mockAutoIngest).toHaveBeenCalledWith(
      TEST_PATH_B,
      `${TEST_PATH_B}/raw/sources/scheduled-import/report.pdf`,
      expect.any(Object),
      expect.any(AbortSignal),
      "scheduled-import",
      expect.any(Function),
      expect.objectContaining({ runCommit: expect.any(Function) }),
    )
    expect(getQueue()).toHaveLength(0)
  })

  it("recovers the inactive-project write chain after a persistence failure", async () => {
    mockWriteFile
      .mockRejectedValueOnce(new Error("disk temporarily unavailable"))
      .mockResolvedValue(undefined as unknown as void)

    await expect(enqueueInactiveProjectBatch(TEST_ID_B, TEST_PATH_B, [
      { sourcePath: `${TEST_PATH_B}/raw/sources/first.pdf`, folderContext: "" },
    ])).rejects.toThrow("disk temporarily unavailable")

    await expect(enqueueInactiveProjectBatch(TEST_ID_B, TEST_PATH_B, [
      { sourcePath: `${TEST_PATH_B}/raw/sources/second.pdf`, folderContext: "" },
    ])).resolves.toHaveLength(1)
    expect(mockWriteFile).toHaveBeenLastCalledWith(
      `${TEST_PATH_B}/.llm-wiki/ingest-queue.json`,
      expect.stringContaining("raw/sources/second.pdf"),
    )
  })

  it("discards persisted tasks for deleted inactive-project sources", async () => {
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === `${TEST_PATH_B}/.llm-wiki/ingest-queue.json`) {
        return JSON.stringify([
          {
            id: "remove-me",
            projectId: TEST_ID_B,
            sourcePath: "raw/sources/old.pdf",
            folderContext: "",
            status: "pending",
            addedAt: 1,
            error: null,
            retryCount: 0,
          },
          {
            id: "keep-me",
            projectId: TEST_ID_B,
            sourcePath: "raw/sources/current.pdf",
            folderContext: "",
            status: "pending",
            addedAt: 2,
            error: null,
            retryCount: 0,
          },
        ])
      }
      throw new Error("ENOENT")
    })

    await expect(discardInactiveProjectTasksForSources(
      TEST_ID_B,
      TEST_PATH_B,
      ["raw/sources/old.pdf"],
    )).resolves.toBe(1)

    const lastWrite = mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1]
    const persisted = JSON.parse(String(lastWrite?.[1])) as Array<{
      id: string
    }>
    expect(persisted.map((task) => task.id)).toEqual(["keep-me"])
  })

  it("enqueueIngest adds a pending task and triggers processing", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    const id = await enqueueIngest(TEST_ID, "raw/sources/a.md")
    expect(id).toMatch(/^ingest-/)

    // Let the async processing loop run
    await flushMicrotasks(10)

    // Task should have been processed and removed
    expect(mockAutoIngest).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary()).toMatchObject({ completed: 1, total: 1 })
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

describe("ingest-queue — concurrent workers", () => {
  it("fills the configured worker pool without exceeding its limit", async () => {
    setIngestWorkerLimit(2)
    const runs = new Map<string, ReturnType<typeof createDeferred<string[]>>>()
    mockAutoIngest.mockImplementation((_projectPath, sourcePath) => {
      const deferred = createDeferred<string[]>()
      runs.set(sourcePath, deferred)
      return deferred.promise
    })

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
    ])
    await waitFor(() => mockAutoIngest.mock.calls.length === 2)
    expect(getQueueSummary()).toMatchObject({ processing: 2, pending: 1 })

    const firstRun = [...runs.values()][0]
    expect(firstRun).toBeDefined()
    firstRun.resolve(["wiki/sources/a.md"])
    await waitFor(() => mockAutoIngest.mock.calls.length === 3)
    expect(getQueueSummary().processing).toBe(2)

    for (const deferred of runs.values()) {
      if (!deferred.settled) deferred.resolve(["wiki/sources/completed.md"])
    }
    await waitFor(() => getQueue().length === 0)
    expect(getQueueSummary()).toMatchObject({ completed: 3, processing: 0, pending: 0 })
  })

  it("cancels one active worker without aborting its sibling", async () => {
    setIngestWorkerLimit(2)
    const signals = new Map<string, AbortSignal>()
    const runs = new Map<string, ReturnType<typeof createDeferred<string[]>>>()
    mockAutoIngest.mockImplementation((_projectPath, sourcePath, _config, signal) => {
      const deferred = createDeferred<string[]>()
      signals.set(sourcePath, signal as AbortSignal)
      runs.set(sourcePath, deferred)
      signal?.addEventListener("abort", () => deferred.reject(new Error("aborted")))
      return deferred.promise
    })

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await waitFor(() => mockAutoIngest.mock.calls.length === 2)
    const firstTask = getQueue().find((task) => task.sourcePath === "a.md")
    expect(firstTask).toBeDefined()
    await cancelTask(firstTask?.id ?? "")

    expect(signals.get(`${TEST_PATH}/a.md`)?.aborted).toBe(true)
    expect(signals.get(`${TEST_PATH}/b.md`)?.aborted).toBe(false)
    const siblingRun = [...runs.entries()].find(([path]) => path.endsWith("/b.md"))?.[1]
    expect(siblingRun).toBeDefined()
    siblingRun?.resolve(["wiki/sources/b.md"])
    await waitFor(() => getQueueSummary().processing === 0)
    expect(getQueue().find((task) => task.sourcePath === "a.md")?.status).toBe("cancelled")
  })

  it("does not delete merged pages when cancelling a worker", async () => {
    const finish = createDeferred<string[]>()
    mockAutoIngest.mockImplementation(
      async (_projectPath, _sourcePath, _config, _signal, _folder, onFileWritten) => {
        onFileWritten?.("wiki/concepts/existing.md")
        return finish.promise
      },
    )

    await enqueueIngest(TEST_ID, "cancel-during-write.md")
    await waitFor(() => getQueueSummary().processing === 1)
    const task = getQueue()[0]
    await cancelTask(task.id)

    expect(mockDeleteFile).not.toHaveBeenCalled()
    finish.resolve(["wiki/concepts/existing.md"])
    await flushMicrotasks(10)
    expect(mockDeleteFile).not.toHaveBeenCalled()
  })

  it("does not restart a cancelled task until its previous worker exits", async () => {
    setIngestWorkerLimit(2)
    const firstRun = createDeferred<string[]>()
    mockAutoIngest
      .mockImplementationOnce(() => firstRun.promise)
      .mockResolvedValueOnce(["wiki/sources/retried.md"])

    await enqueueIngest(TEST_ID, "retry-after-cancel.md")
    await waitFor(() => mockAutoIngest.mock.calls.length === 1)
    const task = getQueue()[0]
    await cancelTask(task.id)
    await retryTask(task.id)
    await flushMicrotasks(10)
    expect(mockAutoIngest).toHaveBeenCalledTimes(1)

    firstRun.reject(new Error("aborted"))
    await waitFor(() => mockAutoIngest.mock.calls.length === 2)
    await waitFor(() => getQueue().length === 0)
  })

  it("ignores retry requests for a task that is still processing", async () => {
    setIngestWorkerLimit(2)
    const run = createDeferred<string[]>()
    mockAutoIngest.mockImplementation(() => run.promise)

    await enqueueIngest(TEST_ID, "still-processing.md")
    await waitFor(() => getQueueSummary().processing === 1)
    const task = getQueue()[0]
    await retryTask(task.id)

    expect(task.status).toBe("processing")
    expect(mockAutoIngest).toHaveBeenCalledTimes(1)
    run.resolve(["wiki/sources/still-processing.md"])
    await waitFor(() => getQueue().length === 0)
    expect(mockAutoIngest).toHaveBeenCalledTimes(1)
  })

  it("pauses and aborts every active worker after a provider usage limit", async () => {
    setIngestWorkerLimit(2)
    const signals: AbortSignal[] = []
    const firstRun = createDeferred<string[]>()
    const secondRun = createDeferred<string[]>()
    mockAutoIngest
      .mockImplementationOnce((_projectPath, _sourcePath, _config, signal) => {
        signals.push(signal as AbortSignal)
        return firstRun.promise
      })
      .mockImplementationOnce((_projectPath, _sourcePath, _config, signal) => {
        signals.push(signal as AbortSignal)
        signal?.addEventListener("abort", () => secondRun.reject(new Error("aborted")))
        return secondRun.promise
      })

    await enqueueBatch(TEST_ID, [
      { sourcePath: "limited.md", folderContext: "" },
      { sourcePath: "sibling.md", folderContext: "" },
    ])
    await waitFor(() => signals.length === 2)
    firstRun.reject(new Error("429 usage limit exceeded"))
    await waitFor(() => getQueueSummary().processing === 0)

    expect(signals[1].aborted).toBe(true)
    expect(isQueuePaused()).toBe(true)
    expect(getQueue().map((task) => task.status)).toEqual(["pending", "pending"])
    expect(getQueue().every((task) => task.retryCount === 0)).toBe(true)
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
    expect(queue[0].error).toContain("no output files")
    expect(queue[0].retryCount).toBe(3)
  })

  it("retryTask resets a failed task to pending and reprocesses it", async () => {
    mockAutoIngest.mockRejectedValue(new Error("always fails"))

    await enqueueIngest(TEST_ID, "x.md")
    await flushMicrotasks(20)
    expect(getQueue()[0].status).toBe("failed")

    const taskId = getQueue()[0].id
    expect(getQueue()[0].retryCount).toBe(3)
    mockAutoIngest.mockResolvedValueOnce(["wiki/sources/foo.md"])
    await retryTask(taskId)
    await flushMicrotasks(10)

    expect(getQueue()).toHaveLength(0)
  })

  it("retryAllFailedTasks requeues every failed task and resumes processing", async () => {
    const saved = [
      {
        id: "ingest-failed-a",
        sourcePath: "a.md",
        folderContext: "",
        status: "failed",
        addedAt: 0,
        error: "rate limit",
        retryCount: 3,
      },
      {
        id: "ingest-failed-b",
        sourcePath: "b.md",
        folderContext: "",
        status: "failed",
        addedAt: 1,
        error: "timeout",
        retryCount: 3,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await restoreQueue(TEST_ID, TEST_PATH)
    mockWriteFile.mockClear()

    const requeued = await retryAllFailedTasks()
    await flushMicrotasks(2)

    expect(requeued).toBe(2)
    expect(mockAutoIngest).toHaveBeenCalledOnce()
    expect(getQueue().map((task) => task.error)).toEqual([null, null])
    expect(getQueue().map((task) => task.retryCount)).toEqual([0, 0])
    expect(getQueue().map((task) => task.status)).toEqual(["processing", "pending"])
    expect(mockWriteFile).toHaveBeenCalled()
  })

  it("retryAllFailedTasks returns 0 when there are no failed tasks", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    const requeued = await retryAllFailedTasks()

    expect(requeued).toBe(0)
    expect(mockAutoIngest).not.toHaveBeenCalled()
  })
})

describe("ingest-queue — cancel", () => {
  it("permanently discards queued work for a removed source", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch(TEST_ID, [
      { sourcePath: "raw/sources/active.md", folderContext: "" },
      { sourcePath: "raw/sources/removed.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    expect(
      await discardTasksForSources([`${TEST_PATH}/raw/sources/removed.md`]),
    ).toBe(1)
    expect(getQueue().some((task) => task.sourcePath.endsWith("removed.md"))).toBe(false)
    expect(getQueue().some((task) => task.sourcePath.endsWith("active.md"))).toBe(true)
  })

  it("cancelTask retains a pending task for restart without calling autoIngest", async () => {
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

    expect(getQueue().find((t) => t.sourcePath === "second.md")?.status).toBe("cancelled")
    expect(getQueue().find((t) => t.sourcePath === "first.md")).toBeDefined()
  })

  it("removeTask drops a cancelled task but leaves active ones alone", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // block first task

    await enqueueBatch(TEST_ID, [
      { sourcePath: "first.md", folderContext: "" },
      { sourcePath: "second.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    const second = getQueue().find((t) => t.sourcePath === "second.md")!
    await cancelTask(second.id)
    expect(await removeTask(second.id)).toBe(true)
    expect(getQueue().some((t) => t.sourcePath === "second.md")).toBe(false)

    // Processing tasks are not removable — cancel them first.
    const first = getQueue().find((t) => t.sourcePath === "first.md")!
    expect(await removeTask(first.id)).toBe(false)
    expect(getQueue().some((t) => t.sourcePath === "first.md")).toBe(true)
  })

  it("removeTask drops a failed task and persists the removal", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: "ingest-failed-a", sourcePath: "a.md", folderContext: "", status: "failed", addedAt: 1, error: "boom", retryCount: 3 },
      { id: "ingest-failed-b", sourcePath: "b.md", folderContext: "", status: "failed", addedAt: 2, error: "boom", retryCount: 3 },
    ]))
    await restoreQueue(TEST_ID, TEST_PATH)
    mockWriteFile.mockClear()

    expect(await removeTask("ingest-failed-a")).toBe(true)
    expect(getQueue().map((t) => t.id)).toEqual(["ingest-failed-b"])
    const calls = mockWriteFile.mock.calls
    const [path, snapshot] = calls[calls.length - 1]
    expect(path).toBe(`${TEST_PATH}/.llm-wiki/ingest-queue.json`)
    // Not just "the removed ID is gone" — a snapshot of `[]` would satisfy that
    // while silently losing the survivor on the next restore.
    expect(JSON.parse(snapshot).map((t: { id: string }) => t.id))
      .toEqual(["ingest-failed-b"])
  })

  it("removeTask refuses a cancelled task whose run has not exited yet", async () => {
    // autoIngest never settles, so the run keeps its slot in activeRuns even
    // after the abort. Status is "cancelled" but the worker is still alive.
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await enqueueBatch(TEST_ID, [{ sourcePath: "in-flight.md", folderContext: "" }])
    await flushMicrotasks(2)

    const task = getQueue().find((t) => t.sourcePath === "in-flight.md")!
    expect(task.status).toBe("processing")
    await cancelTask(task.id)
    expect(getQueue().find((t) => t.id === task.id)!.status).toBe("cancelled")

    // Removing now would free the sourcePath for a re-import, and the new task
    // would get a fresh ID that processNext's activeRuns guard cannot match.
    expect(await removeTask(task.id)).toBe(false)
    expect(await removeTasks([task.id])).toBe(0)
    expect(getQueue().some((t) => t.id === task.id)).toBe(true)
  })

  it("removeTasks drops only the stopped tasks in the selection", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // block first task

    await enqueueBatch(TEST_ID, [
      { sourcePath: "processing.md", folderContext: "" },
      { sourcePath: "cancelled.md", folderContext: "" },
      { sourcePath: "pending.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    const cancelled = getQueue().find((t) => t.sourcePath === "cancelled.md")!
    await cancelTask(cancelled.id)

    const removed = await removeTasks(getQueue().map((t) => t.id))
    expect(removed).toBe(1)
    expect(getQueue().map((t) => t.sourcePath)).toEqual(["processing.md", "pending.md"])

    // Unknown IDs and an empty selection are no-ops, not throws.
    expect(await removeTasks(["ingest-does-not-exist"])).toBe(0)
    expect(await removeTasks([])).toBe(0)
  })

  it("retainQueuedSelection keeps rows the core refused to remove", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // block first task

    await enqueueBatch(TEST_ID, [
      { sourcePath: "stuck.md", folderContext: "" },
      { sourcePath: "gone.md", folderContext: "" },
      { sourcePath: "kept.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    const stuck = getQueue().find((t) => t.sourcePath === "stuck.md")!
    const gone = getQueue().find((t) => t.sourcePath === "gone.md")!
    const kept = getQueue().find((t) => t.sourcePath === "kept.md")!

    await cancelTask(stuck.id) // cancelled, but its run never settles
    await cancelTask(gone.id)
    expect(await removeTask(gone.id)).toBe(true)

    const next = retainQueuedSelection(new Set([stuck.id, gone.id, kept.id]), getQueue())
    expect(next.has(gone.id)).toBe(false) // actually removed
    expect(next.has(stuck.id)).toBe(true) // guard refused it — must stay selected
    expect(next.has(kept.id)).toBe(true) // untouched
    // ...and the panel hides its remove button rather than offering a no-op.
    expect(hasActiveRun(stuck.id)).toBe(true)
    expect(hasActiveRun(kept.id)).toBe(false)

    // Unchanged membership returns the same Set so React can skip the update.
    const unchanged = new Set([stuck.id, kept.id])
    expect(retainQueuedSelection(unchanged, getQueue())).toBe(unchanged)
  })

  it("batch-cancelled tasks can be batch-restarted", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch(TEST_ID, [
      { sourcePath: "active.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
    ])
    await flushMicrotasks(2)
    const stopped = getQueue().filter((task) => task.status === "pending")

    expect(await cancelTasks(stopped.map((task) => task.id))).toBe(2)
    expect(getQueue().filter((task) => task.status === "cancelled")).toHaveLength(2)
    expect(await retryTasks(stopped.map((task) => task.id))).toBe(2)
    expect(getQueue().filter((task) => task.status === "pending")).toHaveLength(2)
  })

  it("enqueueing a cancelled source restarts the retained task without duplication", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch(TEST_ID, [
      { sourcePath: "active.md", folderContext: "" },
      { sourcePath: "cancelled.md", folderContext: "old" },
    ])
    await flushMicrotasks(2)
    const stopped = getQueue().find((task) => task.sourcePath === "cancelled.md")!
    await cancelTask(stopped.id)

    const restartedId = await enqueueIngest(TEST_ID, "cancelled.md", "new")

    expect(restartedId).toBe(stopped.id)
    expect(getQueue().filter((task) => task.sourcePath === "cancelled.md")).toHaveLength(1)
    expect(getQueue().find((task) => task.id === stopped.id)).toMatchObject({
      status: "pending",
      folderContext: "new",
    })
  })

  it("discards an old in-flight result when a cancelled task is immediately restarted", async () => {
    let finishOldRun: ((files: string[]) => void) | undefined
    mockAutoIngest
      .mockImplementationOnce(
        () => new Promise<string[]>((resolve) => {
          finishOldRun = resolve
        }),
      )
      .mockResolvedValueOnce(["wiki/restart-new.md"])

    await enqueueIngest(TEST_ID, "restart.md")
    await flushMicrotasks(2)
    const task = getQueue()[0]
    await cancelTask(task.id)
    await retryTasks([task.id])

    // Simulate a provider that ignores AbortSignal and completes the old run.
    finishOldRun?.(["wiki/restart.md"])
    await vi.waitFor(() => expect(mockAutoIngest).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(getQueue()).toHaveLength(0))

    expect(getQueueSummary().completed).toBe(1)
  })

  it("moves pending task priority without crossing the processing task", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch(TEST_ID, [
      { sourcePath: "active.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
      { sourcePath: "d.md", folderContext: "" },
    ])
    await flushMicrotasks(2)
    const d = getQueue().find((task) => task.sourcePath === "d.md")!

    expect(await movePendingTask(d.id, "up")).toBe(true)
    expect(getQueue().map((task) => task.sourcePath)).toEqual([
      "active.md",
      "b.md",
      "d.md",
      "c.md",
    ])
  })
})

describe("ingest-queue — cancelAllTasks", () => {
  it("retains pending and processing tasks as cancelled alongside failed ones", async () => {
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

    expect(removed).toBe(2)
    expect(getQueue()).toHaveLength(3)
    expect(getQueue().map((task) => task.status)).toEqual(["cancelled", "cancelled", "failed"])
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
    expect(summary.completed).toBe(0)
    expect(summary.pending).toBe(0)
    expect(summary.total).toBe(1)
  })

  it("tracks successful completions until a new idle queue starts", async () => {
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])
    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(40)

    expect(getQueueSummary()).toMatchObject({ completed: 2, failed: 0, total: 2 })

    await enqueueIngest(TEST_ID, "c.md")
    await flushMicrotasks(20)

    expect(getQueueSummary()).toMatchObject({ completed: 1, failed: 0, total: 1 })
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
    await waitFor(() => mockSweep.mock.calls.length === 1)
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

  it("restarts an interrupted processing task on restore", async () => {
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
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(2)

    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("processing")
    expect(getQueueSummary().paused).toBe(false)
    expect(mockAutoIngest).toHaveBeenCalledTimes(1)
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
    await flushMicrotasks(2)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].projectId).toBe(TEST_ID)
    expect(queue[0].status).toBe("processing")
    expect(mockAutoIngest).toHaveBeenCalledTimes(1)
  })

  it("automatically resumes restored pending tasks", async () => {
    const saved = [
      {
        id: "ingest-restored",
        sourcePath: "restored.md",
        folderContext: "",
        status: "pending",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    mockAutoIngest.mockResolvedValue(["wiki/sources/restored.md"])

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(10)

    expect(mockAutoIngest).toHaveBeenCalledTimes(1)
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary().paused).toBe(false)
  })

  it("keeps restored tasks pending when the ingest model is not configured", async () => {
    const { useWikiStore } = await import("@/stores/wiki-store")
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    mockReadFile.mockResolvedValue(JSON.stringify([
      {
        id: "pending-a",
        sourcePath: "a.md",
        folderContext: "",
        status: "pending",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
      {
        id: "pending-b",
        sourcePath: "b.md",
        folderContext: "",
        status: "pending",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]))

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(4)

    expect(getQueue().map((task) => task.status)).toEqual(["pending", "pending"])
    expect(getQueueSummary().blockedOnLlmConfig).toBe(true)
    expect(mockAutoIngest).not.toHaveBeenCalled()

    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "configured",
      model: "model",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    mockAutoIngest.mockResolvedValue(["wiki/sources/restored.md"])
    resumeProcessing()
    await flushMicrotasks(20)

    expect(mockAutoIngest).toHaveBeenCalledTimes(2)
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary().blockedOnLlmConfig).toBe(false)
  })

  it("finishes restored backlog before accepting a new live task", async () => {
    const saved = [
      {
        id: "ingest-restored",
        sourcePath: "restored.md",
        folderContext: "",
        status: "pending",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    mockAutoIngest.mockImplementation(async (_projectPath, sourcePath) => [
      `wiki/sources/${String(sourcePath).replace(/\.md$/, "")}.md`,
    ])

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(2)
    await enqueueIngest(TEST_ID, "live.md")
    await flushMicrotasks(10)

    expect(mockAutoIngest).toHaveBeenCalledTimes(2)
    expect(mockAutoIngest.mock.calls[0][1]).toBe(`${TEST_PATH}/restored.md`)
    expect(mockAutoIngest.mock.calls[1][1]).toBe(`${TEST_PATH}/live.md`)
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary().paused).toBe(false)
  })

  it("reports an automatically restored task as active processing", async () => {
    const saved = [
      {
        id: "ingest-restored",
        sourcePath: "restored.md",
        folderContext: "",
        status: "pending",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(2)
    expect(getQueueSummary()).toMatchObject({
      processing: 1,
      paused: false,
      userPaused: false,
    })
  })

  it("queues a rerun when a live event touches a restored task already processing", async () => {
    const saved = [
      {
        id: "ingest-restored",
        sourcePath: "same.md",
        folderContext: "",
        status: "pending",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    const firstRun = createDeferred<string[]>()
    mockAutoIngest
      .mockImplementationOnce(() => firstRun.promise)
      .mockResolvedValueOnce(["wiki/sources/same.md"])

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(2)
    await enqueueIngest(TEST_ID, "same.md")
    await flushMicrotasks(2)

    expect(mockAutoIngest).toHaveBeenCalledTimes(1)
    expect(getQueue().filter((task) => task.status === "pending")).toHaveLength(1)

    firstRun.resolve(["wiki/sources/same.md"])
    await flushMicrotasks(10)

    expect(mockAutoIngest).toHaveBeenCalledTimes(2)
    expect(mockAutoIngest.mock.calls[0][1]).toBe(`${TEST_PATH}/same.md`)
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary().paused).toBe(false)
  })
})

import { pauseQueue } from "./ingest-queue"

describe("ingest-queue — pauseQueue & switch-project survival", () => {
  it("waits for an active commit before completing a project switch", async () => {
    const commit = createDeferred<void>()
    let commitStarted = false
    mockAutoIngest.mockImplementation(
      async (_projectPath, _sourcePath, _config, _signal, _folder, _onFileWritten, options) => {
        await options?.runCommit?.(async () => {
          commitStarted = true
          await commit.promise
        })
        return ["wiki/sources/committed.md"]
      },
    )

    await enqueueIngest(TEST_ID, "committing.md")
    await waitFor(() => commitStarted)
    let pauseFinished = false
    const pause = pauseQueue().then(() => { pauseFinished = true })
    await flushMicrotasks(5)
    expect(pauseFinished).toBe(false)

    commit.resolve()
    await pause
    expect(pauseFinished).toBe(true)
  })

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

describe("ingest-queue — pause/resume processing", () => {
  it("aborts the in-flight task and does not start the next while paused", async () => {
    mockAutoIngest.mockImplementationOnce(
      (_projectPath, _sourcePath, _llmConfig, signal) =>
        new Promise<string[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)
    expect(getQueue().find((t) => t.sourcePath === "a.md")?.status).toBe("processing")

    // Pause while a.md is in flight — it should be aborted and returned
    // to pending; no other task starts while paused.
    pauseProcessing()
    expect(isQueuePaused()).toBe(true)
    await flushMicrotasks(10)

    expect(mockAutoIngest).toHaveBeenCalledTimes(1)
    expect(getQueue().find((t) => t.sourcePath === "a.md")?.status).toBe("pending")
    expect(getQueue().find((t) => t.sourcePath === "a.md")?.retryCount).toBe(0)
    expect(getQueue().find((t) => t.sourcePath === "a.md")?.error).toBeNull()
    expect(getQueue().find((t) => t.sourcePath === "b.md")?.status).toBe("pending")
    expect(getQueueSummary().paused).toBe(true)
  })

  it("resumeProcessing restarts the queue and processes the pending task", async () => {
    mockAutoIngest.mockImplementationOnce(
      (_projectPath, _sourcePath, _llmConfig, signal) =>
        new Promise<string[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )
    mockAutoIngest.mockResolvedValue(["wiki/sources/foo.md"])

    await enqueueBatch(TEST_ID, [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)
    pauseProcessing()
    await flushMicrotasks(10)
    expect(mockAutoIngest).toHaveBeenCalledTimes(1)
    expect(getQueue().find((t) => t.sourcePath === "a.md")?.status).toBe("pending")
    expect(getQueue().find((t) => t.sourcePath === "b.md")?.status).toBe("pending")

    // Resume → aborted a.md restarts first, then b.md drains.
    resumeProcessing()
    await waitFor(() => mockAutoIngest.mock.calls.length === 3)
    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
    expect(isQueuePaused()).toBe(false)
  })

  it("does not run the drain-sweep while paused (no token spend)", async () => {
    mockAutoIngest.mockImplementationOnce(
      (_projectPath, _sourcePath, _llmConfig, signal) =>
        new Promise<string[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )

    await enqueueIngest(TEST_ID, "only.md")
    await flushMicrotasks(2)
    pauseProcessing()
    await flushMicrotasks(10)

    // The task is back to pending and no drain sweep runs while paused.
    expect(getQueue().find((t) => t.sourcePath === "only.md")?.status).toBe("pending")
    expect(mockSweep).not.toHaveBeenCalled()
    expect(isQueuePaused()).toBe(true)
  })

  it("does not start a duplicate runner if resumed before the abort settles", async () => {
    let rejectFirst: (err: Error) => void = () => {}
    mockAutoIngest.mockImplementationOnce(
      (_projectPath, _sourcePath, _llmConfig, signal) =>
        new Promise<string[]>((_resolve, reject) => {
          rejectFirst = reject
          signal?.addEventListener("abort", () => {})
        }),
    )
    mockAutoIngest.mockResolvedValue(["wiki/sources/next.md"])

    await enqueueIngest(TEST_ID, "only.md")
    await flushMicrotasks(2)
    pauseProcessing()
    expect(isQueuePaused()).toBe(true)
    expect(getQueue().find((t) => t.sourcePath === "only.md")?.status).toBe("pending")

    resumeProcessing()
    await flushMicrotasks(5)
    expect(mockAutoIngest).toHaveBeenCalledTimes(1)

    rejectFirst(new Error("aborted"))
    await flushMicrotasks(10)
    expect(isQueuePaused()).toBe(false)
    expect(mockAutoIngest).toHaveBeenCalledTimes(2)
    expect(getQueue()).toHaveLength(0)
  })

  it("clears pause when the only paused task is cancelled so future imports can run", async () => {
    mockAutoIngest.mockImplementationOnce(
      (_projectPath, _sourcePath, _llmConfig, signal) =>
        new Promise<string[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    )
    mockAutoIngest.mockResolvedValue(["wiki/sources/fresh.md"])

    await enqueueIngest(TEST_ID, "only.md")
    await flushMicrotasks(2)
    pauseProcessing()
    await flushMicrotasks(10)
    const only = getQueue().find((t) => t.sourcePath === "only.md")
    expect(only?.status).toBe("pending")
    expect(getQueueSummary().paused).toBe(true)

    await cancelTask(only!.id)
    expect(getQueueSummary().paused).toBe(false)

    await enqueueIngest(TEST_ID, "fresh.md")
    await flushMicrotasks(10)
    expect(mockAutoIngest).toHaveBeenCalledTimes(2)
    expect(mockAutoIngest.mock.calls[1][1]).toBe(`${TEST_PATH}/fresh.md`)
    expect(getQueue()).toHaveLength(1)
    expect(getQueue()[0]).toMatchObject({ sourcePath: "only.md", status: "cancelled" })
  })

  it("restoreQueue resets the paused flag — every project loads un-paused", async () => {
    pauseProcessing()
    expect(isQueuePaused()).toBe(true)

    mockReadFile.mockRejectedValue(new Error("ENOENT"))
    await restoreQueue(TEST_ID, TEST_PATH)
    expect(isQueuePaused()).toBe(false)
  })

  it("clearQueueState resets the paused flag", async () => {
    pauseProcessing()
    expect(isQueuePaused()).toBe(true)
    clearQueueState()
    expect(isQueuePaused()).toBe(false)
  })

  it("auto-pauses on provider usage limits and resumes later without burning retries", async () => {
    vi.useFakeTimers()
    try {
      mockAutoIngest
        .mockRejectedValueOnce(new Error("429 rate limit exceeded"))
        .mockResolvedValueOnce(["wiki/sources/only.md"])

      await enqueueIngest(TEST_ID, "only.md")
      await flushMicrotasks(10)

      const pausedTask = getQueue().find((t) => t.sourcePath === "only.md")
      expect(pausedTask?.status).toBe("pending")
      expect(pausedTask?.retryCount).toBe(0)
      expect(pausedTask?.error).toContain("Paused after provider usage limit")
      expect(getQueueSummary().paused).toBe(true)
      expect(mockAutoIngest).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      await flushMicrotasks(10)

      expect(mockAutoIngest).toHaveBeenCalledTimes(2)
      expect(getQueue()).toHaveLength(0)
      expect(getQueueSummary().paused).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── cleanupWrittenFiles — centralized page cascade ─────────────────
describe("cleanupWrittenFiles — page cascade", () => {
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

    expect(cascadeDeleteWikiPageMock).toHaveBeenCalledTimes(2)
    expect(cascadeDeleteWikiPageMock).toHaveBeenNthCalledWith(1, "/proj", "/proj/wiki/concepts/rope.md")
    expect(cascadeDeleteWikiPageMock).toHaveBeenNthCalledWith(2, "/proj", "/proj/wiki/entities/transformer.md")
  })

  it("uses absolute paths verbatim (doesn't double-prefix the project path)", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    await cleanupWrittenFiles("/proj", ["/abs/elsewhere/wiki/concepts/foo.md"])

    expect(mockDeleteFile).toHaveBeenCalledWith("/abs/elsewhere/wiki/concepts/foo.md")
    expect(cascadeDeleteWikiPageMock).toHaveBeenCalledWith(
      "/proj",
      "/abs/elsewhere/wiki/concepts/foo.md",
    )
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
    // Both cascades were attempted even though the first delete failed.
    expect(cascadeDeleteWikiPageMock).toHaveBeenCalledTimes(2)
    expect(cascadeDeleteWikiPageMock).toHaveBeenNthCalledWith(
      2,
      "/proj",
      "/proj/wiki/concepts/present.md",
    )
  })

  it("swallows page cascade errors so a LanceDB issue doesn't abort cleanup", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    // First page cascade throws; second succeeds.
    cascadeDeleteWikiPageMock
      .mockImplementationOnce(async (_projectPath, filePath) => {
        await mockDeleteFile(filePath)
        throw new Error("lancedb unavailable")
      })
      .mockImplementationOnce(async (_projectPath, filePath) => {
        await mockDeleteFile(filePath)
      })

    await cleanupWrittenFiles("/proj", [
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
    ])

    // Second cascade still attempted despite first throwing.
    expect(cascadeDeleteWikiPageMock).toHaveBeenCalledTimes(2)
  })

  it("passes Windows backslash paths to the centralized cascade", async () => {
    const { deleteFile } = await import("@/commands/fs")
    const mockDeleteFile = vi.mocked(deleteFile)
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)

    // The centralized cascade owns path normalization and page-id derivation.
    await cleanupWrittenFiles("C:/proj", ["wiki\\concepts\\rope.md"])

    expect(cascadeDeleteWikiPageMock).toHaveBeenCalledWith(
      "C:/proj",
      "C:/proj/wiki\\concepts\\rope.md",
    )
  })
})
