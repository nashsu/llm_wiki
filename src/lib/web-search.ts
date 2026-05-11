import type { SearchApiConfig, SearchProvider, SearchProviderConfigs, SerpApiEngine } from "@/stores/wiki-store"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  source: string
}

export const SERPAPI_ENGINE_OPTIONS: { value: SerpApiEngine; label: string; hint: string }[] = [
  { value: "google", label: "Google 网页", hint: "SerpApi Google Search API 自然搜索结果" },
  { value: "google_news", label: "Google 新闻", hint: "新闻搜索结果" },
  { value: "google_scholar", label: "Google 学术", hint: "学术论文和引用" },
  { value: "google_patents", label: "Google 专利", hint: "专利搜索结果" },
  { value: "bing", label: "Bing", hint: "Bing 自然搜索结果" },
  { value: "duckduckgo", label: "DuckDuckGo", hint: "DuckDuckGo 自然搜索结果" },
  { value: "google_images", label: "Google 图片", hint: "图片搜索结果" },
  { value: "google_videos", label: "Google 视频", hint: "视频搜索结果" },
  { value: "youtube", label: "YouTube", hint: "YouTube 视频结果" },
]

export function resolveSearchConfig(config: SearchApiConfig): SearchApiConfig {
  const providerConfigs: SearchProviderConfigs = config.providerConfigs ?? {
    ...(config.provider !== "none" && config.apiKey
      ? { [config.provider]: { apiKey: config.apiKey, serpApiEngine: config.serpApiEngine } }
      : {}),
  }

  const activeProvider = config.provider as SearchProvider
  if (activeProvider === "none") {
    return {
      ...config,
      provider: "none",
      apiKey: "",
      serpApiEngine: config.serpApiEngine ?? providerConfigs.serpapi?.serpApiEngine ?? "google",
      providerConfigs,
    }
  }

  const activeOverride = providerConfigs[activeProvider]
  return {
    ...config,
    provider: activeProvider,
    apiKey: activeOverride?.apiKey ?? config.apiKey ?? "",
    serpApiEngine: activeOverride?.serpApiEngine ?? config.serpApiEngine ?? "google",
    providerConfigs,
  }
}

export async function webSearch(
  query: string,
  config: SearchApiConfig,
  maxResults: number = 10,
): Promise<WebSearchResult[]> {
  const resolved = resolveSearchConfig(config)
  if (resolved.provider === "none" || !resolved.apiKey) {
    throw new Error("尚未配置网页搜索。请在设置中添加 Tavily 或 SerpApi API Key。")
  }

  switch (resolved.provider) {
    case "tavily":
      return tavilySearch(query, resolved.apiKey, maxResults)
    case "serpapi":
      return serpApiSearch(query, resolved.apiKey, maxResults, resolved.serpApiEngine ?? "google")
    default:
      throw new Error(`Unknown search provider: ${resolved.provider}`)
  }
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "")
  } catch {
    return ""
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
        "连接 api.tavily.com 时发生网络错误。请检查网络连接以及 Tavily API Key 是否仍然有效。",
      )
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "未知错误")
    throw new Error(`Tavily 搜索失败（${response.status}）：${errorText}`)
  }

  const data = await response.json()

  return (data.results ?? []).map((r: { title: string; url: string; content: string }) => ({
    title: r.title ?? "无标题",
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
        "连接 serpapi.com 时发生网络错误。请检查网络连接以及 SerpApi API Key 是否仍然有效。",
      )
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "未知错误")
    throw new Error(`SerpApi 搜索失败（${response.status}）：${errorText}`)
  }

  const data = await response.json()
  if (typeof data.error === "string" && data.error.trim()) {
    throw new Error(`SerpApi 搜索失败：${data.error}`)
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
    title: r.title ?? "无标题",
    url,
    snippet: r.snippet ?? r.summary ?? r.description ?? "",
    source: hostnameFromUrl(url) || r.source || r.displayed_link || "",
  }
}
