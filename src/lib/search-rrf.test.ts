/**
 * The RRF scoring implementation now lives in Rust
 * (`commands::search`). These TS tests only guard the WebView wrapper:
 * it should pass embedding config to the shared backend command and map
 * backend-relative result paths back to absolute project paths for the editor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"

const mockInvoke = vi.fn()

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { searchWiki, tokenizeQuery } from "./search"

beforeEach(() => {
  mockInvoke.mockReset()
  useWikiStore.getState().setEmbeddingConfig({
    enabled: true,
    endpoint: "http://test/v1/embeddings",
    apiKey: "",
    model: "test-embed",
  })
})

describe("searchWiki backend wrapper", () => {
  it("passes embeddingConfig to the shared backend search command and absolutizes paths", async () => {
    mockInvoke.mockResolvedValueOnce({
      mode: "hybrid",
      tokenHits: 1,
      vectorHits: 1,
      results: [
        {
          path: "wiki/concepts/attention.md",
          title: "Attention",
          snippet: "Attention",
          titleMatch: true,
          score: 1 / 61,
          images: [],
        },
      ],
    })

    const out = await searchWiki("/tmp/project", "attention")

    expect(mockInvoke).toHaveBeenCalledWith("search_project", {
      projectPath: "/tmp/project",
      query: "attention",
      topK: 20,
      includeContent: false,
      queryEmbedding: null,
      embeddingConfig: expect.objectContaining({ enabled: true, model: "test-embed" }),
    })
    expect(out[0].path).toBe("/tmp/project/wiki/concepts/attention.md")
  })

  it("passes disabled embedding config through for backend keyword-only search", async () => {
    useWikiStore.getState().setEmbeddingConfig({
      enabled: false,
      endpoint: "",
      apiKey: "",
      model: "",
    })
    mockInvoke.mockResolvedValueOnce({
      mode: "keyword",
      tokenHits: 1,
      vectorHits: 0,
      results: [],
    })

    await searchWiki("/tmp/project", "attention")

    expect(mockInvoke).toHaveBeenCalledWith(
      "search_project",
      expect.objectContaining({
        queryEmbedding: null,
        embeddingConfig: expect.objectContaining({ enabled: false }),
      }),
    )
  })

  it("keeps CJK tokenization behavior for image caption filtering", () => {
    const tokens = tokenizeQuery("默会知识")
    expect(tokens).toContain("默会")
    expect(tokens).toContain("知识")
    expect(tokens).toContain("默")
  })
})
