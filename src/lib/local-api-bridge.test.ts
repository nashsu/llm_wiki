import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import { handleBridgeRequest, MCP_ACCESS_DISABLED_ERROR } from "./local-api-bridge"
import { searchWiki } from "@/lib/search"

vi.mock("@/commands/fs", () => ({
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn().mockResolvedValue([]),
  preprocessFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/lib/chat-retrieval", () => ({
  buildChatRetrievalContext: vi.fn(),
}))

vi.mock("@/lib/search", () => ({
  searchWiki: vi.fn(),
}))

vi.mock("@/lib/wiki-graph", () => ({
  buildWikiGraph: vi.fn(),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

vi.mock("@/lib/ingest-queue", () => ({
  enqueueIngest: vi.fn(),
}))

vi.mock("@/lib/has-usable-llm", () => ({
  hasUsableLlm: vi.fn(() => true),
}))

describe("local-api-bridge MCP access gate", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useWikiStore.setState({
      project: { id: "proj-1", name: "Wiki", path: "D:/wiki" },
      mcpAccessEnabled: false,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        json: vi.fn().mockResolvedValue({ ok: true }),
      }),
    )
  })

  it("responds immediately with an error when MCP access is disabled", async () => {
    await handleBridgeRequest({
      id: "req-1",
      endpoint: "search",
      payload: { query: "rope" },
    })

    expect(searchWiki).not.toHaveBeenCalled()
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:19827/api/v1/bridge/respond",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "req-1",
          ok: false,
          error: MCP_ACCESS_DISABLED_ERROR,
        }),
      }),
    )
  })

  it("handles bridge requests normally when MCP access is enabled", async () => {
    useWikiStore.setState({ mcpAccessEnabled: true })
    vi.mocked(searchWiki).mockResolvedValue([
      {
        title: "Rope",
        path: "D:/wiki/wiki/concepts/rope.md",
        snippet: "Rope scales long context.",
        titleMatch: true,
        score: 1,
        images: [],
      },
    ])

    await handleBridgeRequest({
      id: "req-2",
      endpoint: "search",
      payload: { query: "rope", projectPath: "D:/wiki", limit: 1 },
    })

    expect(searchWiki).toHaveBeenCalledWith("D:/wiki", "rope")
    const [, options] = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(JSON.parse(String(options?.body))).toMatchObject({
      id: "req-2",
      ok: true,
      result: {
        projectPath: "D:/wiki",
        query: "rope",
      },
    })
  })
})
