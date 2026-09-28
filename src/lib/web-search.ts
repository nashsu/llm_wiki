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

export const SEARCH_PROVIDER_LABELS: Record<Exclude<SearchProvider, "none">, string> = {
  ollama: "Ollama",
  tavily: "Tavily",
  serpapi: "SerpApi",
  searxng: "SearXNG",
  firecrawl: "Firecrawl",
  brave: "Brave Search",
  bocha: "Bocha Search",
}

export type SearchProviderConfigurationIssue =
  | { kind: "no-provider" }
  | { kind: "missing-api-key"; provider: Exclude<SearchProvider, "none"> }
  | { kind: "missing-url"; provider: "searxng" }

export type DeepResearchConfigurationIssue =
  | SearchProviderConfigurationIssue
  | { kind: "anytxt-not-configured" }
  | { kind: "no-sources-configured" }

export type SearchProviderToggleResult =
  | { ok: true; config: SearchApiConfig }
  | { ok: false; issue: SearchProviderConfigurationIssue }

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

/**
 * Select a provider without carrying the previous provider's denormalized
 * top-level credentials into it. Provider-specific settings are canonical
 * once `providerConfigs` exists; the top-level fields only describe the
 * currently selected provider and support legacy persisted configs.
 */
export function selectSearchProvider(
  config: SearchApiConfig,
  provider: SearchProvider,
): SearchApiConfig {
  const resolved = resolveSearchConfig(config)
  if (provider === "none") {
    return resolveSearchConfig({ ...resolved, provider: "none" })
  }

  const override = resolved.providerConfigs?.[provider]
  return resolveSearchConfig({
    ...resolved,
    provider,
    apiKey: override?.apiKey ?? "",
    serpApiEngine: provider === "serpapi"
      ? override?.serpApiEngine ?? "google"
      : resolved.serpApiEngine,
    searXngUrl: provider === "searxng"
      ? override?.searXngUrl ?? ""
      : resolved.searXngUrl,
    searXngCategories: provider === "searxng"
      ? override?.searXngCategories ?? ["general"]
      : resolved.searXngCategories,
    ollamaUrl: provider === "ollama"
      ? override?.ollamaUrl ?? "https://ollama.com"
      : resolved.ollamaUrl,
  })
}

export function getSearchProviderConfigurationIssue(
  config: SearchApiConfig,
): SearchProviderConfigurationIssue | null {
  const resolved = resolveSearchConfig(config)
  if (resolved.provider === "none") return { kind: "no-provider" }
  if (resolved.provider === "searxng") {
    return resolved.searXngUrl?.trim()
      ? null
      : { kind: "missing-url", provider: "searxng" }
  }
  if (resolved.provider === "firecrawl") return null
  return resolved.apiKey?.trim()
    ? null
    : { kind: "missing-api-key", provider: resolved.provider }
}

export function toggleSearchProvider(
  config: SearchApiConfig,
  provider: Exclude<SearchProvider, "none">,
): SearchProviderToggleResult {
  const resolved = resolveSearchConfig(config)
  if (resolved.provider === provider) {
    return { ok: true, config: selectSearchProvider(resolved, "none") }
  }

  const candidate = selectSearchProvider(resolved, provider)
  const issue = getSearchProviderConfigurationIssue(candidate)
  return issue
    ? { ok: false, issue }
    : { ok: true, config: candidate }
}

export function hasConfiguredSearchProvider(config: SearchApiConfig): boolean {
  return getSearchProviderConfigurationIssue(config) === null
}

export function getDeepResearchConfigurationIssue(
  config: SearchApiConfig,
): DeepResearchConfigurationIssue | null {
  const resolved = resolveSearchConfig(config)
  const source = resolved.deepResearchSource ?? "web"
  const webIssue = getSearchProviderConfigurationIssue(resolved)
  const anyTxtConfigured = hasConfiguredAnyTxt(resolved.anyTxt)

  if (source === "web") return webIssue
  if (source === "anytxt") {
    return anyTxtConfigured ? null : { kind: "anytxt-not-configured" }
  }
  if (webIssue === null || anyTxtConfigured) return null
  return webIssue.kind === "no-provider"
    ? { kind: "no-sources-configured" }
    : webIssue
}

export function hasConfiguredDeepResearchSources(config: SearchApiConfig): boolean {
  return getDeepResearchConfigurationIssue(config) === null
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
    (
      resolved.provider === "tavily" ||
      resolved.provider === "serpapi" ||
      resolved.provider === "brave" ||
      resolved.provider === "bocha"
    ) &&
    !resolved.apiKey
  ) {
    throw new Error("Web search not configured. Add an API key for the selected search provider in Settings, or select a key-free provider such as Firecrawl or SearXNG.")
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
