import { invoke } from "@tauri-apps/api/core"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"
import { refreshCopilotSession, useCopilotSession } from "./copilot-session"

/** Buffered text-only transport. Abort stops delivery, not the bounded native request. */
export async function streamCopilot(
  config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks,
  signal?: AbortSignal, overrides?: RequestOverrides,
): Promise<void> {
  if (signal?.aborted) return
  let abortHandler: (() => void) | undefined
  const cancelled = new Promise<undefined>((resolve) => {
    abortHandler = () => resolve(undefined)
    signal?.addEventListener("abort", abortHandler, { once: true })
  })
  // Race every await, including status/catalog discovery; consume late failures.
  const abortable = <T,>(work: Promise<T>) => Promise.race([work, cancelled])
  try {
    const textMessages = messages.map(({ role, content }) => {
      if (!["system", "user", "assistant"].includes(role)) throw new Error("Copilot supports system, user and assistant text messages only.")
      if (typeof content === "string") return { role, content }
      if (content.some(block => block.type !== "text")) throw new Error("Copilot is text-only; images are not supported.")
      return { role, content: content.map(block => block.type === "text" ? block.text : "").join("\n") }
    })
    if (!(await abortable(refreshCopilotSession()))) {
      if (!signal?.aborted) callbacks.onError(new Error("Sign in to GitHub Copilot in Settings before using this provider."))
      return
    }
    if (signal?.aborted) return
    if (!useCopilotSession.getState().models.some(model => model.id === config.model)) {
      throw new Error("Select an available Copilot chat model in Settings.")
    }
    const maxTokens = overrides?.max_tokens
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > 32768)) throw new Error("Copilot maxTokens must be an integer between 1 and 32768.")
    // Strict allowlist: never pass config, URL, headers, API keys or arbitrary overrides.
    const result = await abortable(invoke<{ content: string; finishReason?: string }>("copilot_complete", {
      model: config.model,
      messages: textMessages,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }))
    if (signal?.aborted || !result) return
    const truncated = /^(length|max_tokens|max_output_tokens)$/i.test(result.finishReason ?? "")
    if (!result.content && !truncated) throw new Error("Copilot returned an empty response.")
    if (result.content) callbacks.onToken(result.content)
    if (!signal?.aborted) callbacks.onDone({ finishReason: result.finishReason, truncated })
  } catch (error) {
    if (!signal?.aborted) callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler)
  }
}
