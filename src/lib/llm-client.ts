import type { LlmConfig } from "@/stores/wiki-store"
import { isAzureOpenAiEndpoint } from "@/lib/azure-openai"
import {
  getProviderConfig,
  resolveReasoningWirePlan,
  type RequestOverrides,
} from "./llm-providers"
import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"
import { countReasoningCharsInLine, extractReasoningTextFromLine } from "./reasoning-detector"

export type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
export { isFetchNetworkError } from "./tauri-fetch"

export interface StreamCallbacks {
  onToken: (token: string) => void
  onReasoningToken?: (token: string) => void
  /**
   * Non-fatal, user-visible note about a decision the transport made (e.g. a
   * gateway rejecting the stop-thinking field and the request continuing with
   * thinking enabled). Callers that surface warnings to the user should pass
   * this through; it never replaces onDone/onError.
   */
  onNotice?: (notice: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

function bufferedStreamCallbacks(callbacks: StreamCallbacks): StreamCallbacks {
  let content = ""
  let reasoning = ""
  return {
    onToken: (token) => { content += token },
    onReasoningToken: (token) => { reasoning += token },
    onDone: () => {
      if (reasoning) callbacks.onReasoningToken?.(reasoning)
      if (content) callbacks.onToken(content)
      callbacks.onDone()
    },
    onError: callbacks.onError,
  }
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

async function streamViaCodexCli(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
) {
  const mod = await import("./codex-cli-transport")
  return mod.streamCodexCli(config, messages, callbacks, signal, requestOverrides)
}

function parseLines(
  decoder: TextDecoder,
  chunk: Uint8Array,
  buffer: string,
): [string[], string] {
  const text = buffer + decoder.decode(chunk, { stream: true })
  const lines = text.split("\n")
  const remaining = lines.pop() ?? ""
  return [lines, remaining]
}

interface EndpointErrorEnvelope {
  error?: {
    code?: string | number
    message?: string
  } | string
}

function parseEndpointErrorEnvelope(record: string): Error | null {
  const payload = record.startsWith("data:")
    ? record.slice(5).trim()
    : record

  if (!payload.startsWith("{")) return null

  try {
    const parsed = JSON.parse(payload) as EndpointErrorEnvelope
    const message = typeof parsed.error === "string"
      ? parsed.error
      : parsed.error?.message
    if (!message) return null

    const code = typeof parsed.error === "object" && parsed.error?.code !== undefined
      ? ` ${parsed.error.code}`
      : ""
    return new Error(`LLM endpoint error${code}: ${message}`)
  } catch {
    return null
  }
}

function splitFinalStreamRecords(text: string): string[] {
  // Some local transports expose a fully buffered SSE body with escaped
  // record separators. Only split after a complete JSON SSE record; a model
  // response can legitimately contain the text "\n\ndata:", and splitting
  // that sequence while it is still inside a JSON string would corrupt it.
  if (/[\r\n]/.test(text) || !/^\s*data:/.test(text)) {
    return text.split(/\r?\n/)
  }

  const records: string[] = []
  const separator = /(?:\\r)?\\n(?:\\r)?\\n(?=data:)/g
  let recordStart = 0
  let match: RegExpExecArray | null

  while ((match = separator.exec(text)) !== null) {
    const candidate = text.slice(recordStart, match.index).trim()
    const payload = candidate.startsWith("data:")
      ? candidate.slice(5).trim()
      : ""
    let complete = payload === "[DONE]"
    if (!complete && payload.startsWith("{")) {
      try {
        JSON.parse(payload)
        complete = true
      } catch {
        // The separator-like text is inside an incomplete JSON string.
      }
    }
    if (complete) {
      records.push(candidate)
      recordStart = match.index + match[0].length
    }
  }

  records.push(text.slice(recordStart))
  return records
}

function isRequestCancelledError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /^request cancel(?:l)?ed$/i.test(message.trim())
}

export function isReasoningOnlyResponseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /^Model produced [\d,]+ characters of reasoning \/ chain-of-thought, but no actual response content\./.test(message)
}

function shouldRetryWithoutTemperature(
  config: LlmConfig,
  status: number,
  errorDetail: string,
  requestOverrides?: RequestOverrides,
): boolean {
  if (config.provider !== "custom" || requestOverrides?.temperature === undefined) return false
  if (status !== 400 && status !== 422) return false
  const detail = errorDetail.toLowerCase()
  return detail.includes("temperature") && (
    detail.includes("unsupported") ||
    detail.includes("not support") ||
    detail.includes("unknown") ||
    detail.includes("not allowed") ||
    detail.includes("only") ||
    detail.includes("invalid")
  )
}

/**
 * Field names the provider layer adds when a generic custom gateway is asked to
 * stop thinking (`reasoning: { mode: "off" }`). A gateway that does not know
 * them answers 400/422; we then re-issue the request without the field so an
 * ingest still runs instead of failing outright.
 */
function shouldRetryWithoutReasoningFields(
  config: LlmConfig,
  status: number,
  requestOverrides?: RequestOverrides,
): boolean {
  if (status !== 400 && status !== 422) return false
  // Recovery-first: any 400/422 on a request that carried an explicit
  // stop-thinking field gets one retry without it. Only retrying when the error
  // text happens to name the field would hand the user a hard failure — a lost
  // page — in exactly the situation where the field is the most likely cause
  // (an unknown gateway rejecting an unknown key often says only "invalid
  // request body"). The cost of being wrong is one extra request; the cost of
  // not trying can be the whole import. The single retry is bounded, and its
  // notice states only what the two outcomes actually prove.
  //
  // Which field, and whether the request carried one at all, comes from the
  // wire plan — never from re-deriving it here.
  return resolveReasoningWirePlan(config, requestOverrides).source === "explicit"
}

/** The field a rejected explicit plan carried, for the user-visible notice. */
function fieldNameForReasoningDisable(
  config: LlmConfig,
  requestOverrides?: RequestOverrides,
): string {
  return resolveReasoningWirePlan(config, requestOverrides).fields[0] ?? "the stop-thinking field"
}

/**
 * Deliver a non-fatal notice. Observational callbacks must never be able to
 * break the transport state machine, so a throwing handler is swallowed (and
 * reported) rather than propagated.
 */
function raiseNotice(callbacks: StreamCallbacks, notice: string): void {
  try {
    if (callbacks.onNotice) callbacks.onNotice(notice)
    else console.warn(`[llm-client] ${notice}`)
  } catch (err) {
    console.warn("[llm-client] notice handler threw", err)
  }
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
  const { onToken } = callbacks

  // Release the backstop timer and the user-abort listener when this attempt
  // settles. Every path below settles through onDone/onError, and callers now
  // retry (reasoning-only, temperature, budget), so leaving them attached kept
  // a 30-minute timer plus a listener on the caller's long-lived signal alive
  // for every attempt.
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let detachUserAbort: (() => void) | undefined
  const settle = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
      timeoutId = undefined
    }
    detachUserAbort?.()
    detachUserAbort = undefined
  }
  const onDone = () => {
    settle()
    callbacks.onDone()
  }
  const onError = (error: Error) => {
    settle()
    callbacks.onError(error)
  }

  // Claude Code CLI uses a subprocess transport (stdin/stdout), not
  // HTTP. Dispatch before getProviderConfig — that function throws for
  // this provider because it has no URL/headers.
  if (config.provider === "claude-code") {
    return streamViaClaudeCodeCli(
      config,
      messages,
      config.streamingEnabled === false ? bufferedStreamCallbacks(callbacks) : callbacks,
      signal,
      requestOverrides,
    )
  }

  if (config.provider === "codex-cli") {
    return streamViaCodexCli(
      config,
      messages,
      config.streamingEnabled === false ? bufferedStreamCallbacks(callbacks) : callbacks,
      signal,
      requestOverrides,
    )
  }

  const providerConfig = getProviderConfig(config)

  // Combined abort: (a) user cancel, (b) our long-horizon timeout.
  // The long timeout is a backstop for truly stuck requests; it's NOT
  // what fires when a user sees "Timeout" after 2 seconds — that is
  // almost always a fast network failure (DNS, TLS, 404, refused) that
  // WebKit surfaces as a generic "Load failed". We track whether the
  // backstop actually fired so we can tell the two apart in the error.
  const timeoutMinutes = Math.max(1, Math.min(1440, config.requestTimeoutMinutes ?? 30))
  const timeoutMs = timeoutMinutes * 60 * 1000
  let combinedSignal = signal
  let timeoutController: AbortController | undefined
  let timeoutFired = false

  if (typeof AbortSignal.timeout === "function") {
    timeoutController = new AbortController()
    timeoutId = setTimeout(() => {
      timeoutFired = true
      timeoutController?.abort()
    }, timeoutMs)

    if (signal) {
      const onUserAbort = () => {
        timeoutController?.abort()
      }
      signal.addEventListener("abort", onUserAbort)
      detachUserAbort = () => signal.removeEventListener("abort", onUserAbort)
    }
    combinedSignal = timeoutController.signal
  }

  // An abort that happened *before* this call registered its listener never
  // fires it, so the transport would still put the request on the wire — the
  // 400 fallback can race exactly like this (the caller cancels while the first
  // response is being read). Cancellation wins here, silently, like any other
  // cancel.
  if (signal?.aborted) {
    onDone()
    return
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
    if ((err instanceof Error && err.name === "AbortError") || isRequestCancelledError(err)) {
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
    if (shouldRetryWithoutTemperature(config, response.status, errorDetail, requestOverrides)) {
      const { temperature: _temperature, ...retryOverrides } = requestOverrides ?? {}
      // Hand the backstop to the re-issued request instead of leaving this
      // attempt's timer attached.
      settle()
      return streamChat(config, messages, callbacks, signal, retryOverrides)
    }
    if (shouldRetryWithoutReasoningFields(config, response.status, requestOverrides)) {
      // Hand the backstop to the re-issued request first: a throwing notice
      // handler must not be able to skip cleanup or the retry itself.
      settle()
      const field = fieldNameForReasoningDisable(config, requestOverrides)
      const retryOverrides = {
        ...(requestOverrides ?? {}),
        reasoning: { mode: "auto" as const },
      }
      let retrySucceeded = false
      let retryFailure: Error | undefined
      await streamChat(
        config,
        messages,
        {
          onToken,
          onReasoningToken: callbacks.onReasoningToken,
          onNotice: callbacks.onNotice,
          onDone: () => { retrySucceeded = true },
          onError: (err) => { retryFailure = err },
        },
        signal,
        retryOverrides,
      )
      if (retrySucceeded) {
        // State only what the two outcomes prove: the first request failed and
        // the retry without the field worked. Whether the gateway objected to
        // the field, and what it does with thinking by default, is not something
        // this code can know.
        if (!signal?.aborted) {
          raiseNotice(
            callbacks,
            `The first request failed with ${response.status}; retrying without ` +
            `${field} succeeded, so this answer uses the endpoint's default thinking behaviour.`,
          )
        }
        // Deliver the notice before the terminal callback: callers finalize
        // (and persist warnings) on onDone.
        callbacks.onDone()
      } else {
        callbacks.onError(new Error(
          `${errorDetail} (retrying without ${field} also failed: ` +
          `${retryFailure?.message ?? "unknown error"})`,
        ))
      }
      return
    }
    if (
      response.status === 404 &&
      (config.provider === "azure" ||
        (config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)))
    ) {
      onError(
        new Error(
          `${errorDetail} — Azure 404 usually means the deployment name is wrong. ` +
            `Set Model to your Azure deployment name (not the model SKU), ` +
            `and Endpoint to https://<resource>.openai.azure.com ` +
            `or .../openai/deployments/<deployment-name>.`,
        ),
      )
      return
    }
    onError(new Error(errorDetail))
    return
  }

  if (!providerConfig.streaming) {
    try {
      const payload: unknown = await response.json()
      const content = providerConfig.parseResponse(payload)
      if (!content) {
        onError(new Error("Model returned an empty non-streaming response"))
        return
      }
      onToken(content)
      onDone()
    } catch (err) {
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      if (
        signal?.aborted ||
        (err instanceof Error && err.name === "AbortError") ||
        isRequestCancelledError(err)
      ) {
        onDone()
        return
      }
      if (isFetchNetworkError(err)) {
        onError(new Error("Connection lost while reading the complete response. Try again."))
        return
      }
      onError(err instanceof Error ? err : new Error(String(err)))
    }
    return
  }

  if (!response.body) {
    onError(new Error("Response body is null"))
    return
  }

  const reader = response.body.getReader()
  // TextDecoder keeps partial multi-byte state, so it must be scoped to this
  // response rather than shared across concurrent research requests.
  const decoder = new TextDecoder()
  let lineBuffer = ""

  // Diagnostic counters. Some OpenAI-compatible endpoints stream
  // chain-of-thought through a `reasoning_content` (DeepSeek-R1,
  // Kimi K2.x) or `reasoning` (Qwen-flavored deployments) field
  // and only put the actual answer in `delta.content` after
  // thinking ends. Misbehaving endpoints sometimes emit kilobytes
  // of reasoning and end the stream with no content at all,
  // leaving the user with a silent empty analysis. We track the
  // two channels separately so the stream-end path can tell the
  // difference between "model said nothing" and "model thought
  // out loud but never produced an answer". See reasoning-
  // detector.ts.
  let contentCharsEmitted = 0
  let reasoningCharsObserved = 0
  const recordToken = (text: string) => {
    contentCharsEmitted += text.length
    onToken(text)
  }
  const recordReasoning = (line: string) => {
    const reasoningParts = extractReasoningTextFromLine(line)
    for (const part of reasoningParts) {
      callbacks.onReasoningToken?.(part)
    }
  }
  const processRecord = (line: string): Error | null => {
    const trimmed = line.trim()
    if (!trimmed) return null

    reasoningCharsObserved += countReasoningCharsInLine(trimmed)
    recordReasoning(trimmed)
    const token = providerConfig.parseStream(trimmed)
    if (token !== null) {
      recordToken(token)
      return null
    }
    return parseEndpointErrorEnvelope(trimmed)
  }
  const stopForEndpointError = async (error: Error) => {
    // An endpoint can emit an error event without closing its SSE response.
    // Cancel the body so that the transport does not keep the connection and
    // its buffers alive after the caller has already received the failure.
    try {
      await reader.cancel()
    } catch {
      // Preserve the endpoint's actionable error if transport cleanup fails.
    }
    onError(error)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        const finalText = lineBuffer + decoder.decode()
        for (const line of splitFinalStreamRecords(finalText)) {
          const endpointError = processRecord(line)
          if (endpointError) {
            await stopForEndpointError(endpointError)
            return
          }
        }
        break
      }

      const [lines, remaining] = parseLines(decoder, value, lineBuffer)
      lineBuffer = remaining

      for (const line of lines) {
        const endpointError = processRecord(line)
        if (endpointError) {
          await stopForEndpointError(endpointError)
          return
        }
      }
    }

    // Stream ended cleanly. If the model produced thinking tokens
    // but no actual answer, surface that as a clear diagnostic
    // instead of letting the caller silently see "" (which usually
    // surfaces several layers up as "analysis not available" with
    // no clue why). Threshold guards against single-stray-byte
    // false positives from spurious empty `reasoning:""` deltas.
    const REASONING_DIAGNOSTIC_THRESHOLD = 200
    if (
      contentCharsEmitted === 0 &&
      reasoningCharsObserved >= REASONING_DIAGNOSTIC_THRESHOLD
    ) {
      onError(
        new Error(
          `Model produced ${reasoningCharsObserved.toLocaleString()} characters of reasoning / chain-of-thought, but no actual response content. ` +
          `This usually means the endpoint hit a thinking-token limit, the model didn't transition from thinking to answering, ` +
          `or the endpoint is misbehaving (the official Anthropic / OpenAI APIs don't have this issue). ` +
          `Try a shorter input, increase max_tokens, or switch to a different model in Settings.`,
        ),
      )
      return
    }

    onDone()
  } catch (err) {
    // The abort can reach us two ways: a real AbortError, or — when the
    // Tauri HTTP plugin tears down the body stream — a bare *string*
    // "Request cancelled" passed to controller.error(). The latter is not
    // an Error, so the old `err instanceof Error` guard let it fall through
    // to the generic branch and surface verbatim. Recognize both shapes.
    const isAbort =
      signal?.aborted ||
      timeoutFired ||
      (err instanceof Error && err.name === "AbortError") ||
      isRequestCancelledError(err)
    if (isAbort) {
      // Mirror the pre-fetch catch: distinguish our long-horizon backstop
      // (an actionable timeout) from a user-initiated cancel (silent).
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
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

/**
 * Upper bound for the automatic reasoning-budget retry. Big enough to hold a
 * long chain-of-thought *and* its answer on any current model; small enough
 * that the retry still fits the per-request ceiling gateways commonly impose.
 */
export const REASONING_RETRY_MAX_TOKENS = 32_768

/**
 * Never retry below this. A 4x bump from a small budget can still be too tight
 * for a model that already spent thousands of tokens thinking.
 */
const REASONING_RETRY_FLOOR_TOKENS = 16_384

/**
 * Empty (non-streaming) responses are the same failure the reasoning-only
 * diagnostic describes: on a non-streaming wire the endpoint collapses to a
 * bare `content: ""`, so a thinking model that never answered looks identical
 * to a broken endpoint. Retrying it once with a larger budget is the
 * non-streaming equivalent of the reasoning-only retry.
 */
export function isEmptyNonStreamingResponseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message === "Model returned an empty non-streaming response"
}

/**
 * Both shapes that mean "the model produced no answer at all".
 */
function isRetryableEmptyAnswerError(error: Error): boolean {
  return isReasoningOnlyResponseError(error) || isEmptyNonStreamingResponseError(error)
}

/**
 * Report the first failure as the root cause and keep the retry's own error
 * attached. Without this, a retry that fails for a different reason (a gateway
 * capping `max_tokens`, say) replaced the diagnostic the user actually needs —
 * and the message must keep matching `isReasoningOnlyResponseError`, which is
 * prefix-anchored.
 */
function describeRetryFailure(first: Error, retriedBudget: number | undefined, retry: Error): Error {
  return new Error(`${first.message} (retried with max_tokens=${retriedBudget}: ${retry.message})`)
}

/**
 * Output budget to try next after an empty answer, or `null` when the current
 * budget already sits at the ceiling. Returning `null` matters: re-sending an
 * identical request would fail identically, so the caller should surface the
 * original diagnostic instead of burning a round trip.
 */
function nextReasoningRetryBudget(
  overrides?: RequestOverrides,
  ceiling = REASONING_RETRY_MAX_TOKENS,
): number | null {
  const current = overrides?.max_tokens ?? 4_096
  const bumped = Math.min(ceiling, Math.max(current * 4, REASONING_RETRY_FLOOR_TOKENS))
  return bumped > current ? bumped : null
}

export interface ReasoningRetryOptions {
  /**
   * Upper bound for the retried output budget, defaulting to
   * `REASONING_RETRY_MAX_TOKENS`. Experimental: no production caller knows the
   * endpoint's real output ceiling yet, so this exists for callers that do (and
   * for tests). Re-issuing above that ceiling only replaces the diagnostic with
   * an HTTP 400.
   */
  maxTokensCeiling?: number
}

/**
 * `streamChat` with at most **one** recovery attempt when an endpoint produces
 * no answer at all (reasoning-only stream, or an empty non-streaming response).
 *
 * Structured call sites (ingest analysis, generation, long-source chunk
 * analysis) hand the model a fixed output budget. An endpoint that thinks
 * before answering spends part of that same budget on chain-of-thought, and
 * when the thinking alone fills it the stream ends on a clean stop with zero
 * `content` — which `streamChat` reports as the "produced N characters of
 * reasoning ... but no actual response content" diagnostic. Nothing about the
 * request was invalid, so the fix is to give the model room to finish thinking
 * *and* write, rather than fail the ingest and drop the page.
 *
 * Exactly one extra attempt is made (a single budget bump), so the request
 * amplification stays bounded even combined with `streamChat`'s own 400
 * fallbacks. The retry is taken only when the first attempt emitted no content
 * at all, so a caller can never observe duplicated content. Reasoning tokens
 * are forwarded as they arrive, so a retried attempt replays them; the
 * structured callers this exists for do not subscribe to reasoning.
 */
export async function streamChatWithReasoningRetry(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
  options?: ReasoningRetryOptions,
): Promise<void> {
  let overrides = requestOverrides
  let firstFailure: Error | undefined
  let retriedBudget: number | undefined

  for (;;) {
    // Count characters, not callbacks. `streamChat` raises the reasoning-only
    // diagnostic on `contentCharsEmitted === 0`, and OpenAI-compatible
    // gateways put `content: ""` in both the role-only opening chunk and the
    // finish_reason chunk of an otherwise ordinary stream. Treating those empty
    // deltas as "the model answered" made the retry unreachable on exactly the
    // endpoints it exists for — the #743 case. Keeping the same accounting as
    // the detector guarantees the retry fires exactly when the diagnostic does.
    let contentChars = 0

    // Every path in streamChat settles through onDone or onError, so resolving
    // from the callbacks — and catching a stray rejection — cannot hang.
    const error = await new Promise<Error | undefined>((resolve) => {
      void streamChat(
        config,
        messages,
        {
          onToken: (token) => {
            contentChars += token.length
            callbacks.onToken(token)
          },
          onReasoningToken: callbacks.onReasoningToken,
          onNotice: callbacks.onNotice,
          onDone: () => resolve(undefined),
          onError: (err) => resolve(err),
        },
        signal,
        overrides,
      ).catch((err: unknown) => {
        resolve(err instanceof Error ? err : new Error(String(err)))
      })
    })

    // Success and user cancellation both settle this way; neither retries.
    if (error === undefined) {
      callbacks.onDone()
      return
    }

    // The single extra attempt already happened: report the original diagnostic
    // as the root cause, with whatever the retry hit attached to it.
    if (firstFailure !== undefined) {
      callbacks.onError(describeRetryFailure(firstFailure, retriedBudget, error))
      return
    }

    if (contentChars === 0 && isRetryableEmptyAnswerError(error)) {
      const bumped = nextReasoningRetryBudget(overrides, options?.maxTokensCeiling)
      if (bumped !== null) {
        // A cancel that lands between the diagnostic and the re-issue must win,
        // otherwise we start an attempt that is already aborted.
        if (signal?.aborted) {
          callbacks.onDone()
          return
        }
        firstFailure = error
        retriedBudget = bumped
        overrides = { ...overrides, max_tokens: bumped }
        continue
      }
    }

    callbacks.onError(error)
    return
  }
}
