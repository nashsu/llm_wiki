import type { LlmConfig } from "@/stores/wiki-store"
import type { ProviderOverride } from "@/stores/wiki-store"
import { AZURE_OPENAI_API_VERSION } from "@/lib/azure-openai"
import type { LlmPreset } from "./llm-presets"

/**
 * Build the deliberately unusable sentinel config persisted when every
 * LLM preset is disabled.  A keyed provider with an empty key makes
 * hasUsableLlm() return false even if the previously active provider
 * was keyless, such as Ollama, Claude Code CLI, or Codex CLI.  The
 * spread keeps saved details available for settings forms; re-enabling
 * a preset reads its real values from providerConfigs[].
 */
export function disabledLlmConfig(fallback: LlmConfig): LlmConfig {
  return {
    ...fallback,
    provider: "openai",
    apiKey: "",
  }
}

/**
 * Build a full LlmConfig from a preset template + the user's saved
 * override fields for that preset. Falls back to the preset defaults
 * (or the existing LlmConfig) when an override is missing.
 */
export function resolveConfig(
  preset: LlmPreset,
  override: ProviderOverride | undefined,
  fallback: LlmConfig,
): LlmConfig {
  const ov = override ?? {}
  const apiKey = ov.apiKey ?? ""
  const model = ov.model ?? preset.defaultModel ?? ""
  const maxContextSize =
    ov.maxContextSize ?? preset.suggestedContextSize ?? fallback.maxContextSize
  const reasoning = ov.reasoning ?? { mode: "auto" as const }
  const localCliIsolation = ov.localCliIsolation === true
  const codexCliTimeoutMinutes =
    typeof ov.codexCliTimeoutMinutes === "number" && Number.isFinite(ov.codexCliTimeoutMinutes)
      ? Math.max(1, Math.min(240, Math.floor(ov.codexCliTimeoutMinutes)))
      : undefined
  const requestTimeoutMinutes =
    typeof ov.requestTimeoutMinutes === "number" && Number.isFinite(ov.requestTimeoutMinutes)
      ? Math.max(1, Math.min(1440, Math.floor(ov.requestTimeoutMinutes)))
      : fallback.requestTimeoutMinutes

  if (preset.provider === "custom") {
    return {
      provider: "custom",
      apiKey,
      model,
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "",
      maxContextSize,
      apiMode: ov.apiMode ?? preset.apiMode ?? "chat_completions",
      reasoning,
      localCliIsolation: false,
      requestTimeoutMinutes,
    }
  }

  if (preset.provider === "ollama") {
    return {
      provider: "ollama",
      apiKey: "",
      model,
      ollamaUrl: ov.baseUrl ?? preset.baseUrl ?? "http://localhost:11434",
      customEndpoint: fallback.customEndpoint,
      maxContextSize,
      reasoning,
      localCliIsolation: false,
      requestTimeoutMinutes,
    }
  }

  if (preset.provider === "azure") {
    return {
      provider: "azure",
      apiKey,
      model,
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "",
      azureApiVersion: ov.azureApiVersion ?? preset.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
      azureModelFamily: ov.azureModelFamily ?? preset.azureModelFamily ?? "auto",
      maxContextSize,
      reasoning,
      localCliIsolation: false,
      requestTimeoutMinutes,
    }
  }

  if (preset.provider === "claude-code" || preset.provider === "codex-cli") {
    // Subprocess transport — no apiKey, no endpoint URL. Model id is
    // passed straight to the local CLI's model flag.
    return {
      provider: preset.provider,
      apiKey: "",
      model,
      ollamaUrl: fallback.ollamaUrl,
      customEndpoint: fallback.customEndpoint,
      maxContextSize,
      reasoning,
      localCliIsolation,
      codexCliTimeoutMinutes: preset.provider === "codex-cli" ? codexCliTimeoutMinutes : undefined,
      requestTimeoutMinutes,
    }
  }

  // openai / anthropic / google / minimax — use fixed endpoint baked into the
  // provider dispatch. We still let users override baseUrl via apiKey env if
  // needed by editing manually, but presets for these don't expose it.
  return {
    provider: preset.provider,
    apiKey,
    model,
    ollamaUrl: fallback.ollamaUrl,
    customEndpoint: fallback.customEndpoint,
    maxContextSize,
    reasoning,
    localCliIsolation: false,
    requestTimeoutMinutes,
  }
}
