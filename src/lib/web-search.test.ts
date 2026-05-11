import { beforeEach, describe, expect, it, vi } from "vitest"
import { webSearch } from "./web-search"

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

  it("surfaces SerpApi JSON errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid API key" }))

    await expect(webSearch("x", { provider: "serpapi", apiKey: "bad" }, 5))
      .rejects.toThrow("SerpApi 搜索失败：Invalid API key")
  })

  it("requires a configured search provider and key", async () => {
    await expect(webSearch("x", { provider: "none", apiKey: "" }, 5))
      .rejects.toThrow("Tavily 或 SerpApi API Key")
  })
})
