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

  it("calls Firecrawl anonymous search without an API key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: [
        {
          title: "LLM Wiki",
          url: "https://github.com/nashsu/llm_wiki",
          description: "Knowledge base app",
        },
      ],
    }))

    const out = await webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 2)
    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe("https://api.firecrawl.dev/v2/search")
    expect(init).toEqual(expect.objectContaining({ method: "POST" }))
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(JSON.parse(String(init?.body))).toEqual({ query: "llm_wiki", limit: 2 })
    expect(out).toEqual([
      {
        title: "LLM Wiki",
        url: "https://github.com/nashsu/llm_wiki",
        snippet: "Knowledge base app",
        source: "github.com",
      },
    ])
  })

  it("surfaces Firecrawl suspicious-IP anonymous search guidance", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: false,
      error: "Unfortunately, your IP address looks suspicious, so Firecrawl can't be used without an API key from here. Sign up for a free API key at https://firecrawl.dev for 1000 credits and higher rate limits for free.",
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .rejects.toThrow("Firecrawl anonymous search is blocked for this IP")
  })

  it("does not migrate legacy top-level apiKey into Firecrawl config", () => {
    const resolved = resolveSearchConfig({
      provider: "firecrawl",
      apiKey: "legacy-key",
    })

    expect(resolved.providerConfigs?.firecrawl).toBeUndefined()
  })

  it("allows Firecrawl success responses with advisory error fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      error: "partial results only",
      data: [
        {
          title: "Advisory result",
          url: "https://example.com/advisory",
          description: "Still usable",
        },
      ],
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([
        {
          title: "Advisory result",
          url: "https://example.com/advisory",
          snippet: "Still usable",
          source: "example.com",
        },
      ])
  })

  it("surfaces Firecrawl unknown error fallback", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .rejects.toThrow("Firecrawl search failed: Unknown error")
  })

  it("surfaces Firecrawl non-ok JSON errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { error: "rate limited" },
      { status: 429 },
    ))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .rejects.toThrow("Firecrawl search failed: rate limited")
  })

  it("surfaces Firecrawl non-json HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Service unavailable</html>", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .rejects.toThrow("Firecrawl search failed (503): <html>Service unavailable</html>")
  })

  it("surfaces Firecrawl network errors", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .rejects.toThrow("Network error reaching Firecrawl Search")
  })

  it("normalizes Firecrawl results field and filters missing URLs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      results: [
        { title: "Missing URL", description: "No URL" },
        {
          metadata: {
            title: "Metadata title",
            sourceURL: "https://docs.example/firecrawl",
            description: "Metadata description",
          },
        },
      ],
    }))

    const out = await webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5)

    expect(out).toEqual([
      {
        title: "Metadata title",
        url: "https://docs.example/firecrawl",
        snippet: "Metadata description",
        source: "docs.example",
      },
    ])
  })

  it("allows empty Firecrawl result sets", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([])
  })

  it("normalizes object-shaped Firecrawl data results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        results: [
          {
            title: "Object data result",
            url: "https://example.com/object-data",
            description: "Nested data shape",
          },
        ],
      },
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([
        {
          title: "Object data result",
          url: "https://example.com/object-data",
          snippet: "Nested data shape",
          source: "example.com",
        },
      ])
  })

  it("normalizes categorized Firecrawl web results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        web: [
          {
            title: "Categorized web result",
            url: "https://example.com/firecrawl-web",
            description: "Web category shape",
          },
        ],
        news: [
          {
            title: "News result",
            url: "https://example.com/news",
            description: "Ignored category",
          },
        ],
      },
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([
        {
          title: "Categorized web result",
          url: "https://example.com/firecrawl-web",
          snippet: "Web category shape",
          source: "example.com",
        },
      ])
  })

  it("normalizes object-shaped top-level Firecrawl results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      results: {
        web: [
          {
            title: "Top-level object result",
            url: "https://example.com/top-results",
            description: "Nested under results.web",
          },
        ],
      },
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([
        {
          title: "Top-level object result",
          url: "https://example.com/top-results",
          snippet: "Nested under results.web",
          source: "example.com",
        },
      ])
  })

  it("uses Firecrawl web results before fallback categories", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        web: [
          {
            title: "Preferred web",
            url: "https://example.com/web",
            description: "Use me",
          },
        ],
        results: [
          {
            title: "Fallback result",
            url: "https://example.com/fallback",
            description: "Do not use me",
          },
        ],
      },
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([
        {
          title: "Preferred web",
          url: "https://example.com/web",
          snippet: "Use me",
          source: "example.com",
        },
      ])
  })

  it("keeps an empty Firecrawl web category empty instead of falling back", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        web: [],
        results: [
          {
            title: "Fallback result",
            url: "https://example.com/fallback",
            description: "Should stay hidden",
          },
        ],
      },
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([])
  })

  it("normalizes Firecrawl items fallback results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        items: [
          {
            title: "Items fallback",
            url: "https://example.com/items",
            description: "Fallback item",
          },
        ],
      },
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([
        {
          title: "Items fallback",
          url: "https://example.com/items",
          snippet: "Fallback item",
          source: "example.com",
        },
      ])
  })

  it("treats unsupported Firecrawl result shapes as empty results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { unexpected: true } }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: "unexpected" }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([])
    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([])
  })

  it("filters non-object Firecrawl result entries", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: {
        web: [
          null,
          "unexpected",
          {
            title: "Valid entry",
            url: "https://example.com/valid",
            description: "Keep this",
          },
        ],
      },
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([
        {
          title: "Valid entry",
          url: "https://example.com/valid",
          snippet: "Keep this",
          source: "example.com",
        },
      ])
  })

  it("filters missing URLs in Firecrawl data results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: [
        { title: "No URL", description: "skip me" },
        { title: "Has URL", url: "https://example.com/ok", description: "keep me" },
      ],
    }))

    await expect(webSearch("llm_wiki", { provider: "firecrawl", apiKey: "" }, 5))
      .resolves.toEqual([
        {
          title: "Has URL",
          url: "https://example.com/ok",
          snippet: "keep me",
          source: "example.com",
        },
      ])
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

  it("treats Firecrawl as configured without an API key", () => {
    expect(hasConfiguredSearchProvider({
      provider: "firecrawl",
      apiKey: "",
    })).toBe(true)
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
