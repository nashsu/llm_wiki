/**
 * Curated LLM provider presets.
 *
 * Selecting a preset pre-fills the underlying LlmConfig fields so users
 * don't have to remember endpoint URLs / API mode per vendor. The
 * dispatch code in `src/lib/llm-providers.ts` still branches on the
 * lower-level `provider` field — presets just populate the config.
 */
export type CustomApiMode = "chat_completions" | "anthropic_messages"

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "custom"
  | "minimax"
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"

export interface LlmPreset {
  /** Stable id used as the dropdown value. */
  id: string
  /** Display label in the dropdown. */
  label: string
  /** Short subtitle shown under the label. */
  hint?: string
  /** Underlying provider dispatch key (see llm-providers.ts). */
  provider: Provider
  /** Suggested base URL. `customEndpoint` for custom, `ollamaUrl` for ollama, ignored for built-ins. */
  baseUrl?: string
  /**
   * For vendors that serve the same model catalog over both an OpenAI-
   * compatible and an Anthropic-compatible endpoint at different URLs
   * (e.g. Alibaba Bailian Coding Plan), list the URL per wire mode.
   * The settings UI auto-swaps `baseUrl` when the user flips the API
   * mode toggle — so one preset covers both protocols instead of two.
   */
  baseUrlByMode?: Partial<Record<CustomApiMode, string>>
  /** Suggested default model; user can override. */
  defaultModel?: string
  /**
   * Curated list of model ids the UI shows as clickable chips above the
   * Model input. The user can still type a custom value — the input stays
   * free-form. An empty/missing list means "no suggestions, type freely"
   * (e.g. Ollama Local where the model set is whatever the user pulled).
   */
  suggestedModels?: string[]
  /** Custom providers only: which wire protocol to speak. */
  apiMode?: CustomApiMode
  /** Suggested context window; user can override. */
  suggestedContextSize?: number
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: "codex-cli",
    label: "Codex CLI (GPT OAuth)",
    hint: "Uses local `codex login` / ChatGPT OAuth — no API key needed",
    provider: "codex-cli",
    defaultModel: "gpt-5.1-codex-mini",
    suggestedModels: [
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex",
      "gpt-5.1",
      "gpt-5-mini",
      "o3",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "gemini-cli-oauth",
    label: "Gemini CLI (Antigravity OAuth)",
    hint: "Uses local `gemini` Google OAuth — no API key needed",
    provider: "gemini-cli",
    defaultModel: "gemini-2.5-flash",
    suggestedModels: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ],
    suggestedContextSize: 1000000,
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Official Claude API",
    provider: "anthropic",
    defaultModel: "claude-sonnet-4-5-20250929",
    // Cross-referenced with hermes-agent/hermes_cli/models.py:233-242.
    // Both shortened and dated aliases work on api.anthropic.com.
    suggestedModels: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
    suggestedContextSize: 200000,
  },
  {
    id: "claude-code-cli",
    label: "Claude Code CLI (local)",
    hint: "Uses the local `claude` binary — no API key needed",
    provider: "claude-code",
    defaultModel: "claude-sonnet-4-6",
    // Mirrors anthropic preset; the CLI forwards to the same Anthropic
    // backend, so model ids are identical. Users with a subscription
    // can pick Opus/Sonnet/Haiku here without paying an API key bill.
    suggestedModels: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ],
    suggestedContextSize: 200000,
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    hint: "Official OpenAI API",
    provider: "openai",
    defaultModel: "gpt-4o",
    // Current public GPT models on api.openai.com. Reasoning models and
    // the 4.1 family are both exposed under the chat/completions route.
    suggestedModels: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "o3",
      "o3-mini",
      "o1",
      "o1-mini",
      "gpt-4-turbo",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "google",
    label: "Google (Gemini)",
    hint: "Generative Language API",
    provider: "google",
    defaultModel: "gemini-2.5-flash",
    // 2.5 generation is the current stable; 2.0 kept as fallback.
    suggestedModels: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ],
    suggestedContextSize: 1000000,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "api.deepseek.com",
    provider: "custom",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    apiMode: "chat_completions",
    // hermes models.py:243-246
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    suggestedContextSize: 64000,
  },
  {
    id: "groq",
    label: "Groq",
    hint: "api.groq.com",
    provider: "custom",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    apiMode: "chat_completions",
    // Groq hosts open-weight models; list stays current-practical picks.
    suggestedModels: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "llama-3.1-70b-versatile",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
      "moonshotai/kimi-k2-instruct",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3-32b",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    hint: "api.x.ai",
    provider: "custom",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3",
    apiMode: "chat_completions",
    suggestedModels: [
      "grok-4-latest",
      "grok-4",
      "grok-3",
      "grok-3-mini",
      "grok-3-fast",
      "grok-3-mini-fast",
      "grok-code-fast-1",
      "grok-2-vision-1212",
    ],
    suggestedContextSize: 131072,
  },
  {
    id: "nvidia-nim",
    label: "NVIDIA NIM",
    hint: "integrate.api.nvidia.com",
    provider: "custom",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiMode: "chat_completions",
    // NVIDIA's build.nvidia.com hosts both their own Nemotron family
    // and a rotating catalog of popular third-party open-weight models
    // behind the same OpenAI-compatible endpoint. API key is issued
    // per-user from build.nvidia.com. Full catalog is huge and
    // changes often — this is a practical subset; users can type any
    // other id into the custom input.
    defaultModel: "meta/llama-3.3-70b-instruct",
    suggestedModels: [
      // NVIDIA's own reasoning / agentic models
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-nano-30b-a3b",
      // Meta Llama family
      "meta/llama-3.3-70b-instruct",
      "meta/llama-3.1-405b-instruct",
      "meta/llama-3.1-70b-instruct",
      // Popular third-party agentic / open-weight
      "deepseek-ai/deepseek-v3.2",
      "moonshotai/kimi-k2.6",
      "qwen/qwen3.5-397b-a17b",
      "minimaxai/minimax-m2.7",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
      "openai/gpt-oss-120b",
      // Mistral family
      "mistralai/mixtral-8x22b-instruct",
      "mistralai/mistral-large-2-instruct",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    hint: "api.moonshot.ai",
    provider: "custom",
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.6",
    apiMode: "chat_completions",
    // Current Moonshot lineup. The older `moonshot-v1-*` and
    // `kimi-k2-0905-preview` / `-turbo-preview` ids are being
    // deprecated on 2026-05-25 and dropped from the picker already —
    // users who still need them can type the id into the custom input.
    suggestedModels: [
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-k2-thinking",
      "kimi-for-coding",
    ],
    suggestedContextSize: 256000,
  },
  {
    id: "kimi-cn",
    label: "Kimi (Moonshot, 中国)",
    hint: "api.moonshot.cn",
    provider: "custom",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.6",
    apiMode: "chat_completions",
    suggestedModels: [
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-k2-thinking",
      "kimi-for-coding",
    ],
    suggestedContextSize: 256000,
  },
  {
    id: "zhipu",
    label: "智谱 GLM (Zhipu)",
    hint: "open.bigmodel.cn",
    provider: "custom",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.6",
    apiMode: "chat_completions",
    // Current-gen Zhipu BigModel lineup. glm-5 / glm-5.1 are routed
    // through the Z.AI international endpoint (api.z.ai) so they're
    // not on this preset's suggestion list — users targeting those
    // should type the id or point the base URL at api.z.ai.
    suggestedModels: [
      "glm-4.6",
      "glm-4.5",
      "glm-4.5-air",
      "glm-4.5-airx",
      "glm-4.5-flash",
      "glm-4-plus",
      "glm-4-air",
      "glm-4-flash",
      "glm-zero-preview",
      "glm-4v-plus",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "minimax-global",
    label: "MiniMax (Global)",
    hint: "api.minimax.io/anthropic",
    provider: "custom",
    baseUrl: "https://api.minimax.io/anthropic",
    defaultModel: "MiniMax-M2.7",
    apiMode: "anthropic_messages",
    // Current-gen only. M2 and M2.1 are legacy and being retired —
    // users who need them can type the id into the custom input.
    suggestedModels: ["MiniMax-M2.7", "MiniMax-M2.5"],
    suggestedContextSize: 200000,
  },
  {
    id: "minimax-cn",
    label: "MiniMax (中国)",
    hint: "api.minimaxi.com/anthropic",
    provider: "custom",
    baseUrl: "https://api.minimaxi.com/anthropic",
    defaultModel: "MiniMax-M2.7",
    apiMode: "anthropic_messages",
    suggestedModels: ["MiniMax-M2.7", "MiniMax-M2.5"],
    suggestedContextSize: 200000,
  },
  {
    id: "bailian-coding",
    label: "阿里百炼 Coding Plan",
    hint: "coding.dashscope.aliyuncs.com",
    provider: "custom",
    // Default wire is OpenAI-compat. Flipping the "API 模式" toggle to
    // Anthropic-compat auto-swaps the base URL via baseUrlByMode below,
    // so users don't have to know the two URLs exist.
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    apiMode: "chat_completions",
    baseUrlByMode: {
      chat_completions: "https://coding.dashscope.aliyuncs.com/v1",
      anthropic_messages: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    },
    // Bailian's subscription-only "Coding Plan" exposes the same model
    // catalog on both wires. Key must come from the Bailian console's
    // Coding Plan tab — a regular DashScope key will 401. The
    // Anthropic-compat path uses Bearer auth (see requiresBearerAuth
    // in llm-providers.ts), matching the MiniMax gateway convention.
    defaultModel: "qwen3.6-plus",
    suggestedModels: [
      "qwen3.6-plus",
      "kimi-k2.5",
      "glm-5",
      "MiniMax-M2.5",
      "qwen3.5-plus",
      "qwen3-max-2026-01-23",
      "qwen3-coder-plus",
      "qwen3-coder-next",
      "glm-4.7",
    ],
    suggestedContextSize: 131072,
  },
  {
    id: "xiaomi-mimo",
    label: "小米 MiMo (Xiaomi)",
    hint: "api.xiaomimimo.com",
    provider: "custom",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiMode: "chat_completions",
    // Standard OpenAI-wire endpoint at api.xiaomimimo.com/v1.
    // Preflight explicitly whitelists `authorization` + `content-type`,
    // so browser fetch would work too — but all LLM calls still go
    // through the Tauri HTTP plugin for uniformity. Model list from
    // hermes-agent (hermes_cli/models.py:247-251).
    defaultModel: "mimo-v2-pro",
    suggestedModels: ["mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash"],
    suggestedContextSize: 131072,
  },
  {
    id: "volcengine-ark",
    label: "火山引擎 Ark (Volcengine)",
    hint: "ark.cn-beijing.volces.com/api/coding/v3",
    provider: "custom",
    // Volcengine Ark's "coding" product line mandates this exact base URL
    // per their official docs. Their other OpenAI-compat base (api/v3) is
    // not a valid substitute. This endpoint rejects browser-origin fetch
    // via CORS (allow-headers omits `authorization`), so LLM calls route
    // through Tauri's HTTP plugin — see src/lib/llm-client.ts.
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    apiMode: "chat_completions",
    // Exact model catalog Volcengine's Coding product line accepts on
    // this endpoint. The older `doubao-*-1-5-*` / `doubao-seed-1-6-*` /
    // `deepseek-v3-250324` ids that work on the general Ark endpoints
    // are NOT available here and will 400.
    defaultModel: "Doubao-Seed-2.0-Code",
    suggestedModels: [
      "Doubao-Seed-2.0-Code",
      "Doubao-Seed-2.0-pro",
      "Doubao-Seed-2.0-lite",
      "Doubao-Seed-Code",
      "MiniMax-M2.5",
      "Kimi-K2.5",
      "GLM-4.7",
      "DeepSeek-V3",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "ollama-local",
    label: "Ollama (Local)",
    hint: "Self-hosted llama.cpp / Ollama",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    // Intentionally no suggestedModels: local set depends on what the
    // user has actually pulled / loaded. Kept as free-text input.
    suggestedContextSize: 32768,
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    hint: "ollama.com",
    provider: "custom",
    baseUrl: "https://ollama.com/v1",
    apiMode: "chat_completions",
    // Ollama Cloud catalog rotates frequently — keep short common picks.
    suggestedModels: [
      "gpt-oss:120b",
      "gpt-oss:20b",
      "qwen3-coder:480b",
      "kimi-k2:1t",
      "deepseek-v3.1:671b",
    ],
    suggestedContextSize: 128000,
  },
  {
    id: "custom",
    label: "Custom",
    hint: "Any OpenAI- or Anthropic-compatible endpoint",
    provider: "custom",
    // Wire protocol is chosen via the "API 模式" toggle in the expanded
    // panel — no need for separate presets per mode. User supplies the
    // base URL manually (no baseUrlByMode: nothing we can auto-fill).
    apiMode: "chat_completions",
    // No suggestedModels: user knows what their gateway exposes.
  },
]

/**
 * Best-effort reverse lookup: given the current LlmConfig fields, which
 * preset does it most likely correspond to? Used so the dropdown can
 * show the user what they're effectively on.
 */
export function matchPreset(params: {
  provider: Provider
  customEndpoint: string
  ollamaUrl: string
  apiMode?: CustomApiMode
}): LlmPreset | null {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase()
  const { provider, customEndpoint, ollamaUrl, apiMode } = params

  for (const preset of LLM_PRESETS) {
    if (preset.provider !== provider) continue
    if (provider === "custom") {
      if (!preset.baseUrl) continue // skip the generic Custom catch-alls
      if (norm(preset.baseUrl) !== norm(customEndpoint)) continue
      if ((preset.apiMode ?? "chat_completions") !== (apiMode ?? "chat_completions"))
        continue
      return preset
    }
    if (provider === "ollama") {
      if (preset.baseUrl && norm(preset.baseUrl) !== norm(ollamaUrl)) continue
      return preset
    }
    return preset
  }
  return null
}
