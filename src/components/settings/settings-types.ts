import type { CustomApiMode } from "./llm-presets"
import type { ReasoningConfig } from "@/stores/wiki-store"

/**
 * Shape of the draft state each section reads from and writes into.
 * The parent (SettingsView) owns one instance and hands it to every
 * section; the Save button at the bottom flushes the whole draft to
 * stores + disk in one commit.
 */
export interface SettingsDraft {
  // LLM provider
  provider: "openai" | "anthropic" | "google" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli"
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  maxContextSize: number
  apiMode: CustomApiMode | undefined
  reasoning: ReasoningConfig | undefined

  // Embedding
  embeddingEnabled: boolean
  embeddingEndpoint: string
  embeddingApiKey: string
  embeddingModel: string
  /** Target characters per chunk. Empty = use chunker default (1000). */
  embeddingMaxChunkChars: number | undefined
  /** Overlap characters between adjacent chunks. Empty = default (200). */
  embeddingOverlapChunkChars: number | undefined

  // Multimodal (image captioning at ingest time)
  multimodalEnabled: boolean
  multimodalUseMainLlm: boolean
  multimodalProvider: "openai" | "anthropic" | "google" | "ollama" | "custom" | "minimax" | "claude-code" | "codex-cli"
  multimodalApiKey: string
  multimodalModel: string
  multimodalOllamaUrl: string
  multimodalCustomEndpoint: string
  multimodalApiMode: CustomApiMode | undefined
  multimodalConcurrency: number

  // Output preferences
  outputLanguage: string
  maxHistoryMessages: number

  // Network — global outbound HTTP proxy. Persisted to app-state.json
  // and read by the Rust setup hook on app launch (changes apply
  // after restart). See src/lib/proxy-config.ts.
  proxyEnabled: boolean
  proxyUrl: string
  proxyBypassLocal: boolean

  // Scheduled Import
  scheduledImportEnabled: boolean
  scheduledImportPath: string
  scheduledImportInterval: number // minutes

  // UI
  uiLanguage: string

  // Project sync
  projectFileSyncEnabled: boolean
}

export type DraftSetter = <K extends keyof SettingsDraft>(
  key: K,
  value: SettingsDraft[K],
) => void
