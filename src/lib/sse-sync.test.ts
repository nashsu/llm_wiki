// SSE sync layer tests (SSE taxonomy stage 6).
//
// Drives the real dispatch pipeline: startSseSync() opens the (mocked)
// connection, and the captured event listener receives server frames exactly
// as connectEvents would deliver them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/events", () => ({
  connectEvents: vi.fn(),
}))
vi.mock("@/api/client", () => ({
  request: vi.fn(),
}))
vi.mock("@/api/settings", () => ({
  getSettings: vi.fn().mockResolvedValue({}),
}))
vi.mock("@/api/projects", () => ({
  listProjects: vi.fn(),
}))
vi.mock("@/lib/project-file-tree-refresh", () => ({
  refreshProjectFileTree: vi.fn(),
}))

import { connectEvents, type ServerEvent } from "@/api/events"
import { request } from "@/api/client"
import { listProjects } from "@/api/projects"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { startSseSync, stopSseSync } from "./sse-sync"

const mockConnectEvents = vi.mocked(connectEvents)
const mockRequest = vi.mocked(request)
const mockListProjects = vi.mocked(listProjects)
const mockRefreshTree = vi.mocked(refreshProjectFileTree)

let listener: ((evt: ServerEvent) => void) | null = null

function requireListener(): (evt: ServerEvent) => void {
  if (!listener) throw new Error("SSE listener not registered yet")
  return listener
}

async function startSync(): Promise<(evt: ServerEvent) => void> {
  startSseSync()
  await vi.waitFor(() => requireListener())
  return requireListener()
}

beforeEach(() => {
  listener = null
  mockConnectEvents.mockReset()
  mockConnectEvents.mockImplementation((onEvent) => {
    listener = onEvent
    return () => {
      listener = null
    }
  })
  mockRequest.mockReset()
  mockRequest.mockImplementation(async (url: unknown) => {
    const u = String(url)
    if (u.startsWith("/api/v2/health")) return { ok: true, version: "1.0.0" }
    if (u === "/api/v2/projects") {
      return {
        projects: [
          { id: 7, uuid: "uuid-1", name: "Test", path: "/proj", owner_id: null, created_at: 0, updated_at: 0 },
        ],
      }
    }
    if (u.includes("/ingest")) return { tasks: [] }
    return {}
  })
  mockListProjects.mockReset()
  mockListProjects.mockResolvedValue({
    projects: [
      { id: 7, uuid: "uuid-1", name: "Test", path: "/proj", owner_id: null, created_at: 0, updated_at: 0 },
    ],
  })
  mockRefreshTree.mockReset()
  mockRefreshTree.mockResolvedValue(undefined)

  useChatStore.setState({
    conversations: [{ id: "conv-1", title: "One", createdAt: 1, updatedAt: 1 }],
    activeConversationId: "conv-1",
    messages: [],
    isStreaming: false,
    streamingContent: "",
    ownedRunIds: [],
    ownedRunsByConversation: {},
  })
  useWikiStore.setState({
    project: { id: "uuid-1", name: "Test", path: "/proj" },
    dataVersion: 0,
  })
})

afterEach(() => {
  stopSseSync()
  vi.useRealTimers()
})

describe("sse-sync chat scoping (SSE taxonomy stage 6)", () => {
  it("drops frames for sessions not present in the chat store", async () => {
    const dispatch = await startSync()
    dispatch({ event: "chat:delta", payload: { sessionId: "unknown-session", runId: "r-1", text: "hello" } })
    dispatch({ event: "chat:done", payload: { sessionId: "unknown-session", runId: "r-1", content: "hello" } })

    const state = useChatStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.streamingContent).toBe("")
    expect(state.messages).toEqual([])
  })

  it("accepts the active conversation even if it is missing from the list", async () => {
    const dispatch = await startSync()
    // Active id present but not (yet) materialized in the conversations list,
    // e.g. a server-created session during the sidebar re-sync window.
    useChatStore.setState({ conversations: [], activeConversationId: "conv-1" })

    dispatch({ event: "chat:delta", payload: { sessionId: "conv-1", runId: "srv-run", text: "hi" } })

    expect(useChatStore.getState().streamingContent).toBe("hi")
  })

  it("skips frames for runIds owned by this tab (no double-apply)", async () => {
    const dispatch = await startSync()
    useChatStore.getState().registerOwnedRun("ui-1-1", "conv-1")

    dispatch({ event: "chat:delta", payload: { sessionId: "conv-1", runId: "ui-1-1", text: "tok" } })
    dispatch({
      event: "chat:done",
      payload: { sessionId: "conv-1", runId: "ui-1-1", content: "full answer", references: [] },
    })

    const state = useChatStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.streamingContent).toBe("")
    expect(state.messages).toEqual([])
  })

  it("applies a foreign-tab run: deltas append tokens, done finalizes the conversation", async () => {
    const dispatch = await startSync()

    dispatch({ event: "chat:delta", payload: { sessionId: "conv-1", runId: "srv-run", projectId: 7, text: "Hel" } })
    let state = useChatStore.getState()
    expect(state.isStreaming).toBe(true)
    expect(state.streamingContent).toBe("Hel")

    dispatch({ event: "chat:delta", payload: { sessionId: "conv-1", runId: "srv-run", projectId: 7, text: "lo" } })
    expect(useChatStore.getState().streamingContent).toBe("Hello")

    dispatch({
      event: "chat:done",
      payload: {
        sessionId: "conv-1",
        runId: "srv-run",
        projectId: 7,
        content: "Hello world",
        references: [{ title: "Page", path: "wiki/page.md", kind: "wiki", snippet: "snip" }],
      },
    })

    state = useChatStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.streamingContent).toBe("")
    const messages = state.messages.filter((m) => m.conversationId === "conv-1")
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("assistant")
    expect(messages[0].content).toBe("Hello world")
    expect(messages[0].references).toEqual([
      { title: "Page", path: "wiki/page.md", kind: "wiki", snippet: "snip" },
    ])
  })

  it("keeps the legacy delta key fallbacks (token/delta/content) and legacy event name", async () => {
    const dispatch = await startSync()

    dispatch({ event: "chat:delta", payload: { sessionId: "conv-1", runId: "srv-run", token: "a" } })
    dispatch({ event: "chat:delta", payload: { sessionId: "conv-1", runId: "srv-run", delta: "b" } })
    // Legacy Tauri-style name from the events.js bridge generation.
    dispatch({ event: "chat://token", payload: { sessionId: "conv-1", runId: "srv-run", content: "c" } })

    expect(useChatStore.getState().streamingContent).toBe("abc")
  })

  it("chat:toolStart / chat:toolEnd are explicit no-ops (taxonomy fidelity on the wire)", async () => {
    const dispatch = await startSync()

    dispatch({
      event: "chat:toolStart",
      payload: { sessionId: "conv-1", runId: "srv-run", projectId: 7, tool: "wiki.search", input: "query" },
    })
    dispatch({
      event: "chat:toolEnd",
      payload: { sessionId: "conv-1", runId: "srv-run", projectId: 7, tool: "wiki.search", output: "ok" },
    })

    const state = useChatStore.getState()
    expect(state.isStreaming).toBe(false)
    expect(state.streamingContent).toBe("")
    expect(state.messages).toEqual([])
  })
})

describe("sse-sync file refresh debounce (SSE taxonomy stage 6)", () => {
  it("trailing-debounces file:* refreshWiki (~400 ms) and coalesces bursts", async () => {
    const dispatch = await startSync()
    vi.useFakeTimers()

    dispatch({ event: "file:created", payload: { projectId: 7, path: "wiki/a.md" } })
    dispatch({ event: "file:modified", payload: { projectId: 7, path: "wiki/b.md" } })
    dispatch({ event: "file:deleted", payload: { projectId: 7, path: "raw/c.txt" } })
    expect(mockRefreshTree).not.toHaveBeenCalled()

    vi.advanceTimersByTime(399)
    expect(mockRefreshTree).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(mockRefreshTree).toHaveBeenCalledTimes(1)
    expect(mockRefreshTree).toHaveBeenCalledWith("/proj", { bumpDataVersion: true })

    // A later burst re-arms the trailing debounce.
    dispatch({ event: "file:modified", payload: { projectId: 7, path: "wiki/d.md" } })
    vi.advanceTimersByTime(400)
    expect(mockRefreshTree).toHaveBeenCalledTimes(2)
  })

  it("graph:updated bypasses the debounce (direct dataVersion bump)", async () => {
    const dispatch = await startSync()
    vi.useFakeTimers()

    dispatch({ event: "graph:updated", payload: { projectId: 7, nodesChanged: 2, edgesChanged: 0 } })

    expect(useWikiStore.getState().dataVersion).toBe(1)
    expect(mockRefreshTree).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(mockRefreshTree).not.toHaveBeenCalled()
  })

  it("ingest:complete keeps its direct refresh (not debounced)", async () => {
    const dispatch = await startSync()

    dispatch({ event: "ingest:complete", payload: { projectId: 7 } })
    await vi.waitFor(() => {
      expect(mockRefreshTree).toHaveBeenCalledTimes(1)
    })
    expect(mockRefreshTree).toHaveBeenCalledWith("/proj", { bumpDataVersion: true })

    // Nothing re-fires later: the refresh was direct, not the file debounce.
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockRefreshTree).toHaveBeenCalledTimes(1)
  })

  it("stopSseSync cancels a pending file-refresh debounce", async () => {
    const dispatch = await startSync()
    vi.useFakeTimers()

    dispatch({ event: "file:created", payload: { projectId: 7, path: "wiki/a.md" } })
    stopSseSync()
    vi.advanceTimersByTime(1000)

    expect(mockRefreshTree).not.toHaveBeenCalled()
  })
})
