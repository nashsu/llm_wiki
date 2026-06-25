import { beforeEach, describe, expect, it, vi } from "vitest"
import { hasConfiguredDeepResearchSources, hasConfiguredSearchProvider, resolveSearchConfig, webSearch } from "./web-search"

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

describe("webSearch", () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it("delegates provider search to the Rust backend command", async () => {
    invokeMock.mockResolvedValueOnce([
      { title: "A", url: "https://example.com/a", snippet: "Alpha", source: "web" },
    ])

    const out = await webSearch("alpha", { provider: "tavily", apiKey: "tvly" }, 3)

    expect(invokeMock).toHaveBeenCalledWith("web_search", {
      query: "alpha",
      maxResults: 3,
      config: expect.objectContaining({
        provider: "tavily",
        apiKey: "tvly",
      }),
    })
    expect(out).toEqual([
      { title: "A", url: "https://example.com/a", snippet: "Alpha", source: "web" },
    ])
  })

  it("passes provider-specific config to Rust", async () => {
    invokeMock.mockResolvedValueOnce([])

    await webSearch(
      "ai policy",
      {
        provider: "serpapi",
        apiKey: "",
        providerConfigs: {
          tavily: { apiKey: "tavily-key" },
          serpapi: { apiKey: "serp-key", serpApiEngine: "google_news" },
        },
      },
      5,
    )

    expect(invokeMock).toHaveBeenCalledWith("web_search", {
      query: "ai policy",
      maxResults: 5,
      config: expect.objectContaining({
        provider: "serpapi",
        apiKey: "serp-key",
        serpApiEngine: "google_news",
      }),
    })
  })

  it("requires a configured search provider and key", async () => {
    await expect(webSearch("x", { provider: "none", apiKey: "" }, 5))
      .rejects.toThrow("Web search not configured")
    await expect(webSearch("x", { provider: "serpapi", apiKey: "" }, 5))
      .rejects.toThrow("Add a Tavily, SerpApi, or Brave Search API key")
    await expect(webSearch("x", { provider: "searxng", apiKey: "" }, 5))
      .rejects.toThrow("Add a SearXNG instance URL")
    await expect(webSearch("x", { provider: "ollama", apiKey: "" }, 5))
      .rejects.toThrow("Ollama Web Search API requires an Ollama API key")
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("treats key-free providers as configured", () => {
    expect(hasConfiguredSearchProvider({ provider: "searxng", apiKey: "", searXngUrl: "http://localhost:8080" })).toBe(true)
    expect(hasConfiguredSearchProvider({ provider: "firecrawl", apiKey: "" })).toBe(true)
  })

  it("does not leak a stale top-level Ollama URL into non-Ollama providers", () => {
    const resolved = resolveSearchConfig({
      provider: "firecrawl",
      apiKey: "",
      ollamaUrl: "http://localhost:11434",
    })

    expect(resolved.provider).toBe("firecrawl")
    expect(resolved.ollamaUrl).toBe("https://ollama.com")
  })

  it("tracks Deep Research source configuration independently from the active web provider", () => {
    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "anytxt",
      anyTxt: { enabled: true, endpoint: "http://127.0.0.1:9920" },
    })).toBe(true)
    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "both",
      anyTxt: { enabled: false, endpoint: "" },
    })).toBe(false)
  })
})
