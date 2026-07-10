import { create } from "zustand"
import type { WikiProject, FileNode } from "@/types/wiki"
import { DEFAULT_SOURCE_WATCH_CONFIG } from "@/lib/source-watch-config"
import {
  buildProjectPathIndexFromTree,
  createEmptyProjectPathIndex,
  type ProjectPathIndex,
} from "@/lib/wiki-page-resolver"
import { DEFAULT_GRAPH_FILTERS, type GraphFilterState } from "@/lib/graph-filters"

/**
 * Wire protocol used when `provider === "custom"`. Other providers have a
 * fixed protocol (openai → OpenAI chat; anthropic → Anthropic messages;
 * etc.), so this field is ignored for them. `undefined` defaults to
 * `chat_completions` for backward compatibility with pre-0.3.7 configs.
 */
export type CustomApiMode = "chat_completions" | "anthropic_messages"
export type AzureModelFamily = "auto" | "gpt5"
export type ReasoningMode = "auto" | "off" | "low" | "medium" | "high" | "max" | "custom"

export interface ReasoningConfig {
  mode: ReasoningMode
  budgetTokens?: number
}

interface LlmConfig {
  provider: "openai" | "anthropic" | "google" | "azure" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  maxContextSize: number // max context window in characters
  apiMode?: CustomApiMode
  reasoning?: ReasoningConfig
  /**
   * Local CLI providers only. When true, LLM Wiki asks Claude/Codex CLI
   * to ignore user-level rules/config/MCP/tool state where the CLI exposes
   * such controls. Default false preserves existing advanced-user setups.
   */
  localCliIsolation?: boolean
  /** Codex CLI provider only. Overall subprocess timeout in minutes. */
  codexCliTimeoutMinutes?: number
}

export type SearchProvider =
  | "tavily"
  | "serpapi"
  | "searxng"
  | "ollama"
  | "brave"
  | "firecrawl"
  | "none"
export type DeepResearchSource = "web" | "anytxt" | "both"
export type SerpApiEngine =
  | "google"
  | "google_news"
  | "google_scholar"
  | "google_patents"
  | "bing"
  | "duckduckgo"
  | "google_images"
  | "google_videos"
  | "youtube"
  | string
export type SearXngCategory =
  | "general"
  | "news"
  | "science"
  | "it"
  | "images"
  | "videos"
  | "files"
  | "map"
  | "music"
  | "social media"
  | string

export interface SearchProviderOverride {
  apiKey?: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
  ollamaUrl?: string
}

export type SearchProviderConfigs = Partial<Record<Exclude<SearchProvider, "none">, SearchProviderOverride>>

export interface AnyTxtConfig {
  enabled?: boolean
  endpoint?: string
  filterDir?: string
  filterExt?: string
  limit?: number
}

interface SearchApiConfig {
  provider: SearchProvider
  apiKey: string
  serpApiEngine?: SerpApiEngine
  searXngUrl?: string
  searXngCategories?: SearXngCategory[]
  ollamaUrl?: string
  providerConfigs?: SearchProviderConfigs
  deepResearchSource?: DeepResearchSource
  anyTxt?: AnyTxtConfig
}

interface EmbeddingConfig {
  enabled: boolean
  endpoint: string // e.g. "http://127.0.0.1:1234/v1/embeddings"
  apiKey: string
  model: string // e.g. "text-embedding-qwen3-embedding-0.6b"
  /** Optional Gemini native `output_dimensionality` value. Ignored by OpenAI-compatible endpoints. */
  outputDimensionality?: number
  /**
   * Chunking knobs (Phase 1 RAG). Undefined values fall back to the
   * chunker's built-in defaults in `src/lib/text-chunker.ts`:
   *   targetChars   1000
   *   maxChars      1500
   *   minChars      200
   *   overlapChars  200
   *
   * Users on small-context endpoints (e.g. llama.cpp with n_ctx=512,
   * Ollama `mxbai-embed-large`) should lower `maxChunkChars` to avoid
   * per-request rejections; fetchEmbedding also auto-halves on
   * "too long" server errors as a second line of defence.
   */
  maxChunkChars?: number
  overlapChunkChars?: number
  /**
   * Extra HTTP headers to send with every embedding request, e.g.
   *   { "X-Model-Provider-Id": "siliconflow" }
   * for gateways like mify that route by header. Reserved names
   * (Authorization, Content-Type, Host, Content-Length, x-goog-api-key)
   * are ignored — they're managed by the embedding client itself.
   */
  extraHeaders?: Record<string, string>
}

/**
 * Image-captioning settings (Phase 4 of the multimodal-images plan).
 *
 * Decoupled from `llmConfig` because vision-capable endpoints are
 * usually NOT the same model the user picks for analysis/generation:
 * - the analysis stage often goes to a strong text-only model (Claude
 *   Sonnet, DeepSeek, etc.) that doesn't speak vision at all;
 * - captioning is happy with a small local VL model (Qwen2.5-VL-7B,
 *   LLaVA-1.6) that costs near-zero per call.
 *
 * `enabled` is the master gate. When false the caption pipeline is
 * skipped entirely — `read_file`'s extracted images still appear
 * inline (with empty alt text) and the safety-net `## Embedded
 * Images` section still gets written, but we never touch the LLM.
 *
 * `useMainLlm`: when true (the default for first-time users we
 * onboard), captioning calls go through the same `llmConfig`
 * everything else uses. When false, the dedicated fields below are
 * sent through the same provider machinery — same `streamChat`,
 * same `getProviderConfig`, no duplicate code.
 *
 * `concurrency` bounds parallel caption requests during ingest.
 * 30-image PDFs with sequential captioning at ~10s/image (a Qwen3
 * thinking model on consumer GPU) take 5 minutes. At concurrency=4
 * that drops to ~75s. Going wider than 8 typically just queues
 * behind a single-GPU server's batch slot, so we cap the slider
 * UI at a tasteful max in the settings view.
 */
/**
 * Global outbound HTTP proxy. When `enabled` and `url` is a valid
 * http(s) URL, the Rust setup hook reads this on app launch and
 * sets HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars before the
 * reqwest client used by tauri-plugin-http is constructed. Changes
 * apply on app restart only.
 */
interface ProxyConfig {
  enabled: boolean
  url: string
  bypassLocal: boolean
}

interface ScheduledImportConfig {
  enabled: boolean
  path: string // 监控目录的相对路径（相对于项目根目录），空字符串表示使用默认的 "raw"
  interval: number // 扫描间隔（分钟）
  lastScan: number | null // 上次扫描时间戳
}

/**
 * Local HTTP API server config. Read by the Rust `api_server` module on
 * every request via `load_app_state` (5s cache). The Rust side is the
 * source of truth at request time; this struct is the persisted form
 * the UI edits.
 *
 *   - `enabled` gates all non-/health endpoints. Default `true` so an
 *     env-token-only setup keeps working after the toggle is added.
 *   - `allowUnauthenticated` lets local agents call the API without a
 *     token. It is explicit and default-off.
 *   - `allowLanAccess` binds the API and clip server to 0.0.0.0 on
 *     app startup so trusted LAN devices can reach them. Default-off.
 *   - `mcpEnabled` allows the optional MCP stdio server to use this
 *     API. It is separate from the HTTP API kill-switch so users can
 *     expose scripts while keeping MCP disabled.
 *   - `token` is the bearer secret. Empty + auth required =
 *     every non-/health request returns 401. The env var
 *     `LLM_WIKI_API_TOKEN` overrides this field at the backend.
 */
interface ApiConfig {
  enabled: boolean
  allowUnauthenticated: boolean
  allowLanAccess: boolean
  mcpEnabled: boolean
  token: string
}

export type CloseBehavior = "ask" | "minimize" | "exit"

export type GraphColorMode = "type" | "community"

export interface GraphUiState {
  colorMode: GraphColorMode
  filters: GraphFilterState
  nodeScale: number
  graphSpacingDraft: number
}

export function createDefaultGraphUiState(): GraphUiState {
  return {
    colorMode: "type",
    filters: {
      ...DEFAULT_GRAPH_FILTERS,
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
    },
    nodeScale: 1,
    graphSpacingDraft: 1,
  }
}

export interface GeneralConfig {
  autostart: boolean
  closeBehavior: CloseBehavior
}

interface SourceWatchConfig {
  enabled: boolean
  autoIngest: boolean
  includeExtensions: string[]
  excludeExtensions: string[]
  excludeDirs: string[]
  excludeGlobs: string[]
  maxFileSizeMb: number
}

export type MineruModelVersion = "pipeline" | "vlm"

export interface MineruConfig {
  enabled: boolean
  token: string
  modelVersion: MineruModelVersion
}

interface MultimodalConfig {
  enabled: boolean
  /** Reuse `llmConfig` for caption calls. When true, the fields
   *  below are ignored. */
  useMainLlm: boolean
  provider: LlmConfig["provider"]
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  /** Max parallel caption requests during ingest. >=1. */
  concurrency: number
}

/**
 * Output language for LLM-generated content (wiki pages, chat responses, research).
 * "auto" = detect from user input / source document language.
 * Otherwise = force all LLM output to use the specified language.
 */
type OutputLanguage =
  | "auto"
  | "English"
  | "Chinese"
  | "Traditional Chinese"
  | "Japanese"
  | "Korean"
  | "Vietnamese"
  | "French"
  | "German"
  | "Spanish"
  | "Portuguese"
  | "Italian"
  | "Russian"
  | "Arabic"
  | "Persian"
  | "Hindi"
  | "Turkish"
  | "Dutch"
  | "Polish"
  | "Swedish"
  | "Indonesian"
  | "Thai"
  | "Ukrainian"

/**
 * Per-preset saved fields. Each entry survives turning the preset off
 * and coming back — users don't have to re-enter an API key when they
 * briefly switch to a different provider.
 */
export interface ProviderOverride {
  apiKey?: string
  model?: string
  baseUrl?: string           // customEndpoint for custom presets, ollamaUrl for ollama
  azureApiVersion?: string
  azureModelFamily?: AzureModelFamily
  apiMode?: CustomApiMode
  maxContextSize?: number
  reasoning?: ReasoningConfig
  localCliIsolation?: boolean
  codexCliTimeoutMinutes?: number
}

export type ProviderConfigs = Record<string, ProviderOverride>

export interface ExternalPreview {
  title: string
  path: string
  source: string
  url: string
  snippet: string
}

interface WikiState {
  project: WikiProject | null
  fileTree: FileNode[]
  /**
   * Lightweight lookup index derived from `fileTree`. Production code must
   * update fileTree through `setFileTree` so this stays in sync; direct
   * `useWikiStore.setState({ fileTree })` is only for tests that also reset or
   * do not read path resolution.
   */
  projectPathIndex: ProjectPathIndex
  selectedFile: string | null
  fileContent: string
  previewContentPath: string | null
  externalPreview: ExternalPreview | null
  /**
   * One-shot scroll target for the markdown preview. When the user
   * clicks an image in search results and chooses "jump to source",
   * we set this to the image URL alongside `selectedFile`. The
   * markdown preview consumes it on its next render — finds the
   * `<img data-mdsrc="..."/>` whose attribute matches and scrolls
   * it into view, then clears this back to null so a stale target
   * doesn't fire on the NEXT page open.
   *
   * Match by raw URL (the literal `src` from the markdown) rather
   * than the resolved `convertFileSrc` URL — same image referenced
   * across two pages with different URL conventions (one absolute,
   * one wiki-relative) still works.
   */
  pendingScrollImageSrc: string | null
  activeView: "chat" | "wiki" | "sources" | "search" | "graph" | "lint" | "review" | "skills" | "settings"
  llmConfig: LlmConfig
  /** Per-provider-preset stored overrides (API key, model, endpoint, …). */
  providerConfigs: ProviderConfigs
  /** Which preset is currently active. `null` = no LLM configured. */
  activePresetId: string | null
  searchApiConfig: SearchApiConfig
  embeddingConfig: EmbeddingConfig
  multimodalConfig: MultimodalConfig
  outputLanguage: OutputLanguage
  proxyConfig: ProxyConfig
  scheduledImportConfig: ScheduledImportConfig
  sourceWatchConfig: SourceWatchConfig
  mineruConfig: MineruConfig
  apiConfig: ApiConfig
  generalConfig: GeneralConfig
  graphUiState: GraphUiState
  dataVersion: number

  setProject: (project: WikiProject | null) => void
  setFileTree: (tree: FileNode[], options?: { syncPathIndex?: boolean }) => void
  setProjectPathIndexFromTree: (tree: FileNode[]) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: string) => void
  openPathInPreview: (path: string) => void
  openFileInPreview: (path: string, content: string) => void
  setExternalPreview: (preview: ExternalPreview | null) => void
  setPendingScrollImageSrc: (src: string | null) => void
  setActiveView: (view: WikiState["activeView"]) => void
  setLlmConfig: (config: LlmConfig) => void
  setProviderConfigs: (configs: ProviderConfigs) => void
  setActivePresetId: (id: string | null) => void
  setSearchApiConfig: (config: SearchApiConfig) => void
  setEmbeddingConfig: (config: EmbeddingConfig) => void
  setMultimodalConfig: (config: MultimodalConfig) => void
  setOutputLanguage: (lang: OutputLanguage) => void
  setProxyConfig: (config: ProxyConfig) => void
  setScheduledImportConfig: (config: ScheduledImportConfig) => void
  setSourceWatchConfig: (config: SourceWatchConfig) => void
  setMineruConfig: (config: MineruConfig) => void
  setApiConfig: (config: ApiConfig) => void
  setGeneralConfig: (config: GeneralConfig) => void
  setGraphUiState: (state: GraphUiState | ((current: GraphUiState) => GraphUiState)) => void
  resetGraphUiState: () => void
  bumpDataVersion: () => void
}

export const useWikiStore = create<WikiState>((set) => ({
  project: null,
  fileTree: [],
  projectPathIndex: createEmptyProjectPathIndex(),
  selectedFile: null,
  fileContent: "",
  previewContentPath: null,
  externalPreview: null,
  pendingScrollImageSrc: null,
  activeView: "wiki",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    maxContextSize: 204800,
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    reasoning: { mode: "auto" },
    localCliIsolation: false,
  },
  providerConfigs: {},
  activePresetId: null,

  dataVersion: 0,

  setProject: (project) => set({ project }),
  setFileTree: (fileTree, options) => {
    if (options?.syncPathIndex === false) {
      set({ fileTree })
      return
    }
    set({ fileTree, projectPathIndex: buildProjectPathIndexFromTree(fileTree) })
  },
  setProjectPathIndexFromTree: (tree) =>
    set({ projectPathIndex: buildProjectPathIndexFromTree(tree) }),
  setSelectedFile: (selectedFile) =>
    set({ selectedFile, previewContentPath: null, externalPreview: null }),
  setFileContent: (fileContent) => set({ fileContent }),
  openPathInPreview: (selectedFile) =>
    set({ selectedFile, previewContentPath: null, externalPreview: null, activeView: "wiki" }),
  openFileInPreview: (selectedFile, fileContent) =>
    set({
      selectedFile,
      fileContent,
      previewContentPath: selectedFile,
      externalPreview: null,
      activeView: "wiki",
    }),
  setExternalPreview: (externalPreview) => set({ externalPreview }),
  setPendingScrollImageSrc: (pendingScrollImageSrc) => set({ pendingScrollImageSrc }),
  setActiveView: (activeView) => set({ activeView }),
  searchApiConfig: {
    provider: "none",
    apiKey: "",
    serpApiEngine: "google",
    searXngUrl: "",
    searXngCategories: ["general"],
    providerConfigs: {},
    deepResearchSource: "web",
    anyTxt: {
      enabled: false,
      endpoint: "http://127.0.0.1:9920",
      filterDir: "",
      filterExt: "*",
      limit: 20,
    },
  },

  embeddingConfig: {
    enabled: false,
    endpoint: "",
    apiKey: "",
    model: "",
  },

  multimodalConfig: {
    // Off by default — captioning is a non-trivial token spend
    // (one VLM call per extracted image), and silently turning it
    // on for every user the first time they import a PDF would be
    // a budget surprise. Users who want it flip the toggle in
    // Settings → Image captioning.
    enabled: false,
    useMainLlm: true,
    provider: "custom",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    azureApiVersion: "2024-10-21",
    apiMode: "chat_completions",
    concurrency: 4,
  },

  outputLanguage: "auto",

  proxyConfig: {
    enabled: false,
    url: "",
    bypassLocal: true,
  },

  scheduledImportConfig: {
    enabled: false,
    path: "",
    interval: 60,
    lastScan: null,
  },

  sourceWatchConfig: DEFAULT_SOURCE_WATCH_CONFIG,
  mineruConfig: { enabled: false, token: "", modelVersion: "vlm" },

  // Default `enabled: true` preserves the pre-toggle behavior: anyone
  // who already had `LLM_WIKI_API_TOKEN` set or `apiConfig.token`
  // hand-edited keeps their working API. New users land in
  // "enabled + no token = 401 on every endpoint" — fail-closed by
  // virtue of the token being empty.
  apiConfig: {
    enabled: true,
    allowUnauthenticated: false,
    allowLanAccess: false,
    mcpEnabled: false,
    token: "",
  },

  generalConfig: {
    autostart: false,
    closeBehavior: "minimize",
  },

  graphUiState: createDefaultGraphUiState(),

  setLlmConfig: (llmConfig) => set({ llmConfig }),
  setProviderConfigs: (providerConfigs) => set({ providerConfigs }),
  setActivePresetId: (activePresetId) => set({ activePresetId }),
  setSearchApiConfig: (searchApiConfig) => set({ searchApiConfig }),
  setEmbeddingConfig: (embeddingConfig) => set({ embeddingConfig }),
  setMultimodalConfig: (multimodalConfig) => set({ multimodalConfig }),
  setOutputLanguage: (outputLanguage) => set({ outputLanguage }),
  setProxyConfig: (proxyConfig) => set({ proxyConfig }),
  setScheduledImportConfig: (scheduledImportConfig) => set({ scheduledImportConfig }),
  setSourceWatchConfig: (sourceWatchConfig) => set({ sourceWatchConfig }),
  setMineruConfig: (mineruConfig) => set({ mineruConfig }),
  setApiConfig: (apiConfig) => set({ apiConfig }),
  setGeneralConfig: (generalConfig) => set({ generalConfig }),
  setGraphUiState: (graphUiState) =>
    set((state) => ({
      graphUiState: typeof graphUiState === "function"
        ? graphUiState(state.graphUiState)
        : graphUiState,
    })),
  resetGraphUiState: () => set({ graphUiState: createDefaultGraphUiState() }),
  bumpDataVersion: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
}))

export type { WikiState, LlmConfig, SearchApiConfig, EmbeddingConfig, MultimodalConfig, OutputLanguage, ProxyConfig, ScheduledImportConfig, SourceWatchConfig, ApiConfig }
