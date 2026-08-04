import { describe, it, expect, beforeEach, vi } from "vitest"
import type { IngestTask } from "@/api/ingest"

const mocks = vi.hoisted(() => ({
  getQueue: vi.fn(),
  enqueueByPath: vi.fn(),
  cancelTask: vi.fn(),
  retryTask: vi.fn(),
  clearQueue: vi.fn(),
}))

vi.mock("@/api/ingest", () => ({
  getQueue: mocks.getQueue,
  enqueueByPath: mocks.enqueueByPath,
  cancelTask: mocks.cancelTask,
  retryTask: mocks.retryTask,
  clearQueue: mocks.clearQueue,
}))

import { useServerIngestStore } from "./server-ingest-store"
import { useWikiStore } from "./wiki-store"

function task(overrides: Partial<IngestTask>): IngestTask {
  return {
    id: 1,
    project_id: 1,
    file_path: "raw/sources/a.md",
    status: "pending",
    progress: 0,
    error: null,
    created_at: 0,
    attempt_count: 0,
    not_before: 0,
    folder_context: "",
    ...overrides,
  }
}

const PROJECT = { id: "uuid-A", name: "A", path: "/tmp/a" }

beforeEach(() => {
  vi.clearAllMocks()
  useServerIngestStore.getState().reset()
  useWikiStore.getState().setProject(PROJECT)
  mocks.getQueue.mockResolvedValue({ tasks: [], count: 0 })
  mocks.enqueueByPath.mockResolvedValue({ taskId: 1, filePath: "raw/sources/a.md", status: "pending" })
  mocks.cancelTask.mockResolvedValue(undefined)
  mocks.retryTask.mockResolvedValue({ ok: true })
  mocks.clearQueue.mockResolvedValue({ cleared: 1 })
})

describe("server-ingest-store — loadQueue", () => {
  it("loads tasks and derives running/lastError", async () => {
    mocks.getQueue.mockResolvedValue({
      tasks: [
        task({ id: 1, status: "processing", progress: 40 }),
        task({ id: 2, status: "failed", error: "boom" }),
      ],
      count: 2,
    })

    await useServerIngestStore.getState().loadQueue("uuid-A")

    const st = useServerIngestStore.getState()
    expect(mocks.getQueue).toHaveBeenCalledWith("uuid-A", { limit: 200 })
    expect(st.tasks).toHaveLength(2)
    expect(st.loadedFor).toBe("uuid-A")
    expect(st.running).toBe(true)
    expect(st.lastError).toBe("boom")
  })

  it("is not running when only terminal tasks remain", async () => {
    mocks.getQueue.mockResolvedValue({
      tasks: [task({ id: 1, status: "completed" }), task({ id: 2, status: "failed", error: "x" })],
      count: 2,
    })

    await useServerIngestStore.getState().loadQueue("uuid-A")

    const st = useServerIngestStore.getState()
    expect(st.running).toBe(false)
    expect(st.lastError).toBe("x")
  })

  it("keeps prior state when the server is unreachable", async () => {
    mocks.getQueue.mockRejectedValue(new Error("network down"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await useServerIngestStore.getState().loadQueue("uuid-A")

    expect(useServerIngestStore.getState().loadedFor).toBeNull()
    warn.mockRestore()
  })
})

describe("server-ingest-store — mutations", () => {
  it("enqueue posts to the active project and refreshes", async () => {
    const res = await useServerIngestStore.getState().enqueue("raw/sources/a.md", "ctx")
    expect(res).toMatchObject({ taskId: 1 })
    expect(mocks.enqueueByPath).toHaveBeenCalledWith("uuid-A", "raw/sources/a.md", "ctx")
    expect(mocks.getQueue).toHaveBeenCalledWith("uuid-A", { limit: 200 })
  })

  it("enqueue is a no-op without an active project", async () => {
    useWikiStore.getState().setProject(null)
    const res = await useServerIngestStore.getState().enqueue("raw/sources/a.md")
    expect(res).toBeNull()
    expect(mocks.enqueueByPath).not.toHaveBeenCalled()
  })

  it("cancel and retry target the active project and refresh", async () => {
    await useServerIngestStore.getState().cancel(7)
    expect(mocks.cancelTask).toHaveBeenCalledWith("uuid-A", 7)
    await useServerIngestStore.getState().retry(8)
    expect(mocks.retryTask).toHaveBeenCalledWith("uuid-A", 8)
    expect(mocks.getQueue).toHaveBeenCalled()
  })

  it("retryAllFailed retries only failed tasks and returns the count", async () => {
    useServerIngestStore.setState({
      tasks: [
        task({ id: 1, status: "failed" }),
        task({ id: 2, status: "pending" }),
        task({ id: 3, status: "failed" }),
      ],
      loadedFor: "uuid-A",
    })

    const requeued = await useServerIngestStore.getState().retryAllFailed()

    expect(requeued).toBe(2)
    expect(mocks.retryTask).toHaveBeenCalledWith("uuid-A", 1)
    expect(mocks.retryTask).toHaveBeenCalledWith("uuid-A", 3)
    expect(mocks.retryTask).not.toHaveBeenCalledWith("uuid-A", 2)
  })

  it("clearFinished clears completed and failed by default", async () => {
    await useServerIngestStore.getState().clearFinished()
    expect(mocks.clearQueue).toHaveBeenCalledWith("uuid-A", "completed")
    expect(mocks.clearQueue).toHaveBeenCalledWith("uuid-A", "failed")
  })

  it("clearFinished honors an explicit status", async () => {
    await useServerIngestStore.getState().clearFinished("completed")
    expect(mocks.clearQueue).toHaveBeenCalledTimes(1)
    expect(mocks.clearQueue).toHaveBeenCalledWith("uuid-A", "completed")
  })
})

describe("server-ingest-store — SSE feed", () => {
  it("patchTask merges into the matching task", () => {
    useServerIngestStore.setState({
      tasks: [task({ id: 1, status: "pending" })],
      loadedFor: "uuid-A",
    })

    useServerIngestStore.getState().patchTask(1, { status: "processing", progress: 55 })

    const st = useServerIngestStore.getState()
    expect(st.tasks[0]).toMatchObject({ status: "processing", progress: 55 })
    expect(st.running).toBe(true)
  })

  it("patchTask on an unknown task refreshes the queue instead", () => {
    useServerIngestStore.setState({ tasks: [], loadedFor: "uuid-A" })

    useServerIngestStore.getState().patchTask(99, { status: "processing" })

    expect(mocks.getQueue).toHaveBeenCalledWith("uuid-A", { limit: 200 })
  })

  it("reset drops all state without touching the server", () => {
    useServerIngestStore.setState({
      tasks: [task({ id: 1 })],
      running: true,
      lastError: "x",
      loadedFor: "uuid-A",
    })

    useServerIngestStore.getState().reset()

    const st = useServerIngestStore.getState()
    expect(st.tasks).toEqual([])
    expect(st.running).toBe(false)
    expect(st.lastError).toBeNull()
    expect(st.loadedFor).toBeNull()
    expect(mocks.cancelTask).not.toHaveBeenCalled()
    expect(mocks.retryTask).not.toHaveBeenCalled()
  })
})
