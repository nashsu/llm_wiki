import type { LlmConfig } from "@/stores/wiki-store"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface ProviderConfig {
  url: string
  headers: Record<string, string>
  buildBody: (messages: ChatMessage[]) => unknown
  parseStream: (line: string) => string | null
}

const JSON_CONTENT_TYPE = "application/json"

function parseOpenAiLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null
  try {
    const parsed = JSON.parse(data) as {
      choices: Array<{ delta: { content?: string; reasoning_content?: string } }>
    }
    const delta = parsed.choices?.[0]?.delta
    // Reasoning models (e.g. Nemotron, DeepSeek-R1) emit thinking tokens in
    // reasoning_content while content is null. Fall back so the accumulated
    // text includes both the thinking phase and the final answer.
    return delta?.content ?? delta?.reasoning_content ?? null
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

function parseGoogleLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  try {
    const parsed = JSON.parse(data) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string }> }
      }>
    }
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? null
  } catch {
    return null
  }
}

function buildOpenAiBody(messages: ChatMessage[]): Record<string, unknown> {
  // max_tokens must be set explicitly: without it many local servers (LM Studio,
  // llama.cpp) fall back to a small default (often 2 048) that is too short for
  // multi-file wiki generation. 8 192 matches common local model limits while
  // leaving ample room for reasoning models that spend tokens on thinking first.
  return { messages, stream: true, max_tokens: 8192 }
}

function buildAnthropicBody(messages: ChatMessage[]): Record<string, unknown> {
  const systemMessages = messages.filter((m) => m.role === "system")
  const conversationMessages = messages.filter((m) => m.role !== "system")
  const system = systemMessages.map((m) => m.content).join("\n") || undefined

  return {
    messages: conversationMessages,
    ...(system !== undefined ? { system } : {}),
    stream: true,
    max_tokens: 4096,
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
    normalized.startsWith("https://api.minimax.io/anthropic") ||
    normalized.startsWith("https://api.minimaxi.com/anthropic")
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

function buildGoogleBody(messages: ChatMessage[]): Record<string, unknown> {
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

  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
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
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
          model,
        }),
        parseStream: parseOpenAiLine,
      }

    case "anthropic": {
      const url = buildAnthropicUrl("https://api.anthropic.com")
      return {
        url,
        headers: buildAnthropicHeaders(apiKey, url),
        buildBody: (messages) => ({
          ...buildAnthropicBody(messages),
          model,
        }),
        parseStream: parseAnthropicLine,
      }
    }

    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "x-goog-api-key": apiKey,
        },
        buildBody: buildGoogleBody,
        parseStream: parseGoogleLine,
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
        },
        buildBody: (messages) => {
          const body: Record<string, unknown> = {
            ...buildOpenAiBody(messages),
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
        buildBody: (messages) => ({
          ...buildAnthropicBody(messages),
          model,
        }),
        parseStream: parseAnthropicLine,
      }
    }

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
          buildBody: (messages) => ({
            ...buildAnthropicBody(messages),
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
        },
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
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
