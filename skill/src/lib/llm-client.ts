/**
 * Node.js llm-client — replaces Tauri HTTP plugin-based LLM streaming.
 * Uses Node.js native fetch for HTTP requests.
 */
import type { LlmConfig } from "../shims/stores-node"

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

export interface RequestOverrides {
  temperature?: number
  max_tokens?: number
}

/**
 * Build the request body for OpenAI-compatible APIs.
 */
function buildBody(config: LlmConfig, messages: ChatMessage[], overrides?: RequestOverrides) {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  }
  if (overrides?.temperature !== undefined) body.temperature = overrides.temperature
  if (overrides?.max_tokens !== undefined) body.max_tokens = overrides.max_tokens
  return body
}

/**
 * Get the API endpoint URL.
 */
function getUrl(config: LlmConfig): string {
  if (config.baseUrl) {
    const base = config.baseUrl.replace(/\/+$/, "")
    if (base.endsWith("/chat/completions")) return base
    if (base.endsWith("/v1")) return `${base}/chat/completions`
    return `${base}/v1/chat/completions`
  }
  switch (config.provider) {
    case "openai": return "https://api.openai.com/v1/chat/completions"
    case "anthropic": return "https://api.anthropic.com/v1/messages"
    default: return "https://api.openai.com/v1/chat/completions"
  }
}

/**
 * Get the API headers.
 */
function getHeaders(config: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`
  }
  return headers
}

/**
 * Stream chat completion from an OpenAI-compatible API.
 * Replaces Tauri-based streamChat with Node.js native fetch + SSE parsing.
 */
export async function streamChat(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  const url = getUrl(config)
  const headers = getHeaders(config)
  const body = buildBody(config, messages, requestOverrides)

  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) { onDone(); return }
    onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = await response.text()
      if (body) errorDetail += ` — ${body.slice(0, 500)}`
    } catch { /* ignore */ }
    onError(new Error(errorDetail))
    return
  }

  if (!response.body) {
    onError(new Error("Response body is null"))
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (lineBuffer.trim()) {
          const token = parseSSELine(lineBuffer.trim())
          if (token !== null) onToken(token)
        }
        break
      }

      const text = lineBuffer + decoder.decode(value, { stream: true })
      const lines = text.split("\n")
      lineBuffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const token = parseSSELine(trimmed)
        if (token !== null) onToken(token)
      }
    }
    onDone()
  } catch (err) {
    if (signal?.aborted) { onDone(); return }
    onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    reader.releaseLock()
  }
}

/**
 * Parse a single SSE line and extract the content delta token.
 */
function parseSSELine(line: string): string | null {
  if (!line.startsWith("data: ")) return null
  const data = line.slice(6).trim()
  if (data === "[DONE]") return null

  try {
    const parsed = JSON.parse(data)
    // OpenAI format
    const delta = parsed.choices?.[0]?.delta
    if (delta?.content) return delta.content
    // Some providers use different field names
    if (typeof parsed.content === "string") return parsed.content
    return null
  } catch {
    return null
  }
}
