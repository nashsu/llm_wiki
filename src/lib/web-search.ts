import { invoke } from "@tauri-apps/api/core"
import type {
  SearchApiConfig,
  SearchProvider,
  SearchProviderConfigs,
  SearXngCategory,
  SerpApiEngine,
} from "@/stores/wiki-store"
import { hasConfiguredAnyTxt, normalizeAnyTxtConfig } from "@/lib/anytxt-search"

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  source: string
}

export const DEFAULT_FIRECRAWL_URL = "https://api.firecrawl.dev"

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
    ...(config.provider !== "none" && config.provider !== "ollama" && config.provider !== "firecrawl" && config.apiKey
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
    ...(config.provider === "ollama" && config.ollamaUrl
      ? {
          ollama: {
            ollamaUrl: config.ollamaUrl,
          },
        }
      : {}),
  }

  const activeProvider = config.provider as SearchProvider
  const activeOverride = activeProvider === "none" ? undefined : providerConfigs[activeProvider]
  const resolvedOllamaUrl =
    activeProvider === "ollama"
      ? activeOverride?.ollamaUrl ?? config.ollamaUrl ?? "https://ollama.com"
      : providerConfigs.ollama?.ollamaUrl ?? "https://ollama.com"

  if (activeProvider === "none") {
    return {
      ...config,
      provider: "none",
      apiKey: "",
      serpApiEngine: config.serpApiEngine ?? providerConfigs.serpapi?.serpApiEngine ?? "google",
      searXngUrl: config.searXngUrl ?? providerConfigs.searxng?.searXngUrl ?? "",
      searXngCategories: config.searXngCategories ?? providerConfigs.searxng?.searXngCategories ?? ["general"],
      ollamaUrl: providerConfigs.ollama?.ollamaUrl ?? "https://ollama.com",
      providerConfigs,
      deepResearchSource: config.deepResearchSource ?? "web",
      anyTxt: normalizeAnyTxtConfig(config.anyTxt),
    }
  }

  return {
    ...config,
    provider: activeProvider,
    apiKey: activeOverride?.apiKey ?? config.apiKey ?? "",
    serpApiEngine: activeOverride?.serpApiEngine ?? config.serpApiEngine ?? "google",
    searXngUrl: activeOverride?.searXngUrl ?? config.searXngUrl ?? "",
    searXngCategories: activeOverride?.searXngCategories ?? config.searXngCategories ?? ["general"],
    ollamaUrl: resolvedOllamaUrl,
    providerConfigs,
    deepResearchSource: config.deepResearchSource ?? "web",
    anyTxt: normalizeAnyTxtConfig(config.anyTxt),
  }
}

export function hasConfiguredSearchProvider(config: SearchApiConfig): boolean {
  const resolved = resolveSearchConfig(config)
  if (resolved.provider === "none") return false
  if (resolved.provider === "searxng") return Boolean(resolved.searXngUrl?.trim())
  if (resolved.provider === "ollama") return Boolean(resolved.apiKey?.trim())
  if (resolved.provider === "firecrawl") return true
  return Boolean(resolved.apiKey?.trim())
}

export function hasConfiguredDeepResearchSources(config: SearchApiConfig): boolean {
  const resolved = resolveSearchConfig(config)
  const source = resolved.deepResearchSource ?? "web"
  const webConfigured = hasConfiguredSearchProvider(resolved)
  const anyTxtConfigured = hasConfiguredAnyTxt(resolved.anyTxt)

  if (source === "web") return webConfigured
  if (source === "anytxt") return anyTxtConfigured
  return webConfigured || anyTxtConfigured
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
  if (
    (resolved.provider === "tavily" || resolved.provider === "serpapi" || resolved.provider === "brave") &&
    !resolved.apiKey
  ) {
    throw new Error("Web search not configured. Add a Tavily, SerpApi, or Brave Search API key in Settings, or select a key-free provider such as Firecrawl or SearXNG.")
  }
  if (resolved.provider === "searxng" && !resolved.searXngUrl?.trim()) {
    throw new Error("Web search not configured. Add a SearXNG instance URL in Settings.")
  }
  if (resolved.provider === "ollama" && !resolved.apiKey?.trim()) {
    throw new Error("Ollama Web Search API requires an Ollama API key. Add one in Settings.")
  }

  return invoke<WebSearchResult[]>("web_search", {
    query,
    config: resolved,
    maxResults,
  })
}
