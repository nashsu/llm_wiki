import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"
import {
  AZURE_OPENAI_API_VERSION,
  buildAzureOpenAiUrl,
  isAzureOpenAiEndpoint,
} from "@/lib/azure-openai"

/**
 * One piece of a multimodal message body. Text + image is the only
 * shape we use today; the discriminated union makes it cheap to
 * extend (audio, file, tool_result …) without re-typing every
 * call site.
 *
 * `dataBase64` holds the raw image bytes encoded as base64 — NOT a
 * `data:` URL. The provider-specific translators below own the
 * `data:image/png;base64,…` framing because each wire prefers a
 * different shape (OpenAI puts it inside `image_url.url`, Anthropic
 * splits the mime type out into `source.media_type`, Gemini uses
 * `inline_data.mime_type`/`inline_data.data`). Putting the framing
 * in the translators keeps the producer (image extractor) provider-
 * agnostic.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string }

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  /**
   * `string` is the legacy shape — every existing call site uses it,
   * and providers that don't speak vision (or callers that don't
   * have images to send) keep working unchanged.
   *
   * `ContentBlock[]` unlocks vision input. Each provider's
   * `buildBody` translates it into the native wire format; see
   * `toOpenAiContent` / `toAnthropicContent` / `toGooglePart` /
   * `extractOllamaImages` below.
   */
  content: string | ContentBlock[]
}

/**
 * Sampling knobs a caller can pass to `streamChat` without caring about
 * the underlying wire's naming. Each provider's `buildBody` is
 * responsible for translating these into its native schema — OpenAI-
 * style wires accept them at the top level, Gemini demands they live
 * under `generationConfig` with renamed keys (`top_p` → `topP`,
 * `max_tokens` → `maxOutputTokens`, etc.). Missing fields are left
 * unset; providers keep their existing defaults.
 */
export interface RequestOverrides {
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  stop?: string | string[]
  reasoning?: ReasoningConfig
}

interface ProviderConfig {
  url: string
  headers: Record<string, string>
  buildBody: (messages: ChatMessage[], overrides?: RequestOverrides) => unknown
  parseStream: (line: string) => string | null
}

const JSON_CONTENT_TYPE = "application/json"

/**
 * Origin header for local-LLM endpoints (Ollama, LM Studio, llama.cpp
 * server, LocalAI, vLLM, …).
 *
 * Always sets `Origin: http://localhost` regardless of where the
 * actual server is. Two interlocking reasons:
 *
 *   1. We MUST override the platform default. `@tauri-apps/plugin-
 *      http` v2.5.x auto-injects the webview's own origin
 *      (`tauri://localhost` on macOS/Linux,
 *      `http://tauri.localhost` on Windows). Ollama's default
 *      `OLLAMA_ORIGINS` allowlist accepts `tauri://*` since ~0.1.30
 *      but NOT `http://tauri.localhost` — without our override,
 *      Windows users hit 403. (User packet capture v0.3.11.)
 *
 *   2. We can't override with the request's REAL origin because
 *      that breaks cross-machine LAN setups. A user pointing at
 *      `http://192.168.0.20:11434/v1` would get `Origin:
 *      http://192.168.0.20:11434`, which is NOT in Ollama's
 *      default OLLAMA_ORIGINS — Ollama then 403s or RST-closes
 *      the connection, surfacing as a generic "error sending
 *      request" reqwest error. The earlier code claimed Ollama
 *      did same-origin bypass; it does not. Reported by user
 *      v0.4.2.
 *
 * `http://localhost` is unconditionally in Ollama's default
 * OLLAMA_ORIGINS list (`http://localhost`, `http://localhost:*`,
 * `http://127.0.0.1*`, etc.). LM Studio / llama.cpp / vLLM /
 * LocalAI don't check Origin at all, so the value is ignored
 * there. The header is purely a CORS-allowlist signal — semantic
 * "where this request came from" is meaningless here because the
 * server uses API keys (or no auth), not origin, for actual
 * permission checks.
 *
 * Users who actively tightened OLLAMA_ORIGINS to remove localhost
 * (rare) need to re-add `http://localhost` to their server config;
 * no client-side fix can satisfy a hand-locked allowlist that
 * specifically excludes the one origin every other LLM client
 * also relies on.
 *
 * Why this overrides at all: plugin-http's JS shim respects user-
 * set headers (see `node_modules/@tauri-apps/plugin-http/dist-js/
 * index.js` — the loop after `new Request(input, init)` only fills
 * browser-default headers when the user did NOT already set them).
 * Rust-side, the `unsafe-headers` feature flag in
 * `src-tauri/Cargo.toml` lets reqwest forward Origin without
 * stripping it. End-to-end our value wins.
 */
export function localLlmOriginHeader(): Record<string, string> {
  return { Origin: "http://localhost" }
}

export function isLocalOrPrivateHttpEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    const host = url.hostname.toLowerCase()
    if (host === "localhost" || host.endsWith(".localhost")) return true
    if (host === "127.0.0.1" || host === "::1" || host === "[::1]") return true
    if (/^10\./.test(host)) return true
    if (/^192\.168\./.test(host)) return true
    const m = host.match(/^172\.(\d+)\./)
    if (m) {
      const second = Number(m[1])
      if (second >= 16 && second <= 31) return true
    }
    return false
  } catch {
    return false
  }
}

function parseOpenAiLine(line: string): string | null {
  if (!line.startsWith("data:")) return null
  const data = line.slice(5).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as {
      choices: Array<{ delta: { content?: string } }>
    }
    return parsed.choices?.[0]?.delta?.content ?? null
  } catch {
    return null
  }
}

export function parseAnthropicLine(line: string): string | null {
  if (!line.startsWith("data:")) return null
  const data = line.slice(5).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>

    // Standard Anthropic streaming: content_block_delta with text_delta
    const delta = parsed.delta as Record<string, unknown> | undefined
    if (
      parsed.type === "content_block_delta" &&
      (delta?.type === "text_delta" || typeof delta?.text === "string")
    ) {
      return (delta.text as string) ?? null
    }

    // Some third-party Anthropic-compatible gateways (e.g. Kimi/Moonshot)
    // emit the complete assistant message as a single SSE event instead
    // of incremental content_block_delta chunks.
    if (
      parsed.type === "message" &&
      Array.isArray(parsed.content)
    ) {
      const text = (parsed.content as Array<Record<string, unknown>>)
        .map((block) => typeof block.text === "string" ? block.text : "")
        .join("")
      return text.length > 0 ? text : null
    }

    // Fallback: misconfigured proxies occasionally return OpenAI-shaped
    // chunks on an Anthropic wire. Extract delta.content when present.
    const choices = parsed.choices as Array<Record<string, unknown>> | undefined
    if (choices && choices[0]) {
      const choiceDelta = choices[0].delta as Record<string, unknown> | undefined
      if (typeof choiceDelta?.content === "string") return choiceDelta.content
    }

    return null
  } catch {
    return null
  }
}

export function parseGoogleLine(line: string): string | null {
  if (!line.startsWith("data:")) return null
  const data = line.slice(5).trim()
  try {
    const parsed = JSON.parse(data) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string; thought?: boolean }> }
      }>
    }
    // Gemini can split a single event's output across multiple parts —
    // common with 2.5/3.x reasoning models, which interleave
    // `thought: true` parts (chain-of-thought) with the real answer.
    // Previous impl only took parts[0].text, silently dropping anything
    // that came in a later part. Concatenate all visible text parts and
    // skip ones flagged as thoughts so we don't leak reasoning text into
    // the user-visible stream.
    const parts = parsed.candidates?.[0]?.content?.parts
    if (!parts || parts.length === 0) return null
    let out = ""
    for (const p of parts) {
      if (p.thought) continue
      if (p.text) out += p.text
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * Translate a `ChatMessage.content` into the OpenAI Chat Completions
 * `content` field. The wire accepts either a plain string or an
 * array of `{type:"text"|"image_url", ...}` parts; we use the array
 * form only when the message actually carries an image, so single-
 * string requests stay byte-identical to what we sent before vision
 * existed (avoids accidentally regressing endpoints that lag behind
 * the spec — quite a few llama.cpp and vLLM builds in the wild
 * still parse `content: string` faster than `content: [...]`).
 *
 * Image bytes are emitted as a `data:` URL inside `image_url.url`.
 * `image_url` accepts both URLs and data URLs; data URL keeps every
 * byte in the request (no follow-up GET from the model server),
 * which is what we want for desktop-LLM endpoints that may not
 * have outbound network access at all.
 */
function toOpenAiContent(content: string | ContentBlock[]): unknown {
  if (typeof content === "string") return content
  // Pure-text block array → flatten to a string so we don't force
  // every provider proxy to handle parts. Same wire either way.
  if (content.every((b) => b.type === "text")) {
    return content.map((b) => (b.type === "text" ? b.text : "")).join("")
  }
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text }
    return {
      type: "image_url",
      image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` },
    }
  })
}

function buildOpenAiBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  // OpenAI (and every /v1/chat/completions clone — DeepSeek, Groq,
  // Ollama, Zhipu, Kimi, xAI, MiniMax OpenAI-compat, ...) accepts these
  // knobs at the top level using the names clients already send.
  const translated = messages.map((m) => ({
    role: m.role,
    content: toOpenAiContent(m.content),
  }))
  return { messages: translated, stream: true, ...stripWireAgnosticOverrides(overrides) }
}

function stripWireAgnosticOverrides(overrides?: RequestOverrides): Omit<RequestOverrides, "reasoning"> {
  const { reasoning: _reasoning, ...rest } = overrides ?? {}
  return rest
}

function effectiveReasoning(config: LlmConfig, overrides?: RequestOverrides): ReasoningConfig {
  return overrides?.reasoning ?? config.reasoning ?? { mode: "auto" }
}

function isDeepSeekEndpoint(config: LlmConfig): boolean {
  return /deepseek/i.test(config.model) || /deepseek/i.test(config.customEndpoint)
}

function supportsDeepSeekThinkingParam(config: LlmConfig): boolean {
  return /deepseek[-_]?v4/i.test(config.model)
}

function isQwenThinkingModel(model: string): boolean {
  return /qwen[-_]?3/i.test(model)
}

function isKimiEndpoint(config: LlmConfig): boolean {
  return /(^|[/:.-])kimi([/:.-]|$)/i.test(config.model)
    || /moonshot/i.test(config.model)
    || /api\.moonshot\.(ai|cn)/i.test(config.customEndpoint)
}

function isXiaomiMimoEndpoint(config: LlmConfig): boolean {
  return /(^|[/:.-])mimo([/:.-]|$)/i.test(config.model)
    || /\.?xiaomimimo\.com(?::|\/|$)/i.test(config.customEndpoint)
}

function isBigModelEndpoint(config: LlmConfig): boolean {
  return /(?:^|\/\/)open\.bigmodel\.cn(?:[:/]|$)/i.test(config.customEndpoint)
}

function isGlmVisionModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return /(?:^|[-_.])glm[-_.]5v[-_.]turbo(?:[-_.]|$)/i.test(normalized)
    || /(?:^|[-_.])glm[-_.]4\.?6v(?:[-_.]|$)/i.test(normalized)
    || /(?:^|[-_.])glm[-_.]4\.?5v(?:[-_.]|$)/i.test(normalized)
    || /(?:^|[-_.])glm[-_.]4v(?:[-_.]|$)/i.test(normalized)
}

function isOpenAiStrictCompletionModel(config: LlmConfig): boolean {
  if ((config.provider === "azure" || (config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)))
    && config.azureModelFamily === "gpt5") {
    return true
  }

  const model = config.model.trim().toLowerCase()
  const strictModel =
    /^gpt-5(?:[.\-_]|$)/.test(model) || /^o\d+(?:[.\-_]|$)/.test(model)
  if (!strictModel) return false
  if (config.provider === "openai" || config.provider === "azure") return true
  return config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)
}

function adaptOpenAiStrictCompletionBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isOpenAiStrictCompletionModel(config)) return

  if (typeof body.max_tokens === "number") {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }

  // GPT-5 / o-series Chat Completions deployments reject non-default
  // sampling knobs. Structured ingest passes temperature=0.1, so strip
  // these only on the strict OpenAI path; custom/OpenRouter-compatible
  // routes keep their existing behavior.
  delete body.temperature
  delete body.top_p
  delete body.top_k
}

function adaptKimiBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isKimiEndpoint(config)) return

  // Moonshot/Kimi OpenAI-compatible endpoints reject non-default
  // temperature values for several current models ("only 1 is allowed").
  // Structured ingest/dedup pass temperature=0.1 for determinism, so
  // omit it and let the endpoint use its required default.
  delete body.temperature
}

function adaptXiaomiMimoBody(
  config: LlmConfig,
  body: Record<string, unknown>,
  reasoning: ReasoningConfig,
): void {
  if (!isXiaomiMimoEndpoint(config)) return

  // Xiaomi MiMo's OpenAI-compatible examples use
  // `max_completion_tokens`. Accept callers' provider-agnostic
  // `max_tokens` override but send the documented field on the wire.
  if (typeof body.max_tokens === "number") {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }

  // Official thinking-mode control documents `thinking.type=disabled`.
  // Do not invent an enabled/budget shape here; omitting the field lets
  // the server apply the model default.
  if (reasoning.mode === "off") {
    body.thinking = { type: "disabled" }
  } else {
    // MiMo v2.5 thinking mode forces temperature=1.0 and rejects
    // custom temperature. Structured ingest passes temperature=0.1,
    // but it also passes reasoning off above, so keep deterministic
    // non-thinking requests intact while protecting thinking requests.
    delete body.temperature
  }
}

function buildOpenAiCompatibleBody(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  assertBigModelImageSupport(config, messages)
  const reasoning = effectiveReasoning(config, overrides)
  const body: Record<string, unknown> = buildOpenAiBody(messages, stripWireAgnosticOverrides(overrides))
  adaptOpenAiStrictCompletionBody(config, body)
  adaptKimiBody(config, body)
  adaptXiaomiMimoBody(config, body, reasoning)

  if (isDeepSeekEndpoint(config)) {
    // DeepSeek V4 thinking mode. `thinking.type=disabled` is the most
    // important path for ingestion/rewrite tasks: it prevents the model
    // from spending the whole response on `reasoning_content` with no
    // final `content`.
    if (supportsDeepSeekThinkingParam(config)) {
      if (reasoning.mode === "off") {
        body.thinking = { type: "disabled" }
      } else if (reasoning.mode !== "auto") {
        body.thinking = { type: "enabled" }
        if (reasoning.mode === "high" || reasoning.mode === "max") {
          body.reasoning_effort = reasoning.mode
        }
      }
    }
    return body
  }

  if (config.provider === "ollama") {
    // Ollama's OpenAI-compatible /v1/chat/completions maps reasoning
    // control onto `reasoning_effort` ("high"|"medium"|"low"|"none";
    // "none" disables thinking). This is the only lever that stops a
    // thinking-capable model — or a non-thinking one Ollama wraps with a
    // thinking template — from spending its entire token budget on
    // chain-of-thought and ending the stream with an empty `content`,
    // which surfaces to the user as the "produced N chars of reasoning,
    // but no actual response content" diagnostic. Until this, callers'
    // `reasoning: { mode: "off" }` (every structured ingest call) was
    // silently dropped on the Ollama path. Non-thinking models (gemma,
    // llama) ignore the field harmlessly. "max" has no Ollama analogue,
    // so it maps to the strongest supported level, "high".
    // See docs.ollama.com/api/openai-compatibility.
    if (reasoning.mode === "off") {
      body.reasoning_effort = "none"
    } else if (
      reasoning.mode === "low" ||
      reasoning.mode === "medium" ||
      reasoning.mode === "high"
    ) {
      body.reasoning_effort = reasoning.mode
    } else if (reasoning.mode === "max") {
      body.reasoning_effort = "high"
    }
    return body
  }

  if (reasoning.mode === "off" && isQwenThinkingModel(config.model)) {
    body.chat_template_kwargs = { enable_thinking: false }
  }

  if (config.provider === "openai" && reasoning.mode !== "auto" && reasoning.mode !== "off") {
    if (reasoning.mode === "low" || reasoning.mode === "medium" || reasoning.mode === "high") {
      body.reasoning_effort = reasoning.mode
    }
  }

  return body
}

/**
 * Translate `ChatMessage.content` into Anthropic Messages
 * `content`. Anthropic requires the array form for any non-text
 * block, and uses a different shape than OpenAI for images
 * (`source.media_type` + `source.data` instead of a `data:` URL).
 *
 * System messages are flattened separately into the top-level
 * `system` field. Anthropic accepts that field as either a string or a
 * text-block array; we use the block array form there so the system
 * prompt can opt into prompt caching.
 */
function toAnthropicContent(content: string | ContentBlock[]): unknown {
  if (typeof content === "string") return content
  if (content.every((b) => b.type === "text")) {
    return content.map((b) => (b.type === "text" ? b.text : "")).join("")
  }
  return content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: b.mediaType,
        data: b.dataBase64,
      },
    }
  })
}

/**
 * Anthropic's top-level `system` field accepts a string or text blocks.
 * If a caller puts images inside a system message we drop them —
 * Anthropic doesn't accept system-level images today, and silently
 * losing them is the lesser evil compared to the request 400ing
 * out for "Unsupported content block in system".
 */
function flattenAnthropicSystem(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
}

function buildAnthropicSystem(systemText: string): unknown[] | undefined {
  if (!systemText) return undefined
  // Anthropic Messages wire only. OpenAI/Gemini-compatible providers
  // use different system-prompt shapes and do not understand this
  // cache_control marker.
  return [
    {
      type: "text",
      text: systemText,
      cache_control: { type: "ephemeral" },
    },
  ]
}

function buildAnthropicBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }))
  const systemText = systemMessages
    .map((m) => flattenAnthropicSystem(m.content))
    .join("\n")
  const system = buildAnthropicSystem(systemText)

  // Anthropic Messages uses top_p / top_k (Python-style snake_case), a
  // mandatory `max_tokens`, and `stop_sequences` instead of `stop`.
  // Overrides may still set max_tokens to stretch long outputs.
  return {
    messages: conversationMessages,
    ...(system !== undefined ? { system } : {}),
    stream: true,
    max_tokens: overrides?.max_tokens ?? 4096,
    ...(overrides?.temperature !== undefined ? { temperature: overrides.temperature } : {}),
    ...(overrides?.top_p !== undefined ? { top_p: overrides.top_p } : {}),
    ...(overrides?.top_k !== undefined ? { top_k: overrides.top_k } : {}),
    ...(overrides?.stop !== undefined
      ? { stop_sequences: Array.isArray(overrides.stop) ? overrides.stop : [overrides.stop] }
      : {}),
  }
}

function buildAnthropicBodyWithReasoning(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const body = buildAnthropicBody(messages, overrides)
  const reasoning = effectiveReasoning(config, overrides)
  if (reasoning.mode === "auto" || reasoning.mode === "off") return body

  const budget =
    reasoning.mode === "custom" && reasoning.budgetTokens !== undefined
      ? reasoning.budgetTokens
      : reasoning.mode === "low"
        ? 1024
        : reasoning.mode === "medium"
          ? 4096
        : 8192
  const budgetTokens = Math.max(1024, budget)
  if ((body.max_tokens as number) <= budgetTokens) {
    body.max_tokens = budgetTokens + 1
  }
  body.thinking = { type: "enabled", budget_tokens: budgetTokens }
  delete body.temperature
  delete body.top_p
  delete body.top_k
  return body
}

function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some((m) =>
    Array.isArray(m.content) && m.content.some((block) => block.type === "image"),
  )
}

/**
 * Some Anthropic-compatible third-party endpoints (MiniMax global + CN)
 * serve the Messages API but authenticate with `Authorization: Bearer`
 * instead of Anthropic-native `x-api-key`. See hermes-agent
 * `agent/anthropic_adapter.py:_requires_bearer_auth` for reference.
 *
 * This also matters for CORS: MiniMax's preflight lists `Authorization`
 * in `Access-Control-Allow-Headers` but NOT `x-api-key`, so sending the
 * Anthropic-native header gets blocked by the browser before the request
 * even leaves.
 */
function requiresBearerAuth(url: string): boolean {
  const normalized = url.toLowerCase().replace(/\/+$/, "")
  return (
    // MiniMax — CORS allow-headers doesn't include x-api-key
    normalized.startsWith("https://api.minimax.io/anthropic") ||
    normalized.startsWith("https://api.minimaxi.com/anthropic") ||
    // Alibaba Bailian Coding Plan — issues sk-xxx bearer-style tokens
    // on its /apps/anthropic gateway; behavior matches the other
    // Chinese Anthropic-wire proxies above.
    normalized.startsWith("https://coding.dashscope.aliyuncs.com/apps/anthropic") ||
    // Xiaomi MiMo Token Plan Anthropic gateway authenticates with
    // Authorization Bearer, matching its OpenAI-compatible gateway.
    /(^https:\/\/|^)token-plan-cn\.xiaomimimo\.com\/anthropic(?:\/|$)/i.test(normalized) ||
    // Kimi Coding Plan — uses Authorization: Bearer, not x-api-key.
    // The coding endpoint (api.kimi.com/coding) is separate from the
    // Moonshot open platform (api.moonshot.ai) and expects Bearer auth
    // on both its OpenAI- and Anthropic-compatible wires.
    normalized.startsWith("https://api.kimi.com/coding") ||
    // Moonshot open platform Anthropic-compatible wires (global + CN)
    // also authenticate with Bearer tokens, matching their OpenAI wire.
    normalized.startsWith("https://api.moonshot.ai/anthropic") ||
    normalized.startsWith("https://api.moonshot.cn/anthropic")
  )
}

function isMiniMaxAnthropicHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === "api.minimax.io" || parsed.hostname === "api.minimaxi.com"
  } catch {
    return false
  }
}

function normalizeMiniMaxAnthropicBase(base: string): string {
  if (!isMiniMaxAnthropicHost(base)) return base

  try {
    const parsed = new URL(base)
    const path = parsed.pathname.replace(/\/+$/, "")
    if (path === "" || path === "/" || /^\/v\d+(?:\/messages)?$/i.test(path)) {
      parsed.pathname = "/anthropic"
      parsed.search = ""
      parsed.hash = ""
      return parsed.toString().replace(/\/+$/, "")
    }
  } catch {
    return base
  }

  return base
}

function isOfficialMiniMaxAnthropicUrl(url: string): boolean {
  if (!isMiniMaxAnthropicHost(url)) return false
  try {
    const parsed = new URL(url)
    return /^\/anthropic(?:\/|$)/i.test(parsed.pathname)
  } catch {
    return false
  }
}

function isMiniMaxM3Model(model: string): boolean {
  return /^minimax-m3(?:[-_.]|$)/i.test(model.trim())
}

function assertMiniMaxImageSupport(url: string, model: string, messages: ChatMessage[]): void {
  if (!isOfficialMiniMaxAnthropicUrl(url) || !hasImageContent(messages) || isMiniMaxM3Model(model)) return
  throw new Error(
    "MiniMax image input is supported only by MiniMax-M3 on the official Anthropic-compatible endpoint. Switch the model to MiniMax-M3 or use another vision-capable provider.",
  )
}

function assertBigModelImageSupport(config: LlmConfig, messages: ChatMessage[]): void {
  if (!isBigModelEndpoint(config) || !hasImageContent(messages) || isGlmVisionModel(config.model)) return
  throw new Error(
    "Zhipu BigModel image input is supported only by GLM vision models. Switch to glm-5v-turbo, glm-4.6v, glm-4.5v, or glm-4v-plus.",
  )
}

export function supportsImageInput(config: LlmConfig): boolean {
  if (config.provider === "codex-cli") return false
  if (config.provider === "minimax") return isMiniMaxM3Model(config.model)
  if (isBigModelEndpoint(config)) return isGlmVisionModel(config.model)
  if ((config.provider === "custom") && (config.apiMode ?? "chat_completions") === "anthropic_messages") {
    const url = buildAnthropicUrl(config.customEndpoint)
    return !isOfficialMiniMaxAnthropicUrl(url) || isMiniMaxM3Model(config.model)
  }
  return true
}

/**
 * Build the final POST URL for an Anthropic-wire endpoint given whatever
 * base the user provided. Handles every shape we've seen in the wild:
 *
 *   .../v1/messages    → as-is (user pasted the full path)
 *   .../v1             → append /messages (don't double the /v1)
 *   .../api/paas/v4    → append /messages (arbitrary version segment)
 *   .../anthropic      → append /v1/messages (MiniMax-style proxy base)
 *   .../               → append /v1/messages (bare host)
 *
 * A bug where this naively appended "/v1/messages" caused requests to
 * ".../v1/v1/messages" (404) whenever a user typed a URL ending in /v1.
 */
export function buildAnthropicUrl(base: string): string {
  const trimmed = normalizeMiniMaxAnthropicBase(base).replace(/\/+$/, "")
  if (/\/v\d+\/messages$/i.test(trimmed)) return trimmed
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

function buildAnthropicHeaders(apiKey: string, url: string): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": JSON_CONTENT_TYPE,
    "anthropic-version": "2023-06-01",
  }
  if (requiresBearerAuth(url)) {
    base.Authorization = `Bearer ${apiKey}`
  } else {
    base["x-api-key"] = apiKey
    base["anthropic-dangerous-direct-browser-access"] = "true"
  }
  return base
}

/**
 * Translate `ChatMessage.content` into Gemini `parts`. Gemini's
 * native shape is already block-like (`parts: [{text}|{inline_data}]`)
 * so the mapping is mostly cosmetic — we don't try to flatten
 * single-text-block arrays because Gemini accepts the array form
 * uniformly.
 */
function toGoogleParts(content: string | ContentBlock[]): unknown[] {
  if (typeof content === "string") return [{ text: content }]
  return content.map((b) => {
    if (b.type === "text") return { text: b.text }
    return {
      inline_data: {
        mime_type: b.mediaType,
        data: b.dataBase64,
      },
    }
  })
}

function flattenGoogleSystemParts(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content.map((b) => (b.type === "text" ? b.text : "")).join("")
}

function buildGoogleBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")

  const contents = conversationMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: toGoogleParts(m.content),
  }))

  // Gemini's `systemInstruction.parts` is a `parts` array but in
  // practice every consumer flattens it to a string equivalent —
  // images in a system instruction are not a documented use case.
  // Keep it text-only.
  const systemInstruction =
    systemMessages.length > 0
      ? {
          parts: systemMessages.map((m) => ({ text: flattenGoogleSystemParts(m.content) })),
        }
      : undefined

  // Gemini rejects sampling knobs at the top level (HTTP 400
  // "Unknown name 'temperature': Cannot find field.") — everything
  // must live under `generationConfig` with Gemini-specific naming:
  //   top_p       → topP
  //   top_k       → topK
  //   max_tokens  → maxOutputTokens
  //   stop        → stopSequences (array)
  // Build it only when the caller actually passed something, so an
  // unmodified request stays minimal and lets server defaults apply.
  const generationConfig: Record<string, unknown> = {}
  if (overrides?.temperature !== undefined) generationConfig.temperature = overrides.temperature
  if (overrides?.top_p !== undefined) generationConfig.topP = overrides.top_p
  if (overrides?.top_k !== undefined) generationConfig.topK = overrides.top_k
  if (overrides?.max_tokens !== undefined) generationConfig.maxOutputTokens = overrides.max_tokens
  if (overrides?.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(overrides.stop) ? overrides.stop : [overrides.stop]
  }
  if (overrides?.reasoning?.mode === "off") {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  } else if (overrides?.reasoning && overrides.reasoning.mode !== "auto") {
    const budget =
      overrides.reasoning.mode === "custom" && overrides.reasoning.budgetTokens !== undefined
        ? overrides.reasoning.budgetTokens
        : overrides.reasoning.mode === "low"
          ? 1024
          : overrides.reasoning.mode === "medium"
            ? 4096
            : 8192
    generationConfig.thinkingConfig = { thinkingBudget: budget }
  }

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }
}

export function getProviderConfig(config: LlmConfig): ProviderConfig {
  const { provider, apiKey, model, ollamaUrl, customEndpoint } = config

  switch (provider) {
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${apiKey}`,
        },
        buildBody: (messages, overrides) => ({
          ...buildOpenAiCompatibleBody(config, messages, overrides),
          model,
        }),
        parseStream: parseOpenAiLine,
      }

    case "anthropic": {
      const url = buildAnthropicUrl("https://api.anthropic.com")
      return {
        url,
        headers: buildAnthropicHeaders(apiKey, url),
        buildBody: (messages, overrides) => {
          assertMiniMaxImageSupport(url, model, messages)
          return {
            ...buildAnthropicBodyWithReasoning(config, messages, overrides),
            model,
          }
        },
        parseStream: parseAnthropicLine,
      }
    }

    case "google": {
      // Encode the model segment — users sometimes paste OpenRouter-style
      // ids with slashes (e.g. "google/gemini-3-pro-preview") and bare
      // interpolation would produce a broken URL. encodeURIComponent
      // handles that plus any other path-illegal characters.
      const encodedModel = encodeURIComponent(model)
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:streamGenerateContent?alt=sse`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "x-goog-api-key": apiKey,
        },
        buildBody: (messages, overrides) => buildGoogleBody(messages, {
          ...(overrides ?? {}),
          reasoning: effectiveReasoning(config, overrides),
        }),
        parseStream: parseGoogleLine,
      }
    }

    case "azure": {
      return {
        url: buildAzureOpenAiUrl(
          customEndpoint,
          model,
          config.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
        ),
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "api-key": apiKey,
        },
        buildBody: (messages, overrides) =>
          buildOpenAiCompatibleBody(config, messages, overrides),
        parseStream: parseOpenAiLine,
      }
    }

    case "ollama": {
      // Defense-in-depth for the same reason as the custom branch: if a
      // user pasted the full path as their Ollama URL, don't tack on
      // another copy. Also strip a bare trailing "/v1" so the user can
      // enter either form ("http://host:11434" or "http://host:11434/v1").
      let ollamaBase = ollamaUrl.replace(/\/+$/, "")
      if (/\/v1\/chat\/completions$/i.test(ollamaBase)) {
        ollamaBase = ollamaBase.replace(/\/v1\/chat\/completions$/i, "")
      } else if (/\/v1$/i.test(ollamaBase)) {
        ollamaBase = ollamaBase.replace(/\/v1$/i, "")
      }
      return {
        url: `${ollamaBase}/v1/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...localLlmOriginHeader(),
        },
        buildBody: (messages, overrides) => ({
          ...buildOpenAiCompatibleBody(config, messages, overrides),
          model,
        }),
        parseStream: parseOpenAiLine,
      }
    }

    case "minimax": {
      // MiniMax's real API is Anthropic Messages at /anthropic, not
      // OpenAI chat completions. customEndpoint can point at either the
      // global (.io) or China (.minimaxi.com) regional endpoint; default
      // to the global one when unset. Auth uses Bearer (see
      // buildAnthropicHeaders / requiresBearerAuth above).
      const url = buildAnthropicUrl(customEndpoint || "https://api.minimax.io/anthropic")
      return {
        url,
        headers: buildAnthropicHeaders(apiKey, url),
        buildBody: (messages, overrides) => {
          assertMiniMaxImageSupport(url, model, messages)
          return {
            ...buildAnthropicBodyWithReasoning(config, messages, overrides),
            model,
          }
        },
        parseStream: parseAnthropicLine,
      }
    }

    case "claude-code":
    case "codex-cli":
      // Local CLI providers use subprocess transports (stdin/stdout JSON
      // streams), not HTTP. Dispatch happens one layer up in
      // streamChat() before getProviderConfig is called. Reaching this
      // branch means wiring is broken somewhere upstream.
      throw new Error(
        `${provider} provider uses subprocess transport; getProviderConfig should not be called for it`,
      )

    case "custom": {
      // Custom endpoints can speak either OpenAI's /chat/completions
      // wire or Anthropic's /v1/messages wire. The field `apiMode` on
      // the config picks which. Default (missing) = chat_completions
      // so pre-0.3.7 configs keep working unchanged.
      const mode = config.apiMode ?? "chat_completions"
      if (mode === "anthropic_messages") {
        const url = buildAnthropicUrl(customEndpoint)
        return {
          url,
          headers: buildAnthropicHeaders(apiKey, url),
          buildBody: (messages, overrides) => {
            assertMiniMaxImageSupport(url, model, messages)
            return {
              ...buildAnthropicBodyWithReasoning(config, messages, overrides),
              model,
            }
          },
          parseStream: parseAnthropicLine,
        }
      }
      // Defense-in-depth: settings-side EndpointField normalizes URLs on
      // blur, but older configs saved before that shipped may still carry
      // a pasted "/chat/completions" tail. Don't double-append in that
      // case, or we'd POST to ".../chat/completions/chat/completions".
      const base = customEndpoint.replace(/\/+$/, "")
      const url = isAzureOpenAiEndpoint(base)
        ? buildAzureOpenAiUrl(
            base,
            model,
            config.azureApiVersion ?? AZURE_OPENAI_API_VERSION,
          )
        : /\/chat\/completions$/i.test(base)
          ? base
          : `${base}/chat/completions`
      const azure = isAzureOpenAiEndpoint(url)
      return {
        url,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...(apiKey
            ? azure
              ? { "api-key": apiKey }
              : { Authorization: `Bearer ${apiKey}` }
            : {}),
          // Only local/LAN OpenAI-compatible servers (LM Studio,
          // llama.cpp, vLLM, LocalAI) need the Ollama-style Origin
          // workaround. Public custom gateways may reject unexpected
          // browser Origin headers, so leave them untouched.
          ...(!azure && isLocalOrPrivateHttpEndpoint(url) ? localLlmOriginHeader() : {}),
        },
        buildBody: (messages, overrides) => {
          const body = buildOpenAiCompatibleBody(config, messages, overrides)
          if (!azure) body.model = model
          return body
        },
        parseStream: parseOpenAiLine,
      }
    }

    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown provider: ${String(exhaustive)}`)
    }
  }
}
