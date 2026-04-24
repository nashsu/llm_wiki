/**
 * Claude Code CLI subprocess transport.
 *
 * Rust-side counterpart: src-tauri/src/commands/claude_cli.rs. The Rust
 * commands spawn `claude -p --output-format stream-json
 * --input-format stream-json --verbose --model <model>`, pipe the
 * serialized history over stdin, and emit stdout back as
 * `claude-cli:{streamId}` events (one line per event). This module
 * listens for those events, parses each line as a stream-json event,
 * and forwards assistant text to `onToken`.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

/**
 * Public parse entry point. Given one stream-json line from claude's
 * stdout, returns any assistant text it contains (or null for events
 * that carry no user-visible text: session init, tool_use, result, etc.).
 *
 * State is carried in a small closure because `assistant` events ship
 * the full in-progress message on every emission (NOT incremental), but
 * `stream_event` passthrough (emitted when --verbose is on) carries
 * real token-level deltas. To avoid double-counting, we prefer deltas
 * when they arrive and skip the fat `assistant` events after seeing one.
 */
export function createClaudeCodeStreamParser() {
  let sawDelta = false
  // Track the running text we have emitted for the current assistant
  // turn via `assistant` events so we can diff new content off the end
  // and only emit what wasn't already streamed.
  let emittedFromAssistant = ""

  return function parseLine(rawLine: string): string | null {
    const line = rawLine.trim()
    if (!line) return null

    let evt: unknown
    try {
      evt = JSON.parse(line)
    } catch {
      return null
    }

    if (!evt || typeof evt !== "object") return null
    const obj = evt as Record<string, unknown>
    const type = obj.type

    // Real streaming deltas (passthrough from Anthropic API when
    // --verbose is active on newer claude CLI versions).
    if (type === "stream_event") {
      const event = obj.event as Record<string, unknown> | undefined
      if (event?.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          sawDelta = true
          return delta.text
        }
      }
      return null
    }

    // Full assistant message (older CLI versions or when deltas are
    // unavailable). Ship only the portion we haven't already emitted
    // via stream_event deltas, so streaming still works smoothly.
    if (type === "assistant") {
      const message = obj.message as Record<string, unknown> | undefined
      const content = message?.content
      if (!Array.isArray(content)) return null
      const text = content
        .map((c) => {
          const cc = c as Record<string, unknown>
          return cc.type === "text" && typeof cc.text === "string" ? cc.text : ""
        })
        .join("")
      if (!text) return null

      if (sawDelta) {
        // Deltas already covered this turn; skip the fat assistant event.
        return null
      }
      if (text.startsWith(emittedFromAssistant)) {
        const novel = text.slice(emittedFromAssistant.length)
        emittedFromAssistant = text
        return novel || null
      }
      // Non-prefix change: cli sent something different than expected.
      // Reset tracker and emit the new text wholesale.
      emittedFromAssistant = text
      return text
    }

    // Ignore session init, tool_use, result summary, unknown types.
    return null
  }
}

interface SpawnPayload {
  streamId: string
  model: string
  messages: ChatMessage[]
}

/**
 * Subprocess equivalent of the HTTP path in streamChat. Obeys the same
 * StreamCallbacks contract so chat-panel code doesn't need to know
 * which transport it's talking to.
 */
export async function streamClaudeCodeCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  // Sampling knobs aren't wired through the Claude Code CLI (no flag
  // equivalents for temperature/top_p/max_tokens/stop). Warn loudly in
  // dev so a caller wiring these up doesn't silently wonder why they
  // don't take effect; keep quiet in prod so regular users aren't
  // alarmed by a reasonable default.
  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop"] as const) {
      if (overrides[key] !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(`[claude-code] ignoring unsupported override "${key}": CLI has no equivalent flag`)
      }
    }
  }

  const streamId = crypto.randomUUID()
  const parse = createClaudeCodeStreamParser()

  let unlistenData: UnlistenFn | undefined
  let unlistenDone: UnlistenFn | undefined
  let finished = false

  const cleanup = () => {
    unlistenData?.()
    unlistenDone?.()
  }

  const finishWith = (cb: () => void) => {
    if (finished) return
    finished = true
    cleanup()
    cb()
  }

  const abortListener = () => {
    void invoke("claude_cli_kill", { streamId }).catch(() => {
      // Kill is best-effort; if the process already exited, the Rust
      // side returns Ok and the done handler fires normally.
    })
    finishWith(onDone)
  }
  signal?.addEventListener("abort", abortListener)

  try {
    // Listen FIRST so we don't miss the very first event on fast CLIs.
    unlistenData = await listen<string>(`claude-cli:${streamId}`, (event) => {
      const token = parse(event.payload)
      if (token !== null) onToken(token)
    })

    unlistenDone = await listen<{ code: number | null; stderr: string }>(
      `claude-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        const stderr = event.payload?.stderr?.trim() ?? ""
        if (code !== null && code !== undefined && code !== 0) {
          // Include stderr in the message so the user sees the actual
          // failure reason (missing flag, bad model id, auth issue, etc.)
          // rather than a bare exit code.
          const detail = stderr ? `: ${stderr}` : ""
          finishWith(() =>
            onError(new Error(`claude CLI exited with code ${code}${detail}`)),
          )
        } else {
          finishWith(onDone)
        }
      },
    )

    const payload: SpawnPayload = {
      streamId,
      model: config.model,
      messages,
    }
    await invoke("claude_cli_spawn", payload)
  } catch (err) {
    finishWith(() => {
      const message = err instanceof Error ? err.message : String(err)
      // Surface the classic "CLI not installed" case as an actionable
      // message — the Rust side returns a plain string from
      // spawn-failed, but users need to know to install claude.
      if (/not found|No such file|executable file not found/i.test(message)) {
        onError(new Error(
          "Claude Code CLI not found. Install `claude` (https://www.anthropic.com/claude-code) or pick a different provider.",
        ))
      } else {
        onError(err instanceof Error ? err : new Error(message))
      }
    })
  } finally {
    signal?.removeEventListener("abort", abortListener)
  }
}
