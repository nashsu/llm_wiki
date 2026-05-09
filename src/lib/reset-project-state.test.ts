import { describe, it, expect, beforeEach, vi } from "vitest"
import { resetProjectState } from "./reset-project-state"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useResearchStore } from "@/stores/research-store"
import { getQueue, pauseQueue } from "./ingest-queue"

// Dynamic-import mocks: resetProjectState uses `import("@/lib/ingest-queue")`
// and `import("@/lib/graph-relevance")` at runtime. vi.mock hoists these
// so the promise resolves to our stub immediately.
vi.mock("./ingest-queue", async () => {
  const actual = await vi.importActual<typeof import("./ingest-queue")>("./ingest-queue")
  return {
    ...actual,
    pauseQueue: vi.fn(async () => {}),
  }
})

vi.mock("./graph-relevance", () => ({
  clearGraphCache: vi.fn(),
}))

import { clearGraphCache } from "./graph-relevance"

const mockPauseQueue = vi.mocked(pauseQueue)
const mockClearGraphCache = vi.mocked(clearGraphCache)

beforeEach(() => {
  mockPauseQueue.mockReset()
  mockPauseQueue.mockImplementation(async () => {})
  mockClearGraphCache.mockReset()
})

describe("resetProjectState — Zustand stores", () => {
  it("clears chat store conversations and messages", async () => {
    useChatStore.setState({
      conversations: [{ id: "c1", title: "x", createdAt: 0, updatedAt: 0 }],
      messages: [
        { id: "m1", role: "user", content: "hi", timestamp: 0, conversationId: "c1" },
      ],
      activeConversationId: "c1",
      isStreaming: true,
      streamingContent: "partial",
      mode: "ingest",
      ingestSource: "/some/file",
    })

    await resetProjectState()

    const chat = useChatStore.getState()
    expect(chat.conversations).toEqual([])
    expect(chat.messages).toEqual([])
    expect(chat.activeConversationId).toBeNull()
    expect(chat.isStreaming).toBe(false)
    expect(chat.streamingContent).toBe("")
    expect(chat.mode).toBe("chat")
    expect(chat.ingestSource).toBeNull()
  })

  it("clears review store items", async () => {
    useReviewStore.setState({
      items: [
        {
          id: "r1",
          projectId: "proj-1",
          projectPath: "/project-1",
          type: "missing-page",
          title: "x",
          description: "",
          options: [],
          resolved: false,
          createdAt: 0,
        },
      ],
    })

    await resetProjectState()
    expect(useReviewStore.getState().items).toEqual([])
  })

  it("clears activity store items", async () => {
    useActivityStore.setState({
      items: [
        {
          id: "a1",
          type: "query",
          title: "t",
          status: "done",
          detail: "",
          filesWritten: [],
          createdAt: 0,
        },
      ],
    })

    await resetProjectState()
    expect(useActivityStore.getState().items).toEqual([])
  })

  it("clears research store tasks and closes panel", async () => {
    useResearchStore.setState({
      tasks: [
        {
          id: "t1",
          type: "gap",
          topic: "x",
          searchQueries: [],
          status: "pending",
          createdAt: 0,
        } as unknown as ReturnType<typeof useResearchStore.getState>["tasks"][number],
      ],
      panelOpen: true,
    })

    await resetProjectState()
    expect(useResearchStore.getState().tasks).toEqual([])
    expect(useResearchStore.getState().panelOpen).toBe(false)
  })
})

describe("resetProjectState — module-level caches are awaited", () => {
  it("calls pauseQueue before the returned promise resolves", async () => {
    await resetProjectState()
    expect(mockPauseQueue).toHaveBeenCalledOnce()
  })

  it("calls clearGraphCache before the returned promise resolves", async () => {
    await resetProjectState()
    expect(mockClearGraphCache).toHaveBeenCalledOnce()
  })

  it("ordering: when resolve() fires, BOTH module caches are already cleared", async () => {
    // This is the regression guard against fire-and-forget resets.
    // By the time the outer await returns, BOTH clears must be done.
    await resetProjectState()
    expect(mockPauseQueue).toHaveBeenCalledOnce()
    expect(mockClearGraphCache).toHaveBeenCalledOnce()
  })

  it("does not throw when pauseQueue itself throws — logs and continues", async () => {
    mockPauseQueue.mockImplementationOnce(async () => {
      throw new Error("boom")
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(resetProjectState()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    expect(mockClearGraphCache).toHaveBeenCalledOnce() // still runs despite sibling failure
    warnSpy.mockRestore()
  })

  it("does not throw when clearGraphCache itself throws", async () => {
    mockClearGraphCache.mockImplementationOnce(() => {
      throw new Error("boom")
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(resetProjectState()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe("resetProjectState — leaves unrelated store keys alone", () => {
  it("preserves maxHistoryMessages on chat store (config, not project data)", async () => {
    useChatStore.setState({ maxHistoryMessages: 42 })
    await resetProjectState()
    expect(useChatStore.getState().maxHistoryMessages).toBe(42)
  })
})

// Silence the "unused import" warning on getQueue (kept for potential future tests).
void getQueue
