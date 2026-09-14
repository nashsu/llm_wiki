import { streamChat } from "@/lib/llm-client"
import type { RequestOverrides } from "@/lib/llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"

type StreamArgs = Parameters<typeof streamChat>

// Must match the empty-answer message llm-client emits for reasoning-only replies.
const REASONING_ONLY_RE = /characters of reasoning \/ chain-of-thought, but no actual response content/

/**
 * Streams one ingest LLM call. Thinking-capable endpoints sometimes spend the
 * whole reply on chain-of-thought and never produce an answer; when that
 * happens the same call is retried once with thinking disabled instead of
 * failing the source.
 */
export async function streamIngestChat(
  config: LlmConfig,
  messages: StreamArgs[1],
  callbacks: StreamArgs[2],
  signal: AbortSignal | undefined,
  overrides: RequestOverrides,
): Promise<void> {
  const state = { failure: null as Error | null }
  const attempt = (requestOverrides: RequestOverrides) => streamChat(
    config,
    messages,
    { ...callbacks, onError: (err) => { state.failure = err } },
    signal,
    requestOverrides,
  )

  await attempt(overrides)

  const failure = state.failure
  if (
    failure &&
    REASONING_ONLY_RE.test(failure.message) &&
    overrides.reasoning?.mode !== "off" &&
    !signal?.aborted
  ) {
    console.warn("[Ingest] Endpoint returned reasoning only — retrying with thinking disabled")
    state.failure = null
    await attempt({ ...overrides, reasoning: { mode: "off" } })
  }

  if (state.failure) callbacks.onError(state.failure)
}
