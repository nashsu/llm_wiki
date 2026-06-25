/**
 * Controllable streamChat mock for race / concurrency tests.
 *
 * Unlike the instant-response mocks used in Tier 5 prompt tests, this
 * harness lets each call HANG until the test manually resolves it with
 * `complete(response)` or `fail(error)`. Combine with AbortSignal to test
 * mid-flight cancellation.
 */
import { vi, type Mock } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage } from "@/lib/llm-providers"
import type { StreamCallbacks } from "@/lib/llm-client"
import { createDeferred, type Deferred } from "./deferred"

interface PendingCall {
  config: LlmConfig
  messages: ChatMessage[]
  callbacks: StreamCallbacks
  signal: AbortSignal | undefined
  deferred: Deferred<void>
  aborted: boolean
}

export interface StreamChatHarness {
  mock: Mock
  pending: PendingCall[]
  latest(): PendingCall | undefined
  complete(response: string, index?: number): Promise<void>
  fail(error: Error, index?: number): Promise<void>
  reset(): void
  /** True if any call saw its abort signal fire. */
  anyAborted(): boolean
}

export function createStreamChatHarness(): StreamChatHarness {
  const pending: PendingCall[] = []

  const mock = vi.fn(
    async (
      config: LlmConfig,
      messages: ChatMessage[],
      callbacks: StreamCallbacks,
      signal?: AbortSignal,
    ): Promise<void> => {
      const deferred = createDeferred<void>()
      const entry: PendingCall = {
        config,
        messages,
        callbacks,
        signal,
        deferred,
        aborted: false,
      }
      pending.push(entry)

      if (signal) {
        if (signal.aborted) {
          entry.aborted = true
          callbacks.onDone()
          deferred.resolve()
        } else {
          signal.addEventListener("abort", () => {
            entry.aborted = true
            callbacks.onDone()
            deferred.resolve()
          })
        }
      }

      await deferred.promise
    },
  )

  return {
    mock,
    pending,
    latest: () => pending[pending.length - 1],
    async complete(response: string, index?: number) {
      const i = index ?? pending.length - 1
      const call = pending[i]
      if (!call || call.deferred.settled) return
      call.callbacks.onToken(response)
      call.callbacks.onDone()
      call.deferred.resolve()
      // yield so caller's await can unwind
      await Promise.resolve()
    },
    async fail(error: Error, index?: number) {
      const i = index ?? pending.length - 1
      const call = pending[i]
      if (!call || call.deferred.settled) return
      call.callbacks.onError(error)
      call.deferred.resolve()
      await Promise.resolve()
    },
    reset() {
      pending.length = 0
      mock.mockClear()
    },
    anyAborted: () => pending.some((c) => c.aborted),
  }
}
