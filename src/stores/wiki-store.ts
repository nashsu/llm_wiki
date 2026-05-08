import { create } from "zustand"
import type { WikiProject, FileNode } from "@/types/wiki"

/**
 * Wire protocol used when `provider === "custom"`. Other providers have a
 * fixed protocol (openai → OpenAI chat; anthropic → Anthropic messages;
 * etc.), so this field is ignored for them. `undefined` defaults to
 * `chat_completions` for backward compatibility with pre-0.3.7 configs.
 */
export type CustomApiMode = "chat_completions" | "anthropic_messages"
export type ReasoningMode = "auto" | "off" | "low" | "medium" | "high" | "max" | "custom"

export interface ReasoningConfig {
  mode: ReasoningMode
  budgetTokens?: number
}

interface LlmConfig {
  provider: "openai" | "anthropic" | "google" | "ollama" | "custom" | "minimax" | "claude-code"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  maxContextSize: number // max context window in characters
  apiMode?: CustomApiMode
  reasoning?: ReasoningConfig
}

export type SearchProvider = "tavily" | "serpapi" | "none"
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

export interface SearchProviderOverride {
  apiKey?: string
  serpApiEngine?: SerpApiEngine
}

export type SearchProviderConfigs = Partial<Record<Exclude<SearchProvider, "none">, SearchProviderOverride>>

interface SearchApiConfig {
  provider: SearchProvider
  apiKey: string
  serpApiEngine?: SerpApiEngine
  providerConfigs?: SearchProviderConfigs
}

interface EmbeddingConfig {
  enabled: boolean
  endpoint: string // e.g. "http://127.0.0.1:1234/v1/embeddings"
  apiKey: string
  model: string // e.g. "text-embedding-qwen3-embedding-0.6b"
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
  apiMode?: CustomApiMode
  maxContextSize?: number
  reasoning?: ReasoningConfig
}

export type ProviderConfigs = Record<string, ProviderOverride>


function filterAppFileTree(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter((node) => node.name !== "codex-memory")
    .map((node) => node.is_dir && node.children
      ? { ...node, children: filterAppFileTree(node.children) }
      : node)
}

interface WikiState {
  project: WikiProject | null
  fileTree: FileNode[]
  selectedFile: string | null
  fileContent: string
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
  chatExpanded: boolean
  activeView: "wiki" | "sources" | "search" | "graph" | "lint" | "review" | "settings"
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
  dataVersion: number

  setProject: (project: WikiProject | null) => void
  setFileTree: (tree: FileNode[]) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: string) => void
  setPendingScrollImageSrc: (src: string | null) => void
  setChatExpanded: (expanded: boolean) => void
  setActiveView: (view: WikiState["activeView"]) => void
  setLlmConfig: (config: LlmConfig) => void
  setProviderConfigs: (configs: ProviderConfigs) => void
  setActivePresetId: (id: string | null) => void
  setSearchApiConfig: (config: SearchApiConfig) => void
  setEmbeddingConfig: (config: EmbeddingConfig) => void
  setMultimodalConfig: (config: MultimodalConfig) => void
  setOutputLanguage: (lang: OutputLanguage) => void
  setProxyConfig: (config: ProxyConfig) => void
  bumpDataVersion: () => void
}

export const useWikiStore = create<WikiState>((set) => ({
  project: null,
  fileTree: [],
  selectedFile: null,
  fileContent: "",
  pendingScrollImageSrc: null,
  chatExpanded: false,
  activeView: "wiki",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    maxContextSize: 204800,
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    reasoning: { mode: "auto" },
  },
  providerConfigs: {},
  activePresetId: null,

  dataVersion: 0,

  setProject: (project) => set({ project }),
  setFileTree: (fileTree) => set({ fileTree: filterAppFileTree(fileTree) }),
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setFileContent: (fileContent) => set({ fileContent }),
  setPendingScrollImageSrc: (pendingScrollImageSrc) => set({ pendingScrollImageSrc }),
  setChatExpanded: (chatExpanded) => set({ chatExpanded }),
  setActiveView: (activeView) => set({ activeView }),
  searchApiConfig: {
    provider: "none",
    apiKey: "",
    serpApiEngine: "google",
    providerConfigs: {},
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
    apiMode: "chat_completions",
    concurrency: 4,
  },

  outputLanguage: "auto",

  proxyConfig: {
    enabled: false,
    url: "",
    bypassLocal: true,
  },

  setLlmConfig: (llmConfig) => set({ llmConfig }),
  setProviderConfigs: (providerConfigs) => set({ providerConfigs }),
  setActivePresetId: (activePresetId) => set({ activePresetId }),
  setSearchApiConfig: (searchApiConfig) => set({ searchApiConfig }),
  setEmbeddingConfig: (embeddingConfig) => set({ embeddingConfig }),
  setMultimodalConfig: (multimodalConfig) => set({ multimodalConfig }),
  setOutputLanguage: (outputLanguage) => set({ outputLanguage }),
  setProxyConfig: (proxyConfig) => set({ proxyConfig }),
  bumpDataVersion: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
}))

export type { WikiState, LlmConfig, SearchApiConfig, EmbeddingConfig, MultimodalConfig, OutputLanguage, ProxyConfig }
