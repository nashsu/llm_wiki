import { beforeEach, describe, expect, it, vi } from "vitest"
import { hasConfiguredDeepResearchSources, hasConfiguredSearchProvider, resolveSearchConfig, webSearch } from "./web-search"

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

describe("webSearch", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  it("normalizes Tavily results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        { title: "A", url: "https://www.example.com/a", content: "Alpha" },
      ],
    }))

    const out = await webSearch("alpha", { provider: "tavily", apiKey: "tvly" }, 3)

    expect(fetchMock).toHaveBeenCalledWith("https://api.tavily.com/search", expect.objectContaining({
      method: "POST",
    }))
    expect(out).toEqual([
      { title: "A", url: "https://www.example.com/a", snippet: "Alpha", source: "example.com" },
    ])
  })

  it("calls SerpApi Google Search and normalizes organic results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      organic_results: [
        { title: "Serp result", link: "https://www.serp.example/page", snippet: "Snippet" },
        { title: "Second", link: "https://docs.example/item", snippet: "More" },
      ],
    }))

    const out = await webSearch("knowledge graph", { provider: "serpapi", apiKey: "serp" }, 1)
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))

    expect(parsed.origin + parsed.pathname).toBe("https://serpapi.com/search")
    expect(parsed.searchParams.get("engine")).toBe("google")
    expect(parsed.searchParams.get("q")).toBe("knowledge graph")
    expect(parsed.searchParams.get("api_key")).toBe("serp")
    expect(parsed.searchParams.get("num")).toBe("1")
    expect(init).toEqual(expect.objectContaining({ method: "GET" }))
    expect(out).toEqual([
      { title: "Serp result", url: "https://www.serp.example/page", snippet: "Snippet", source: "serp.example" },
    ])
  })

  it("uses SerpApi provider-specific config and selected engine", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      news_results: [
        { title: "News", link: "https://news.example/story", snippet: "Fresh" },
      ],
    }))

    const out = await webSearch(
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
    const parsed = new URL(String(fetchMock.mock.calls[0][0]))

    expect(parsed.searchParams.get("engine")).toBe("google_news")
    expect(parsed.searchParams.get("api_key")).toBe("serp-key")
    expect(out).toEqual([
      { title: "News", url: "https://news.example/story", snippet: "Fresh", source: "news.example" },
    ])
  })

  it("calls SearXNG JSON search with the configured instance and categories", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        {
          title: "SearXNG result",
          url: "https://docs.example/page",
          content: "Result content",
          engine: "duckduckgo",
        },
      ],
    }))

    const out = await webSearch(
      "local search",
      {
        provider: "searxng",
        apiKey: "",
        providerConfigs: {
          searxng: {
            searXngUrl: "https://search.example.com",
            searXngCategories: ["general", "news"],
          },
        },
      },
      3,
    )
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))

    expect(parsed.origin + parsed.pathname).toBe("https://search.example.com/search")
    expect(parsed.searchParams.get("q")).toBe("local search")
    expect(parsed.searchParams.get("format")).toBe("json")
    expect(parsed.searchParams.get("categories")).toBe("general,news")
    expect(init).toEqual(expect.objectContaining({ method: "GET" }))
    expect(out).toEqual([
      { title: "SearXNG result", url: "https://docs.example/page", snippet: "Result content", source: "docs.example" },
    ])
  })

  it("preserves SearXNG subpath instances when building the search endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }))

    await webSearch(
      "subpath",
      {
        provider: "searxng",
        apiKey: "",
        providerConfigs: {
          searxng: { searXngUrl: "http://localhost:8080/searx/" },
        },
      },
      5,
    )
    const parsed = new URL(String(fetchMock.mock.calls[0][0]))

    expect(parsed.origin + parsed.pathname).toBe("http://localhost:8080/searx/search")
    expect(parsed.searchParams.get("categories")).toBe("general")
  })

  it("surfaces SerpApi JSON errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid API key" }))

    await expect(webSearch("x", { provider: "serpapi", apiKey: "bad" }, 5))
      .rejects.toThrow("SerpApi search failed: Invalid API key")
  })

  it("requires a configured search provider and key", async () => {
    await expect(webSearch("x", { provider: "none", apiKey: "" }, 5))
      .rejects.toThrow("Select a search provider")
    await expect(webSearch("x", { provider: "serpapi", apiKey: "" }, 5))
      .rejects.toThrow(/API key/)
    await expect(webSearch("x", { provider: "searxng", apiKey: "" }, 5))
      .rejects.toThrow("SearXNG instance URL")
  })

  it("treats SearXNG instance URLs as configured without an API key", () => {
    expect(hasConfiguredSearchProvider({
      provider: "searxng",
      apiKey: "",
      providerConfigs: {
        searxng: {
          searXngUrl: "http://127.0.0.1:8080",
          searXngCategories: ["general", "science", "it"],
        },
      },
      searXngUrl: "http://127.0.0.1:8080",
      searXngCategories: ["general", "science", "it"],
      serpApiEngine: "google",
    })).toBe(true)
  })

  it("requires an API key for the Ollama Web Search API", async () => {
    await expect(webSearch(
      "official ollama",
      {
        provider: "ollama",
        apiKey: "",
        providerConfigs: {
          ollama: { ollamaUrl: "https://ollama.com" },
        },
      },
      5,
    )).rejects.toThrow("requires an Ollama API key")

    expect(hasConfiguredSearchProvider({
      provider: "ollama",
      apiKey: "",
      providerConfigs: {
        ollama: { ollamaUrl: "https://ollama.com" },
      },
    })).toBe(false)
  })

  it("does not leak a stale top-level Ollama URL into non-Ollama providers", () => {
    const resolved = resolveSearchConfig({
      provider: "serpapi",
      apiKey: "",
      ollamaUrl: "http://localhost:11434",
      providerConfigs: {
        serpapi: { apiKey: "serp-key" },
        ollama: { ollamaUrl: "https://ollama.com" },
      },
    })

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
      deepResearchSource: "anytxt",
      anyTxt: { enabled: false, endpoint: "http://127.0.0.1:9920" },
    })).toBe(false)

    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "web",
      anyTxt: { endpoint: "http://127.0.0.1:9920" },
    })).toBe(false)

    expect(resolveSearchConfig({
      provider: "none",
      apiKey: "",
    }).deepResearchSource).toBe("web")
  })

  it("calls the Ollama Web Search API with Bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        { title: "Official", url: "https://ollama.example/search", content: "Cloud result" },
      ],
    }))

    const out = await webSearch(
      "official ollama",
      {
        provider: "ollama",
        apiKey: "",
        providerConfigs: {
          ollama: { apiKey: "ollama-key" },
        },
      },
      1,
    )
    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe("https://ollama.com/api/web_search")
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ollama-key")
    expect(JSON.parse(String(init?.body))).toEqual({ query: "official ollama", max_results: 1 })
    expect(out).toEqual([
      { title: "Official", url: "https://ollama.example/search", snippet: "Cloud result", source: "ollama.example" },
    ])
    expect(hasConfiguredSearchProvider({
      provider: "ollama",
      apiKey: "",
      providerConfigs: {
        ollama: { apiKey: "ollama-key" },
      },
    })).toBe(true)
  })

  it("surfaces Ollama authentication guidance for 401 responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, { status: 401 }))

    await expect(webSearch(
      "official ollama",
      {
        provider: "ollama",
        apiKey: "",
        providerConfigs: {
          ollama: { apiKey: "bad-key" },
        },
      },
      5,
    )).rejects.toThrow("Check your Ollama API key")
  })

  it("calls Brave Search API with X-Subscription-Token and normalizes results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      web: {
        results: [
          { title: "Brave A", url: "https://www.example.com/a", description: "First result" },
          { title: "Brave B", url: "https://docs.example/b", description: "Second result" },
        ],
      },
    }))

    const out = await webSearch("brave query", { provider: "brave", apiKey: "brave-key" }, 2)
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))

    expect(parsed.origin + parsed.pathname).toBe("https://api.search.brave.com/res/v1/web/search")
    expect(parsed.searchParams.get("q")).toBe("brave query")
    expect(parsed.searchParams.get("count")).toBe("2")
    expect(init).toEqual(expect.objectContaining({ method: "GET" }))
    expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brave-key")
    expect(out).toEqual([
      { title: "Brave A", url: "https://www.example.com/a", snippet: "First result", source: "example.com" },
      { title: "Brave B", url: "https://docs.example/b", snippet: "Second result", source: "docs.example" },
    ])
  })

  it("clamps Brave Search count to the API's 20-result ceiling", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ web: { results: [] } }))

    await webSearch("anything", { provider: "brave", apiKey: "k" }, 50)
    const [url] = fetchMock.mock.calls[0]
    expect(new URL(String(url)).searchParams.get("count")).toBe("20")
  })

  it("surfaces Brave Search authentication guidance for 401 responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 401 }))

    await expect(
      webSearch("x", { provider: "brave", apiKey: "bad" }, 5),
    ).rejects.toThrow("Brave Search API authentication failed")
  })
})
