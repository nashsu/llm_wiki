import type { LlmConfig } from "@/stores/wiki-store"
import { getProviderConfig, type RequestOverrides } from "./llm-providers"
import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"

export type { ChatMessage, RequestOverrides } from "./llm-providers"
export { isFetchNetworkError } from "./tauri-fetch"

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

// Lazy import keeps the Tauri event/invoke bindings out of bundles that
// never touch the subprocess provider (e.g. vitest with a fetch mock).
async function streamViaClaudeCodeCli(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
) {
  const mod = await import("./claude-cli-transport")
  return mod.streamClaudeCodeCli(config, messages, callbacks, signal, requestOverrides)
}

const DECODER = new TextDecoder()

function parseLines(chunk: Uint8Array, buffer: string): [string[], string] {
  const text = buffer + DECODER.decode(chunk, { stream: true })
  const lines = text.split("\n")
  const remaining = lines.pop() ?? ""
  return [lines, remaining]
}

export async function streamChat(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  /**
   * Wire-agnostic sampling knobs. The provider's buildBody() translates
   * these into its native schema — OpenAI-style wires accept them at
   * the top level ({temperature: 0.1}), Gemini nests them under
   * generationConfig with renamed keys ({generationConfig: {temperature: 0.1}}).
   * Previously we spread them onto the body here, which broke Gemini
   * with "Unknown name 'temperature': Cannot find field." HTTP 400.
   */
  requestOverrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  // Claude Code CLI uses a subprocess transport (stdin/stdout), not
  // HTTP. Dispatch before getProviderConfig — that function throws for
  // this provider because it has no URL/headers.
  if (config.provider === "claude-code") {
    return streamViaClaudeCodeCli(config, messages, callbacks, signal, requestOverrides)
  }

  const providerConfig = getProviderConfig(config)

  // Combined abort: (a) user cancel, (b) our long-horizon timeout.
  // The long timeout is a backstop for truly stuck requests; it's NOT
  // what fires when a user sees "Timeout" after 2 seconds — that is
  // almost always a fast network failure (DNS, TLS, 404, refused) that
  // WebKit surfaces as a generic "Load failed". We track whether the
  // backstop actually fired so we can tell the two apart in the error.
  const timeoutMs = 30 * 60 * 1000 // 30 min — generous backstop for huge-context reasoning models
  let combinedSignal = signal
  let timeoutController: AbortController | undefined
  let timeoutFired = false

  if (typeof AbortSignal.timeout === "function") {
    timeoutController = new AbortController()
    const timeoutId = setTimeout(() => {
      timeoutFired = true
      timeoutController?.abort()
    }, timeoutMs)

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId)
        timeoutController?.abort()
      })
    }
    combinedSignal = timeoutController.signal
  }

  let response: Response
  try {
    const body = providerConfig.buildBody(messages, requestOverrides)
    const httpFetch = await getHttpFetch()
    response = await httpFetch(providerConfig.url, {
      method: "POST",
      headers: providerConfig.headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
  } catch (err) {
    if (signal?.aborted) {
      onDone()
      return
    }
    if (err instanceof Error && err.name === "AbortError") {
      // Backstop timeout aborted the request (we tracked this via
      // timeoutFired); treat it as a real timeout rather than a cancel.
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      onDone()
      return
    }
    if (isFetchNetworkError(err)) {
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      // Fast fetch failure: DNS, TLS handshake, connection refused,
      // wrong endpoint, CORS preflight rejection, etc. All webviews
      // collapse this class of failure into an opaque error — point
      // users at the likely cause (endpoint / key / connectivity).
      onError(new Error(`Network error reaching ${providerConfig.url}. Check endpoint URL, API key, and connectivity.`))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = await response.text()
      if (body) errorDetail += ` — ${body}`
    } catch {
      // ignore body read failure
    }
    onError(new Error(errorDetail))
    return
  }

  if (!response.body) {
    onError(new Error("Response body is null"))
    return
  }

  const reader = response.body.getReader()
  let lineBuffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        if (lineBuffer.trim()) {
          const token = providerConfig.parseStream(lineBuffer.trim())
          if (token !== null) onToken(token)
        }
        break
      }

      const [lines, remaining] = parseLines(value, lineBuffer)
      lineBuffer = remaining

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const token = providerConfig.parseStream(trimmed)
        if (token !== null) onToken(token)
      }
    }

    onDone()
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || (signal?.aborted))) {
      onDone()
      return
    }
    if (isFetchNetworkError(err)) {
      // Stream reader threw a network error mid-response (connection
      // dropped, server closed early, network blip). Same message
      // regardless of whether the webview is WebKit or Chromium.
      onError(new Error("Connection lost during streaming. Try again."))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    reader.releaseLock()
  }
}
