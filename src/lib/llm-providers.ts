import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"

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
function localLlmOriginHeader(): Record<string, string> {
  return { Origin: "http://localhost" }
}

function parseOpenAiLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
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

function parseOllamaLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as {
      message?: { content?: string }
    }
    return parsed.message?.content ?? null
  } catch {
    return null
  }
}

function parseAnthropicLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      type: string
      delta?: { type: string; text?: string }
    }
    if (
      parsed.type === "content_block_delta" &&
      parsed.delta?.type === "text_delta"
    ) {
      return parsed.delta.text ?? null
    }
    return null
  } catch {
    return null
  }
}

export function parseGoogleLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
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

function toOllamaMessage(message: ChatMessage): unknown {
  if (typeof message.content === "string") return message

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
  const images = message.content
    .filter((b) => b.type === "image")
    .map((b) => (b.type === "image" ? b.dataBase64 : ""))

  return {
    role: message.role,
    content: text,
    ...(images.length > 0 ? { images } : {}),
  }
}

function buildOllamaBody(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const reasoning = effectiveReasoning(config, overrides)
  const options: Record<string, unknown> = {}
  if (overrides?.temperature !== undefined) options.temperature = overrides.temperature
  if (overrides?.top_p !== undefined) options.top_p = overrides.top_p
  if (overrides?.top_k !== undefined) options.top_k = overrides.top_k
  if (overrides?.max_tokens !== undefined) options.num_predict = overrides.max_tokens
  if (overrides?.stop !== undefined) options.stop = overrides.stop
  if (config.maxContextSize > 0) options.num_ctx = config.maxContextSize

  return {
    model: config.model,
    messages: messages.map(toOllamaMessage),
    stream: true,
    ...(reasoning.mode === "off" ? { think: false } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  }
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

function isQwenThinkingModel(model: string): boolean {
  return /qwen[-_]?3/i.test(model)
}

function isOpenAiStrictCompletionModel(config: LlmConfig): boolean {
  if (config.provider !== "openai") return false
  const model = config.model.trim().toLowerCase()
  return /^gpt-5(?:[.\-_]|$)/.test(model) || /^o\d+(?:[.\-_]|$)/.test(model)
}

function adaptOpenAiStrictCompletionBody(config: LlmConfig, body: Record<string, unknown>): void {
  if (!isOpenAiStrictCompletionModel(config)) return

  if (typeof body.max_tokens === "number") {
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
  }

  // GPT-5 / o-series Chat Completions deployments reject non-default
  // sampling knobs. Keep this on the strict OpenAI path only so
  // OpenRouter/custom-compatible routes preserve their existing wire.
  delete body.temperature
  delete body.top_p
  delete body.top_k
}

function buildOpenAiCompatibleBody(
  config: LlmConfig,
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const reasoning = effectiveReasoning(config, overrides)
  const body: Record<string, unknown> = buildOpenAiBody(messages, stripWireAgnosticOverrides(overrides))
  adaptOpenAiStrictCompletionBody(config, body)

  if (isDeepSeekEndpoint(config)) {
    // DeepSeek V4 thinking mode. `thinking.type=disabled` is the most
    // important path for ingestion/rewrite tasks: it prevents the model
    // from spending the whole response on `reasoning_content` with no
    // final `content`.
    if (reasoning.mode === "off") {
      body.thinking = { type: "disabled" }
    } else if (reasoning.mode !== "auto") {
      body.thinking = { type: "enabled" }
      if (reasoning.mode === "high" || reasoning.mode === "max") {
        body.reasoning_effort = reasoning.mode
      }
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
 * For system messages, Anthropic accepts the top-level `system`
 * field as a string OR as a content-block array. We always
 * stringify system content here because every existing system-
 * prompt call site sends a string and the round-trip through
 * blocks is lossy.
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
 * Anthropic's top-level `system` field is a string, not blocks.
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

function buildAnthropicBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }))
  const system =
    systemMessages.map((m) => flattenAnthropicSystem(m.content)).join("\n") ||
    undefined

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
    normalized.startsWith("https://coding.dashscope.aliyuncs.com/apps/anthropic")
  )
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
  const trimmed = base.replace(/\/+$/, "")
  if (/\/v\d+\/messages$/i.test(trimmed)) return trimmed
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

function buildAnthropicHeaders(apiKey: string, url: string): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": JSON_CONTENT_TYPE,
  }
  if (requiresBearerAuth(url)) {
    base.Authorization = `Bearer ${apiKey}`
  } else {
    base["x-api-key"] = apiKey
    base["anthropic-version"] = "2023-06-01"
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
  model = "",
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
    generationConfig.thinkingConfig = isGemini3Model(model)
      ? { thinkingLevel: "minimal" }
      : { thinkingBudget: 0 }
  } else if (overrides?.reasoning && overrides.reasoning.mode !== "auto") {
    if (isGemini3Model(model)) {
      generationConfig.thinkingConfig = {
        thinkingLevel: googleThinkingLevel(overrides.reasoning),
      }
    } else {
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
  }

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }
}

function isGemini3Model(model: string): boolean {
  return /(?:^|\/)gemini-3(?:[.\-_]|$)/i.test(model.trim())
}

function googleThinkingLevel(reasoning: ReasoningConfig): "low" | "medium" | "high" | "minimal" {
  if (reasoning.mode === "off") return "minimal"
  if (reasoning.mode === "low") return "low"
  if (reasoning.mode === "medium") return "medium"
  if (reasoning.mode === "custom") {
    const budget = reasoning.budgetTokens ?? 4096
    if (budget <= 1024) return "low"
    if (budget <= 4096) return "medium"
    return "high"
  }
  return "high"
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
        buildBody: (messages, overrides) => ({
          ...buildAnthropicBodyWithReasoning(config, messages, overrides),
          model,
        }),
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
        }, model),
        parseStream: parseGoogleLine,
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
        url: `${ollamaBase}/api/chat`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...localLlmOriginHeader(),
        },
        buildBody: (messages, overrides) => buildOllamaBody(config, messages, overrides),
        parseStream: parseOllamaLine,
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
        buildBody: (messages, overrides) => ({
          ...buildAnthropicBodyWithReasoning(config, messages, overrides),
          model,
        }),
        parseStream: parseAnthropicLine,
      }
    }

    case "claude-code":
      // Claude Code CLI uses a subprocess transport (stdin/stdout JSON
      // stream), not HTTP. Dispatch happens one layer up in
      // streamChat() before getProviderConfig is called. Reaching this
      // branch means wiring is broken somewhere upstream.
      throw new Error(
        "claude-code provider uses subprocess transport; getProviderConfig should not be called for it",
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
          buildBody: (messages, overrides) => ({
            ...buildAnthropicBodyWithReasoning(config, messages, overrides),
            model,
          }),
          parseStream: parseAnthropicLine,
        }
      }
      // Defense-in-depth: settings-side EndpointField normalizes URLs on
      // blur, but older configs saved before that shipped may still carry
      // a pasted "/chat/completions" tail. Don't double-append in that
      // case, or we'd POST to ".../chat/completions/chat/completions".
      const base = customEndpoint.replace(/\/+$/, "")
      const url = /\/chat\/completions$/i.test(base)
        ? base
        : `${base}/chat/completions`
      return {
        url,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          // Local OpenAI-compatible servers (LM Studio, llama.cpp,
          // vLLM, LocalAI) often share Ollama's CORS sensitivity.
          // Same rationale as the `ollama` branch above.
          ...localLlmOriginHeader(),
        },
        buildBody: (messages, overrides) => ({
          ...buildOpenAiCompatibleBody(config, messages, overrides),
          model,
        }),
        parseStream: parseOpenAiLine,
      }
    }

    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown provider: ${String(exhaustive)}`)
    }
  }
}
