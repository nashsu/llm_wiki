// Server-side port of the desktop's chat-LLM resolution
// (src/lib/llm-task-routing.ts + src/components/settings/preset-resolver.ts +
// src/components/settings/llm-presets.ts). The web client's Settings UI writes
// the same persisted shapes (llmConfig / providerConfigs / presets / routing /
// project override) to the server store; this module resolves them into a
// final {provider, model, apiKey, endpoint, wire, headers} the agent uses,
// matching the desktop's behavior so a configured provider "just works".

const AZURE_OPENAI_API_VERSION = "2024-10-21"

// Minimal projection of the built-in preset table — only the fields the
// resolver consumes. Native providers are listed explicitly; every gateway
// preset is `provider: "custom"`.
const BUILTIN = {
  anthropic:        { provider: "anthropic",  defaultModel: "claude-sonnet-4-5-20250929" },
  "claude-code-cli":{ provider: "claude-code",defaultModel: "claude-sonnet-4-6" },
  "codex-cli":      { provider: "codex-cli",  defaultModel: "gpt-5.4-mini" },
  openai:           { provider: "openai",     defaultModel: "gpt-4o" },
  google:           { provider: "google",     defaultModel: "gemini-2.5-flash" },
  azure:            { provider: "azure",      defaultModel: "your-deployment-name", baseUrl: "https://your-resource.openai.azure.com", azureApiVersion: AZURE_OPENAI_API_VERSION },
  ollama:           { provider: "ollama",     defaultModel: "", baseUrl: "http://localhost:11434" },
  deepseek:         { provider: "custom", defaultModel: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com/v1", apiMode: "chat_completions" },
  atlascloud:       { provider: "custom", defaultModel: "deepseek-ai/deepseek-v4-pro", baseUrl: "https://api.atlascloud.ai/v1", apiMode: "chat_completions" },
  groq:             { provider: "custom", defaultModel: "llama-3.3-70b-versatile", baseUrl: "https://api.groq.com/openai/v1", apiMode: "chat_completions" },
  xai:              { provider: "custom", defaultModel: "grok-3", baseUrl: "https://api.x.ai/v1", apiMode: "chat_completions" },
  "nvidia-nim":     { provider: "custom", defaultModel: "meta/llama-3.3-70b-instruct", baseUrl: "https://integrate.api.nvidia.com/v1", apiMode: "chat_completions" },
  kimi:             { provider: "custom", defaultModel: "kimi-k2.6", baseUrl: "https://api.moonshot.ai/v1", apiMode: "chat_completions" },
  "kimi-cn":        { provider: "custom", defaultModel: "kimi-k2.6", baseUrl: "https://api.moonshot.cn/v1", apiMode: "chat_completions" },
  "kimi-coding-plan":{ provider: "custom", defaultModel: "kimi-for-coding", baseUrl: "https://api.kimi.com/coding/", apiMode: "chat_completions" },
  zhipu:            { provider: "custom", defaultModel: "glm-4.6", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiMode: "chat_completions" },
  "minimax-global": { provider: "custom", defaultModel: "MiniMax-M3", baseUrl: "https://api.minimax.io/anthropic", apiMode: "anthropic_messages" },
  "minimax-cn":     { provider: "custom", defaultModel: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/anthropic", apiMode: "anthropic_messages" },
  "bailian-coding": { provider: "custom", defaultModel: "qwen3-coder-plus", baseUrl: "https://coding.dashscope.aliyuncs.com/v1", apiMode: "chat_completions" },
}

export function findLlmPreset(id, customPresets = []) {
  if (BUILTIN[id]) return { id, ...BUILTIN[id] }
  const custom = customPresets.find((p) => p.id === id)
  if (custom) return { id: custom.id, label: custom.label, provider: "custom", apiMode: "chat_completions" }
  // Unknown id (a gateway preset not in the projection, or a deleted custom
  // preset): treat as a custom gateway so credentials from providerConfigs[id]
  // still apply. Native providers are all listed in BUILTIN above.
  return { id, provider: "custom", apiMode: "chat_completions" }
}

function clampInt(v, lo, hi, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : fallback
}

export function resolveConfig(preset, override, fallback) {
  const ov = override ?? {}
  const apiKey = ov.apiKey ?? ""
  const model = ov.model ?? preset.defaultModel ?? ""
  const maxContextSize = ov.maxContextSize ?? preset.suggestedContextSize ?? fallback?.maxContextSize
  const reasoning = ov.reasoning ?? { mode: "auto" }
  const requestTimeoutMinutes = clampInt(ov.requestTimeoutMinutes, 1, 1440, fallback?.requestTimeoutMinutes)
  const customHeaders = ov.customHeaders
  const streamingConfig = ov.streamingEnabled === undefined ? {} : { streamingEnabled: ov.streamingEnabled }

  if (preset.provider === "custom") {
    return { provider: "custom", apiKey, model, ollamaUrl: fallback?.ollamaUrl,
      customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "", maxContextSize,
      apiMode: ov.apiMode ?? preset.apiMode ?? "chat_completions", reasoning,
      requestTimeoutMinutes, customHeaders, ...streamingConfig }
  }
  if (preset.provider === "ollama") {
    return { provider: "ollama", apiKey: "", model, ollamaUrl: ov.baseUrl ?? preset.baseUrl ?? "http://localhost:11434",
      customEndpoint: fallback?.customEndpoint, maxContextSize, reasoning, requestTimeoutMinutes, customHeaders, ...streamingConfig }
  }
  if (preset.provider === "azure") {
    return { provider: "azure", apiKey, model, ollamaUrl: fallback?.ollamaUrl,
      customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "", azureApiVersion: ov.azureApiVersion ?? preset.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
      azureModelFamily: ov.azureModelFamily ?? preset.azureModelFamily ?? "auto", maxContextSize, reasoning, requestTimeoutMinutes, customHeaders, ...streamingConfig }
  }
  if (preset.provider === "claude-code" || preset.provider === "codex-cli") {
    return { provider: preset.provider, apiKey: "", model, ollamaUrl: fallback?.ollamaUrl, customEndpoint: fallback?.customEndpoint,
      maxContextSize, reasoning, localCliIsolation: ov.localCliIsolation === true,
      codexCliTimeoutMinutes: preset.provider === "codex-cli" ? clampInt(ov.codexCliTimeoutMinutes, 1, 240, undefined) : undefined,
      requestTimeoutMinutes, ...streamingConfig }
  }
  // native openai / anthropic / google
  return { ...fallback, provider: preset.provider, apiKey, model,
    ollamaUrl: fallback?.ollamaUrl, customEndpoint: ov.baseUrl ?? preset.baseUrl ?? "",
    maxContextSize, reasoning, requestTimeoutMinutes, customHeaders, ...streamingConfig }
}

function resolveProjectLlmConfig(globalConfig, providerConfigs, projectOverride, customPresets) {
  if (!projectOverride?.enabled || !projectOverride.presetId) return globalConfig
  const preset = findLlmPreset(projectOverride.presetId, customPresets)
  if (!preset) return globalConfig
  const baseOverride = providerConfigs?.[projectOverride.presetId]
  const override = (projectOverride.model || "").trim()
    ? { ...baseOverride, model: projectOverride.model.trim() }
    : baseOverride
  return resolveConfig(preset, override, globalConfig)
}

/**
 * Shared task-routing resolution. `presetKey` selects which routing slot the
 * task reads ("chatPresetId" | "ingestPresetId") — mirrors the desktop's
 * resolveTaskLlmConfig(task, …) in src/lib/llm-task-routing.ts. A project
 * override, when enabled, wins over task routing for both tasks (desktop
 * parity: the project override IS the fallback the routing would defer to).
 */
function resolveTaskConfig(store, presetKey) {
  const llmConfig = store.llmConfig ?? {}
  const providerConfigs = store.providerConfigs ?? {}
  const routing = store.taskModelRouting ?? { chatPresetId: null, ingestPresetId: null }
  const projectOverride = store.projectLlmOverride
  const customPresets = Array.isArray(store.customLlmPresets) ? store.customLlmPresets : []
  if (projectOverride?.enabled) {
    return resolveProjectLlmConfig(llmConfig, providerConfigs, projectOverride, customPresets)
  }
  const presetId = routing?.[presetKey] ?? null
  if (!presetId) return llmConfig
  const preset = findLlmPreset(presetId, customPresets)
  return resolveConfig(preset, providerConfigs?.[presetId], llmConfig)
}

/** Read the persisted store snapshot and resolve the effective chat config. */
export function resolveChatConfig(store) {
  return resolveTaskConfig(store, "chatPresetId")
}

/** Read the persisted store snapshot and resolve the effective ingest config. */
export function resolveIngestConfig(store) {
  return resolveTaskConfig(store, "ingestPresetId")
}

// Providers that operate without an API key (port of src/lib/has-usable-llm.ts):
// ollama/custom run against local-or-LAN endpoints; claude-code/codex-cli
// authenticate via local CLI logins (and are rejected by normalizeEndpoint on
// the web server anyway — guarded separately).
const PROVIDERS_WITHOUT_KEY = new Set(["ollama", "custom", "claude-code", "codex-cli"])

/** Is this resolved config good enough to make LLM calls? (desktop parity) */
export function hasUsableLlmConfig(cfg) {
  if (PROVIDERS_WITHOUT_KEY.has(cfg?.provider)) return true
  return ((cfg?.apiKey ?? "") + "").trim().length > 0
}

const DEFAULT_ENDPOINTS = {
  openai: "https://api.openai.com/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
}

function joinOpenAI(base) {
  base = base.replace(/\/+$/, "")
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}
function joinAnthropic(base) {
  base = base.replace(/\/+$/, "")
  if (/\/messages$/.test(base)) return base
  if (/\/v1$/.test(base)) return `${base}/messages`
  return `${base}/v1/messages`
}

/** Turn a resolved LlmConfig into {wire, url, headers} for an outbound call. */
export function normalizeEndpoint(cfg) {
  const provider = cfg.provider
  if (provider === "claude-code" || provider === "codex-cli") {
    throw new Error(`${provider} providers run a local CLI and require the desktop app; configure an API-based provider for the web client.`)
  }
  const wire = provider === "anthropic" || (provider === "custom" && cfg.apiMode === "anthropic_messages")
    ? "anthropic" : "openai"
  const custom = (cfg.customEndpoint || cfg.ollamaUrl || "").trim()
  let url
  if (provider === "ollama") {
    url = joinOpenAI(`${(cfg.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "")}/v1`)
  } else if (provider === "azure") {
    if (!custom) throw new Error("Azure OpenAI requires a deployment endpoint in Settings.")
    const sep = custom.includes("?") ? "&" : "?"
    url = /\/chat\/completions$/.test(custom) ? custom : joinOpenAI(custom)
    url = `${url}${sep}api-version=${encodeURIComponent(cfg.azureApiVersion || AZURE_OPENAI_API_VERSION)}`
  } else if (custom) {
    url = wire === "anthropic" ? joinAnthropic(custom) : joinOpenAI(custom)
  } else {
    url = DEFAULT_ENDPOINTS[wire] || DEFAULT_ENDPOINTS.openai
  }
  const headers = { "Content-Type": "application/json", ...(cfg.customHeaders || {}) }
  if (cfg.apiKey) {
    if (wire === "anthropic" && provider === "anthropic") headers["x-api-key"] = cfg.apiKey
    else headers["Authorization"] = `Bearer ${cfg.apiKey}`
    if (wire === "anthropic") headers["anthropic-version"] = "2023-06-01"
  }
  return { wire, url, headers, model: cfg.model || "" }
}
