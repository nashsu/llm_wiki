/**
 * Web search via Tavily API — Node.js port.
 * No Tauri dependencies, uses native fetch.
 */

export interface SearchResult {
  title: string
  url: string
  content: string
  score: number
}

export interface SearchResponse {
  results: SearchResult[]
  query: string
}

export async function webSearch(query: string, maxResults: number = 5): Promise<SearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) {
    console.warn("[web-search] TAVILY_API_KEY not set, returning empty results")
    return { results: [], query }
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: "advanced",
        include_answer: false,
      }),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => "")
      console.error(`[web-search] Tavily API error ${response.status}: ${errText.slice(0, 200)}`)
      return { results: [], query }
    }

    const data = await response.json() as Record<string, unknown>
    const results = ((data.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
      title: (r.title as string) || "",
      url: (r.url as string) || "",
      content: (r.content as string) || "",
      score: (r.score as number) || 0,
    }))

    return { results, query }
  } catch (err) {
    console.error(`[web-search] failed: ${err instanceof Error ? err.message : err}`)
    return { results: [], query }
  }
}
