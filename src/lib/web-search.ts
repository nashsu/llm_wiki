import type {
  SearchApiConfig,
  SearchProvider,
  SearchProviderConfigs,
  SearXngCategory,
  SerpApiEngine,
} from "@/stores/wiki-store"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  source: string
}

export const SERPAPI_ENGINE_OPTIONS: { value: SerpApiEngine; label: string; hint: string }[] = [
  { value: "google", label: "Google Web", hint: "SerpApi Google Search API organic results" },
  { value: "google_news", label: "Google News", hint: "News-focused results" },
  { value: "google_scholar", label: "Google Scholar", hint: "Academic papers and citations" },
  { value: "google_patents", label: "Google Patents", hint: "Patent search results" },
  { value: "bing", label: "Bing", hint: "Bing organic results" },
  { value: "duckduckgo", label: "DuckDuckGo", hint: "DuckDuckGo organic results" },
  { value: "google_images", label: "Google Images", hint: "Image search results" },
  { value: "google_videos", label: "Google Videos", hint: "Video search results" },
  { value: "youtube", label: "YouTube", hint: "YouTube video results" },
]

export const SEARXNG_CATEGORY_OPTIONS: { value: SearXngCategory; label: string; hint: string }[] = [
  { value: "general", label: "General", hint: "Default web results" },
  { value: "news", label: "News", hint: "News engines" },
  { value: "science", label: "Science", hint: "Academic and science-focused engines" },
  { value: "it", label: "IT", hint: "Developer and technology engines" },
  { value: "images", label: "Images", hint: "Image search results" },
  { value: "videos", label: "Videos", hint: "Video search results" },
  { value: "files", label: "Files", hint: "File and document search" },
  { value: "map", label: "Map", hint: "Map and location results" },
  { value: "music", label: "Music", hint: "Music engines" },
  { value: "social media", label: "Social", hint: "Social media engines" },
]

export function resolveSearchConfig(config: SearchApiConfig): SearchApiConfig {
  const providerConfigs: SearchProviderConfigs = config.providerConfigs ?? {
    ...(config.provider !== "none" && config.apiKey
      ? {
          [config.provider]: {
            apiKey: config.apiKey,
            serpApiEngine: config.serpApiEngine,
            searXngUrl: config.searXngUrl,
            searXngCategories: config.searXngCategories,
          },
        }
      : {}),
    ...(config.provider === "searxng" && config.searXngUrl
      ? {
          searxng: {
            searXngUrl: config.searXngUrl,
            searXngCategories: config.searXngCategories,
          },
        }
      : {}),
  }

  const activeProvider = config.provider as SearchProvider
  if (activeProvider === "none") {
    return {
      ...config,
      provider: "none",
      apiKey: "",
      serpApiEngine: config.serpApiEngine ?? providerConfigs.serpapi?.serpApiEngine ?? "google",
      searXngUrl: config.searXngUrl ?? providerConfigs.searxng?.searXngUrl ?? "",
      searXngCategories: config.searXngCategories ?? providerConfigs.searxng?.searXngCategories ?? ["general"],
      providerConfigs,
    }
  }

  const activeOverride = providerConfigs[activeProvider]
  return {
    ...config,
    provider: activeProvider,
    apiKey: activeOverride?.apiKey ?? config.apiKey ?? "",
    serpApiEngine: activeOverride?.serpApiEngine ?? config.serpApiEngine ?? "google",
    searXngUrl: activeOverride?.searXngUrl ?? config.searXngUrl ?? "",
    searXngCategories: activeOverride?.searXngCategories ?? config.searXngCategories ?? ["general"],
    providerConfigs,
  }
}

export async function webSearch(
  query: string,
  config: SearchApiConfig,
  maxResults: number = 10,
): Promise<WebSearchResult[]> {
  const resolved = resolveSearchConfig(config)
  if (resolved.provider === "none") {
    throw new Error("Web search not configured. Select a search provider in Settings.")
  }
  if ((resolved.provider === "tavily" || resolved.provider === "serpapi") && !resolved.apiKey) {
    throw new Error("Web search not configured. Add a Tavily or SerpApi API key in Settings.")
  }
  if (resolved.provider === "searxng" && !resolved.searXngUrl?.trim()) {
    throw new Error("Web search not configured. Add a SearXNG instance URL in Settings.")
  }

  switch (resolved.provider) {
    case "tavily":
      return tavilySearch(query, resolved.apiKey, maxResults)
    case "serpapi":
      return serpApiSearch(query, resolved.apiKey, maxResults, resolved.serpApiEngine ?? "google")
    case "searxng":
      return searXngSearch(query, resolved.searXngUrl ?? "", maxResults, resolved.searXngCategories ?? ["general"])
    default:
      throw new Error(`Unknown search provider: ${resolved.provider}`)
  }
}

function searXngSearchUrl(instanceUrl: string): URL {
  const trimmed = instanceUrl.trim()
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withProtocol)
  const path = url.pathname.replace(/\/+$/, "")
  url.pathname = path.endsWith("/search") || path === "/search"
    ? path
    : `${path}/search`
  url.search = ""
  url.hash = ""
  return url
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "")
  } catch {
    return ""
  }
}

async function searXngSearch(
  query: string,
  instanceUrl: string,
  maxResults: number,
  categories: SearXngCategory[],
): Promise<WebSearchResult[]> {
  let endpoint: URL
  try {
    endpoint = searXngSearchUrl(instanceUrl)
  } catch {
    throw new Error("Invalid SearXNG instance URL. Use a valid http(s) URL, for example https://search.example.com.")
  }

  endpoint.searchParams.set("q", query)
  endpoint.searchParams.set("format", "json")
  endpoint.searchParams.set("categories", (categories.length > 0 ? categories : ["general"]).join(","))

  const httpFetch = await getHttpFetch()
  let response: Response
  try {
    response = await httpFetch(endpoint.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    })
  } catch (err) {
    if (isFetchNetworkError(err)) {
      throw new Error(
        "Network error reaching the SearXNG instance. Check the instance URL and whether JSON search is enabled.",
      )
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`SearXNG search failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()
  return normalizeSearXngResults(data, maxResults)
}

function normalizeSearXngResults(data: { results?: unknown[] }, maxResults: number): WebSearchResult[] {
  return (data.results ?? [])
    .slice(0, maxResults)
    .map((item) => normalizeSearXngResult(item))
    .filter((item) => item.url.length > 0)
}

function normalizeSearXngResult(item: unknown): WebSearchResult {
  const r = item as {
    title?: string
    url?: string
    content?: string
    engine?: string
    category?: string
  }
  const url = r.url ?? ""
  return {
    title: r.title ?? "Untitled",
    url,
    snippet: r.content ?? "",
    source: hostnameFromUrl(url) || r.engine || r.category || "",
  }
}

async function tavilySearch(
  query: string,
  apiKey: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  // Route through the Tauri HTTP plugin so future non-Tavily search
  // providers (Serper, Exa, Brave, Google CSE, ...) with less friendly
  // CORS don't each need their own workaround. See tauri-fetch.ts.
  const httpFetch = await getHttpFetch()
  let response: Response
  try {
    response = await httpFetch("https://api.tavily.com/search", {
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
  } catch (err) {
    if (isFetchNetworkError(err)) {
      throw new Error(
        "Network error reaching api.tavily.com. Check your connectivity and whether the Tavily API key is still valid.",
      )
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`Tavily search failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()

  return (data.results ?? []).map((r: { title: string; url: string; content: string }) => ({
    title: r.title ?? "Untitled",
    url: r.url ?? "",
    snippet: r.content ?? "",
    source: hostnameFromUrl(r.url ?? ""),
  }))
}

async function serpApiSearch(
  query: string,
  apiKey: string,
  maxResults: number,
  engine: SerpApiEngine,
): Promise<WebSearchResult[]> {
  const params = new URLSearchParams({
    engine,
    q: query,
    api_key: apiKey,
    num: String(maxResults),
  })

  const httpFetch = await getHttpFetch()
  let response: Response
  try {
    response = await httpFetch(`https://serpapi.com/search?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
  } catch (err) {
    if (isFetchNetworkError(err)) {
      throw new Error(
        "Network error reaching serpapi.com. Check your connectivity and whether the SerpApi API key is still valid.",
      )
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`SerpApi search failed (${response.status}): ${errorText}`)
  }

  const data = await response.json()
  if (typeof data.error === "string" && data.error.trim()) {
    throw new Error(`SerpApi search failed: ${data.error}`)
  }

  return normalizeSerpApiResults(data, maxResults)
}

function normalizeSerpApiResults(data: {
  organic_results?: unknown[]
  news_results?: unknown[]
  images_results?: unknown[]
  video_results?: unknown[]
  videos_results?: unknown[]
  shopping_results?: unknown[]
}, maxResults: number): WebSearchResult[] {
  const rawResults =
    data.organic_results ??
    data.news_results ??
    data.images_results ??
    data.video_results ??
    data.videos_results ??
    data.shopping_results ??
    []

  return rawResults
    .slice(0, maxResults)
    .map((item) => normalizeSerpApiResult(item))
}

function normalizeSerpApiResult(item: unknown): WebSearchResult {
  const r = item as {
    title?: string
    link?: string
    url?: string
    source?: string
    snippet?: string
    summary?: string
    description?: string
    thumbnail?: string
    original?: string
    displayed_link?: string
  }
  const url = r.link ?? r.url ?? r.original ?? r.thumbnail ?? ""
  return {
    title: r.title ?? "Untitled",
    url,
    snippet: r.snippet ?? r.summary ?? r.description ?? "",
    source: hostnameFromUrl(url) || r.source || r.displayed_link || "",
  }
}
