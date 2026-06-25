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
import { useWikiStore } from "@/stores/wiki-store"
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

// Tauri's `invoke` typing requires the payload object to satisfy
// `Record<string, unknown>` (an index signature). Plain interfaces
// don't provide one, so we use a `type` alias with the explicit
// `&` intersection. Without this, TS rejects the call to invoke()
// even though the runtime payload is identical.
type SpawnPayload = Record<string, unknown> & {
  streamId: string
  model: string
  messages: ChatMessage[]
  isolateLocalConfig: boolean
  workingDirectory: string
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
  let aborted = signal?.aborted ?? false
  // Track whether any assistant text was received — used to detect the
  // silent-exit case where the CLI exits 0 but emits no content.
  let emittedToken = false
  // Completion promise: resolves when finishWith() fires so the caller
  // awaits the full round-trip rather than returning after spawn.
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  // Diagnostic capture for failure paths. The Rust side emits every
  // stdout line; lines the parser doesn't recognize (non-JSON,
  // unknown event types, the stream-json `{"type":"error",...}`
  // shape claude can emit on auth failure) used to be silently
  // dropped — leaving users staring at a bare "exit code 1" with
  // nothing to act on. We collect them up to a hard cap so that if
  // the child exits non-zero AND stderr is empty, we have something
  // concrete to show in the error message.
  const UNPARSED_BUFFER_CAP = 4096
  const unparsedLines: string[] = []
  let unparsedSize = 0
  function captureUnparsed(line: string) {
    if (unparsedSize >= UNPARSED_BUFFER_CAP) return
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    unparsedLines.push(line)
    unparsedSize += line.length + 1
  }

  const cleanup = () => {
    unlistenData?.()
    unlistenDone?.()
  }

  const finishWith = (cb: () => void) => {
    if (finished) return
    finished = true
    cleanup()
    cb()
    resolveCompletion()
  }

  const abortListener = () => {
    aborted = true
    void invoke("claude_cli_kill", { streamId }).catch(() => {
      // Kill is best-effort; if the process already exited, the Rust
      // side returns Ok and the done handler fires normally.
    })
    finishWith(onDone)
  }
  if (aborted) {
    finishWith(onDone)
    return
  }
  signal?.addEventListener("abort", abortListener)

  try {
    const workingDirectory = useWikiStore.getState().project?.path
    if (!workingDirectory) {
      throw new Error("Claude Code CLI requires an active project working directory")
    }

    // Listen FIRST so we don't miss the very first event on fast CLIs.
    // The active-project guard above is intentionally earlier: without
    // a valid project CWD we will not spawn, so no CLI events can race.
    unlistenData = await listen<string>(`claude-cli:${streamId}`, (event) => {
      const token = parse(event.payload)
      if (token !== null) {
        emittedToken = true
        onToken(token)
      } else {
        // Parser didn't recognize this line. Stash it in case the
        // child later exits non-zero with empty stderr — at that
        // point this captured stdout is the only diagnostic the
        // user has.
        captureUnparsed(event.payload)
      }
    })
    if (aborted || finished) {
      cleanup()
      return
    }

    unlistenDone = await listen<{ code: number | null; stderr: string }>(
      `claude-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        const stderr = event.payload?.stderr?.trim() ?? ""
        if (code !== null && code !== undefined && code !== 0) {
          finishWith(() =>
            onError(
              new Error(buildExitError(code, stderr, unparsedLines.join("\n"))),
            ),
          )
        } else if (!emittedToken) {
          // CLI exited successfully but produced no assistant text.
          // Surface this as an explicit error so the ingest pipeline
          // retries rather than silently writing an empty stub page.
          const details = stderr || unparsedLines.join("\n").trim()
          finishWith(() =>
            onError(new Error(
              details
                ? `Claude Code CLI completed but returned no content:\n${details}`
                : "Claude Code CLI completed but returned no content. Try running `claude -p` in a terminal to inspect the output, or switch to the Anthropic API in Settings.",
            )),
          )
        } else {
          finishWith(onDone)
        }
      },
    )
    if (aborted || finished) {
      cleanup()
      return
    }

    const payload: SpawnPayload = {
      streamId,
      model: config.model,
      messages,
      isolateLocalConfig: config.localCliIsolation === true,
      workingDirectory,
    }
    await invoke("claude_cli_spawn", payload)
    if (aborted || signal?.aborted) {
      aborted = true
      await invoke("claude_cli_kill", { streamId }).catch(() => {})
      finishWith(onDone)
      return
    }
    // Wait for the done event to be processed before returning.
    // Without this await the caller sees an empty analysis buffer
    // because streamClaudeCodeCli() resolves immediately after spawn
    // while the CLI subprocess is still running. (Same race that was
    // fixed for the Codex CLI transport in #238.)
    await completion
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

/**
 * Translate `claude` CLI exit-with-stderr into an actionable error
 * message for the user. The bare "exited with code N: <stderr>"
 * we used to throw was correct but unactionable — users had to
 * read JSON-shaped stderr text to figure out what to do.
 *
 * Three diagnostic sources, used in priority order:
 *   1. stderr — the canonical place. The most common content is
 *      `Unauthenticated:` from Claude Code itself, meaning the
 *      user's ~/.claude OAuth token expired / was revoked / they
 *      logged out. We surface that case explicitly because users
 *      otherwise mis-diagnose it as an LLM Wiki bug.
 *   2. unparsedStdout — stdout lines the parser didn't recognize
 *      (non-JSON, unknown event types, the stream-json `error`
 *      event shape). Used as a fallback when stderr is empty —
 *      claude sometimes writes its real diagnostic to stdout via
 *      the stream-json channel, and our parser silently drops
 *      anything it doesn't classify, leaving users with no info
 *      at all.
 *   3. Neither — silent exit. We can't help much here other than
 *      telling the user to reproduce in a terminal where they can
 *      see whatever output the CLI does produce.
 */
export function buildExitError(
  code: number,
  stderr: string,
  unparsedStdout: string = "",
): string {
  if (/unauthenticated|please.*log\s*in|authentication.*failed/i.test(stderr)) {
    return [
      "Claude Code CLI is not authenticated.",
      "Please open a terminal and run `claude` to complete the OAuth login,",
      "then retry. (LLM Wiki only spawns the binary — it can't run the",
      "login flow on your behalf.)",
      stderr ? `\n\n— stderr —\n${stderr}` : "",
    ].join(" ").trim()
  }
  if (stderr) {
    return `claude CLI exited with code ${code}: ${stderr}`
  }
  if (unparsedStdout.trim()) {
    return [
      `claude CLI exited with code ${code} (no stderr).`,
      "Captured stdout output that LLM Wiki couldn't parse — pasting it",
      "here so you can see what the CLI actually emitted:\n",
      unparsedStdout.trim(),
    ].join(" ")
  }
  return [
    `claude CLI exited silently with code ${code}.`,
    "No stdout or stderr was captured — try running `claude -p` in a",
    "terminal with the same prompt to see what's wrong, or switch to",
    "the official Anthropic API in Settings.",
  ].join(" ")
}
