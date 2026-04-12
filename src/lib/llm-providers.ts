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

function buildOpenAiBody(messages: ChatMessage[]): unknown {
  return { messages, stream: true }
}

function buildAnthropicBody(messages: ChatMessage[]): unknown {
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

function buildGoogleBody(messages: ChatMessage[]): unknown {
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

    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        buildBody: (messages) => ({
          ...buildAnthropicBody(messages),
          model,
        }),
        parseStream: parseAnthropicLine,
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

    case "ollama":
      return {
        url: `${ollamaUrl}/v1/chat/completions`,
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
        },
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
          model,
        }),
        parseStream: parseOpenAiLine,
      }

    case "minimax":
      return {
        url: "https://api.minimax.io/v1/chat/completions",
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          Authorization: `Bearer ${apiKey}`,
        },
        buildBody: (messages) => ({
          ...buildOpenAiBody(messages),
          model,
          temperature: 1.0,
        }),
        parseStream: parseOpenAiLine,
      }

    case "custom":
      return {
        url: `${customEndpoint}/chat/completions`,
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

    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown provider: ${String(exhaustive)}`)
    }
  }
}
