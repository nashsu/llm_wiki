/**
 * Search ranking scenarios moved to Rust with the shared backend search
 * service (`src-tauri/src/commands/search.rs`). The WebView now only
 * wraps that command, so this file guards the command contract from
 * the TS side instead of duplicating ranking logic in Node.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"

const mockInvoke = vi.fn()

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { searchWiki } from "./search"

beforeEach(() => {
  mockInvoke.mockReset()
  useWikiStore.getState().setEmbeddingConfig({
    enabled: false,
    endpoint: "",
    apiKey: "",
    model: "",
  })
})

describe("searchWiki backend command contract", () => {
  it("delegates ranking to search_project and maps relative wiki paths to absolute paths", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "keyword",
      tokenHits: 1,
      vectorHits: 0,
      results: [
        {
          path: "wiki/concepts/attention.md",
          title: "Attention",
          snippet: "body",
          titleMatch: true,
          score: 1 / 61,
          images: [],
        },
      ],
    })

    const results = await searchWiki("/tmp/project", "attention")

    expect(mockInvoke).toHaveBeenCalledWith("search_project", {
      projectPath: "/tmp/project",
      query: "attention",
      topK: 20,
      includeContent: false,
      queryEmbedding: null,
      embeddingConfig: expect.objectContaining({ enabled: false }),
    })
    expect(results[0].path).toBe("/tmp/project/wiki/concepts/attention.md")
  })
})
