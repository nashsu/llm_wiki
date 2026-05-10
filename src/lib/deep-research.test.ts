import { beforeEach, describe, expect, it, vi } from "vitest"

const updateTask = vi.fn()
const setPanelOpen = vi.fn()
const getNextQueued = vi.fn(() => undefined)

vi.mock("./web-search", () => ({
  webSearch: vi.fn(),
}))

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(),
}))

vi.mock("./ingest", () => ({
  autoIngest: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/lib/output-language", () => ({
  buildLanguageDirective: vi.fn(() => ""),
}))

vi.mock("@/lib/document-llm", () => ({
  resolveDocumentLlmConfig: vi.fn((cfg) => cfg),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({
      project: { id: "proj-1", path: "/project-1" },
      setFileTree: vi.fn(),
      bumpDataVersion: vi.fn(),
      documentLlmConfig: null,
    }),
  },
}))

vi.mock("@/stores/research-store", () => ({
  useResearchStore: {
    getState: () => ({
      tasks: [
        {
          id: "research-1",
          projectId: "proj-1",
          projectPath: "/project-1",
          topic: "Verkle",
          searchQueries: ["verkle trees"],
          status: "error",
          webResults: [{ title: "old", url: "https://x", source: "x", snippet: "y" }],
          synthesis: "partial",
          savedPath: "wiki/queries/old.md",
          error: "boom",
          createdAt: 1,
        },
      ],
      maxConcurrent: 3,
      updateTask,
      setPanelOpen,
      getRunningCount: () => 0,
      getNextQueued,
    }),
  },
}))

import { retryResearchTask } from "./deep-research"

describe("retryResearchTask", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    updateTask.mockReset()
    setPanelOpen.mockReset()
    getNextQueued.mockReset()
    getNextQueued.mockReturnValue(undefined)
  })

  it("requeues a failed task in place and clears stale fields", () => {
    const ok = retryResearchTask(
      "research-1",
      { provider: "openai", model: "gpt-4.1" } as never,
      { provider: "tavily", apiKey: "k" } as never,
    )

    expect(ok).toBe(true)
    expect(updateTask).toHaveBeenCalledWith("research-1", {
      status: "queued",
      error: null,
      webResults: [],
      synthesis: "",
      savedPath: null,
    })
    expect(setPanelOpen).toHaveBeenCalledWith(true)
    vi.runAllTimers()
  })

  it("returns false for a missing or non-error task", () => {
    const ok = retryResearchTask(
      "missing",
      { provider: "openai", model: "gpt-4.1" } as never,
      { provider: "tavily", apiKey: "k" } as never,
    )
    expect(ok).toBe(false)
    expect(updateTask).not.toHaveBeenCalled()
  })
})
