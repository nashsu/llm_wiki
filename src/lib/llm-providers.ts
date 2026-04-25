import type { LlmConfig } from "@/stores/wiki-store"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
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
 * Why we set this explicitly:
 *   `@tauri-apps/plugin-http` v2.5.x auto-injects the webview's
 *   own Origin (`tauri://localhost` on macOS/Linux,
 *   `http://tauri.localhost` on Windows). Ollama's default
 *   `OLLAMA_ORIGINS` allowlist accepts `tauri://*` since ~0.1.30
 *   but NOT `http://tauri.localhost` — so Windows users hit 403
 *   even when everything is configured correctly. A user packet
 *   capture (v0.3.11) confirmed the request carrying
 *   `origin: http://tauri.localhost`.
 *
 * Setting Origin to the request's own host = same-origin, which
 * Ollama always trusts regardless of `OLLAMA_ORIGINS` value or
 * Ollama version.
 *
 * Why this works at all:
 *   plugin-http's JS shim respects user-set headers (see
 *   `node_modules/@tauri-apps/plugin-http/dist-js/index.js`,
 *   the loop after `new Request(input, init)` only fills
 *   browser-default headers when the user did NOT already set
 *   them). On the Rust side, the `unsafe-headers` feature flag
 *   in `src-tauri/Cargo.toml` lets reqwest forward Origin
 *   without stripping it. End-to-end this means our value wins.
 *
 * If `url` can't be parsed (mis-typed config), we return {} —
 * better to send no override than to crash building the request.
 */
function sameOriginHeader(url: string): Record<string, string> {
  try {
    return { Origin: new URL(url).origin }
  } catch {
    return {}
  }
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

function buildOpenAiBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  // OpenAI (and every /v1/chat/completions clone — DeepSeek, Groq,
  // Ollama, Zhipu, Kimi, xAI, MiniMax OpenAI-compat, ...) accepts these
  // knobs at the top level using the names clients already send.
  return { messages, stream: true, ...(overrides ?? {}) }
}

function buildAnthropicBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")
  const system = systemMessages.map((m) => m.content).join("\n") || undefined

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
    // Alibaba Bailian Token Plan — same bearer-style auth on its
    // Anthropic-compatible gateway.
    normalized.startsWith("https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic")
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

function buildGoogleBody(
  messages: ChatMessage[],
  overrides?: RequestOverrides,
): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")

  const contents = conversationMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }))

  const systemInstruction =
    systemMessages.length > 0
      ? {
          parts: systemMessages.map((m) => ({ text: m.content })),
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
          ...buildOpenAiBody(messages, overrides),
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
          ...buildAnthropicBody(messages, overrides),
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
        buildBody: buildGoogleBody,
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
        url: `${ollamaBase}/v1/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          ...sameOriginHeader(ollamaBase),
        },
        buildBody: (messages, overrides) => {
          const body: Record<string, unknown> = {
            ...buildOpenAiBody(messages, overrides),
            model,
          }
          // Qwen3 thinking mode disable. Recognized by llama.cpp server
          // launched with `--jinja` (reads chat_template_kwargs from the
          // OpenAI body and forwards to the Jinja chat template). Real
          // Ollama silently ignores unknown fields, so this is safe.
          // Requires llama-server --jinja; without it, thinking stays on.
          if (/qwen[-_]?3/i.test(model)) {
            body.chat_template_kwargs = { enable_thinking: false }
          }
          return body
        },
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
        buildBody: (messages, overrides) => ({
          ...buildAnthropicBody(messages, overrides),
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
            ...buildAnthropicBody(messages, overrides),
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
          ...sameOriginHeader(base),
        },
        buildBody: (messages, overrides) => ({
          ...buildOpenAiBody(messages, overrides),
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
