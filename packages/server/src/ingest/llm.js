// LLM call layer for the server-driven ingest orchestrator (issue #14 P0).
//
// Server port of the desktop call path used by ingest (streamChat in
// src/lib/llm-client.ts): resolves the persisted config to {wire,url,headers}
// via normalizeEndpoint, applies the long-horizon request timeout backstop
// (requestTimeoutMinutes, default 30, clamped 1..1440 — llm-client.ts:123),
// accumulates streamed deltas, and classifies provider errors so the
// orchestrator can react:
//   • usage-limit errors (429 / rate limit / quota) → 15-minute backoff,
//     NOT a terminal failure (ingest-queue.ts:610-634 desktop parity)
//   • timeout backstop fired → surfaced as a timeout error
//   • caller abort → propagated as-is (the orchestrator decides)
//
// claude-code / codex-cli providers throw from normalizeEndpoint — fail fast,
// the orchestrator surfaces the message as a terminal task failure.

import { streamCall } from "../llm-call.js"
import { normalizeEndpoint } from "../llm-resolve.js"

/** Backoff applied after a provider usage-limit error (desktop parity). */
export const USAGE_LIMIT_BACKOFF_MS = 15 * 60 * 1000

/** Desktop-parity classification (ingest-queue.ts isUsageLimitError). */
export function isUsageLimitError(message) {
  return /\b429\b|rate[_\s-]*limit|usage\s+limit|quota|too many requests/i.test(message ?? "")
}

export class IngestLlmError extends Error {
  constructor(message, { usageLimit = false, timeout = false } = {}) {
    super(message)
    this.name = "IngestLlmError"
    this.usageLimit = usageLimit
    this.timeout = timeout
  }
}

/**
 * Stream a chat-style completion and resolve with the accumulated text.
 *
 * @param {object} config   resolved LlmConfig (resolveIngestConfig output)
 * @param {Array}  messages [{role, content}, …]
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]    caller cancellation (task cancel)
 * @param {object} [opts.overrides]      {temperature, max_tokens} — the ingest
 *   pipeline passes {temperature: 0.1, max_tokens: 4096} exactly like the
 *   desktop (ingest.ts call sites)
 * @param {(token: string) => void} [opts.onToken]  optional delta hook
 * @param {number} [opts.timeoutMs]  backstop override (tests only; normally
 *   derived from config.requestTimeoutMinutes)
 * @returns {Promise<string>} accumulated completion text
 */
export async function streamChat(config, messages, { signal, overrides, onToken, timeoutMs } = {}) {
  const endpoint = normalizeEndpoint(config) // throws for claude-code/codex-cli

  // Long-horizon backstop, clamped like the desktop (llm-client.ts:123).
  const timeoutMinutes = Math.max(1, Math.min(1440, config.requestTimeoutMinutes ?? 30))
  const effectiveTimeoutMs = timeoutMs ?? timeoutMinutes * 60 * 1000

  const controller = new AbortController()
  let timeoutFired = false
  const timer = setTimeout(() => { timeoutFired = true; controller.abort() }, effectiveTimeoutMs)
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", () => controller.abort(), { once: true })
  }

  try {
    let text = ""
    const stream = streamCall({
      ...endpoint,
      messages,
      signal: controller.signal,
      temperature: overrides?.temperature,
      maxTokens: overrides?.max_tokens ?? overrides?.maxTokens,
    })
    for await (const ev of stream) {
      if (ev.type === "delta" && ev.text) {
        text += ev.text
        onToken?.(ev.text)
      }
    }
    return text
  } catch (err) {
    // Caller-initiated cancel: propagate untouched (orchestrator handles).
    if (signal?.aborted) throw err
    if (timeoutFired) {
      throw new IngestLlmError(
        `Request timed out after ${Math.round(effectiveTimeoutMs / 60000)} min. Try a faster model or a smaller context.`,
        { timeout: true },
      )
    }
    const message = err?.message ?? String(err)
    if (isUsageLimitError(message)) throw new IngestLlmError(message, { usageLimit: true })
    throw err
  } finally {
    clearTimeout(timer)
  }
}
