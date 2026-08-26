import type { LlmConfig, ReasoningConfig, ReasoningMode } from "@/stores/wiki-store"

export interface ReasoningCapabilities {
  modes: readonly ReasoningMode[]
  customBudgetRange: { min: number; max: number }
  /** A saved mode can outlive a model/provider change. Normalize it before
   * building the wire payload so stale settings cannot create invalid calls. */
  normalize(requested: ReasoningConfig): ReasoningConfig
}

const AUTO_ONLY = ["auto"] as const
const OPENAI_LEVELS = ["auto", "low", "medium", "high"] as const
const BUDGET_LEVELS = ["auto", "off", "low", "medium", "high", "max", "custom"] as const
const THINKING_REQUIRED_BUDGETS = ["auto", "low", "medium", "high", "max", "custom"] as const
const THINKING_REQUIRED_LEVELS = ["auto", "low", "medium", "high", "max"] as const
const OLLAMA_LEVELS = ["auto", "off", "low", "medium", "high", "max"] as const
const TOGGLE_LEVELS = ["auto", "off"] as const
const DEEPSEEK_LEVELS = ["auto", "off", "high", "max"] as const

function capabilities(
  modes: readonly ReasoningMode[],
  customBudgetRange: { min: number; max: number } = { min: 1, max: 32_768 },
): ReasoningCapabilities {
  return {
    modes,
    customBudgetRange,
    normalize(requested) {
      if (!modes.includes(requested.mode)) return { mode: "auto" }
      if (requested.mode !== "custom") return { mode: requested.mode }
      const budget = Math.min(customBudgetRange.max, Math.floor(requested.budgetTokens ?? 0))
      if (budget > 0 && budget < customBudgetRange.min) {
        return { mode: "custom", budgetTokens: customBudgetRange.min }
      }
      return budget > 0 ? { mode: "custom", budgetTokens: budget } : { mode: "auto" }
    },
  }
}

function isClaude46OrLater(model: string): boolean {
  return /claude-(?:opus|sonnet|haiku)-4[-_.]?(?:[6-9]|\d{2,})(?:[-_.]|$)/i.test(model)
}

function isGemini25Pro(model: string): boolean {
  return /gemini[-_.]?2\.5[-_.]?pro(?:[-_.]|$)/i.test(model)
}

function isGemini3(model: string): boolean {
  return /gemini[-_.]?3(?:[-_.]|$)/i.test(model)
}

function isOpenAiReasoningModel(config: LlmConfig): boolean {
  if (config.provider === "azure" && config.azureModelFamily === "gpt5") return true
  const model = config.model.trim().toLowerCase()
  return /^(?:gpt-5|o\d+)(?:[.\-_]|$)/.test(model)
}

export function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase()
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")
  } catch {
    return false
  }
}

/**
 * Resolve only capabilities that are part of the selected wire contract.
 * Generic custom gateways deliberately stay Auto-only: a vendor-looking
 * model name does not prove that an aggregator accepts that vendor's private
 * request fields.
 */
export function resolveReasoningCapabilities(config: LlmConfig): ReasoningCapabilities {
  if (config.provider === "claude-code" || config.provider === "codex-cli") {
    return capabilities(AUTO_ONLY)
  }
  if (config.provider === "ollama") return capabilities(OLLAMA_LEVELS)
  if (config.provider === "google") {
    if (isGemini3(config.model)) return capabilities(THINKING_REQUIRED_LEVELS)
    if (isGemini25Pro(config.model)) {
      return capabilities(THINKING_REQUIRED_BUDGETS, { min: 128, max: 32_768 })
    }
    return capabilities(BUDGET_LEVELS)
  }
  if (config.provider === "anthropic") {
    return capabilities(
      isClaude46OrLater(config.model) ? THINKING_REQUIRED_LEVELS : BUDGET_LEVELS,
      { min: 1024, max: 32_768 },
    )
  }
  if (config.provider === "minimax") return capabilities(AUTO_ONLY)
  if (config.provider === "openai" || config.provider === "azure") {
    return capabilities(isOpenAiReasoningModel(config) ? OPENAI_LEVELS : AUTO_ONLY)
  }
  if (config.provider === "custom") {
    const endpoint = config.customEndpoint.toLowerCase()
    if (isOpenRouterEndpoint(endpoint)) return capabilities(BUDGET_LEVELS)
    if (/api\.deepseek\.(?:com|cn)(?:[:/]|$)/.test(endpoint)) {
      return capabilities(DEEPSEEK_LEVELS)
    }
    if (/xiaomimimo\.com(?:[:/]|$)/.test(endpoint)) {
      return capabilities(TOGGLE_LEVELS)
    }
    // Anthropic-compatible custom endpoints are not necessarily Anthropic
    // itself (MiniMax, Kimi and enterprise proxies differ), so omission is the
    // only portable default. Users can select a first-party preset when they
    // need vendor-specific controls.
    return capabilities(AUTO_ONLY)
  }
  return capabilities(AUTO_ONLY)
}

export function normalizeReasoningForProvider(
  config: LlmConfig,
  requested: ReasoningConfig,
): ReasoningConfig {
  return resolveReasoningCapabilities(config).normalize(requested)
}

/**
 * Reasoning for ingest's structured calls. Ingest hardcodes `{ mode: "off" }`
 * at every call site, which is the right default — thinking buys little on
 * structured extraction and a model that spends its budget on chain-of-thought
 * can return empty `content`, losing the page — but it is wrong as a *rule*:
 * some models reject disabling reasoning outright and answer 400, so every
 * ingest call fails with no way to fix it from the UI. Making it settable is
 * what lets those providers be used; "off" stays the default so existing
 * setups behave exactly as before.
 *
 * Keep this helper provider-agnostic. The provider layer normalizes the saved
 * value once when it builds the wire payload, including stale settings left by
 * a provider or model change.
 */
export function resolveIngestReasoning(config: LlmConfig): ReasoningConfig {
  return config.ingestReasoning ?? { mode: "off" }
}

export function isAdaptiveAnthropicModel(config: LlmConfig): boolean {
  return config.provider === "anthropic" && isClaude46OrLater(config.model)
}

export function isGeminiThinkingLevelModel(config: LlmConfig): boolean {
  return config.provider === "google" && isGemini3(config.model)
}
