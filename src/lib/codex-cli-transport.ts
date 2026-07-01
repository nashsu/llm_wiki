/**
 * Codex CLI subprocess transport.
 *
 * Rust-side counterpart: src-tauri/src/commands/codex_cli.rs. The Rust
 * command spawns `codex exec --json`, sends a single reconstructed prompt
 * over stdin, and emits each JSONL stdout line back as `codex-cli:{streamId}`.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

export function parseCodexCliLine(rawLine: string): string | null {
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
  if (obj.type !== "item.completed") return null

  const item = obj.item as Record<string, unknown> | undefined
  if (item?.type !== "agent_message") return null
  return typeof item.text === "string" && item.text.length > 0 ? item.text : null
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => {
      if (block.type === "text") return block.text
      return `[Image omitted: ${block.mediaType}]`
    })
    .join("\n")
}

function escapePromptContent(text: string): string {
  return text.replace(/<\/?[A-Z_][A-Z0-9_]*>/gi, (tag) =>
    tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  )
}

export function buildPrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase()
      return `<${role}>\n${escapePromptContent(contentToText(message.content))}\n</${role}>`
    })
    .join("\n\n")
}

type SpawnPayload = Record<string, unknown> & {
  streamId: string
  model: string
  prompt: string
  isolateLocalConfig: boolean
  timeoutMinutes?: number
  workingDirectory?: string
}

export async function streamCodexCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks

  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop"] as const) {
      if (overrides[key] !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(`[codex-cli] ignoring unsupported override "${key}": CLI has no equivalent flag`)
      }
    }
  }

  const streamId = crypto.randomUUID()
  let unlistenData: UnlistenFn | undefined
  let unlistenDone: UnlistenFn | undefined
  let finished = false
  let aborted = signal?.aborted ?? false
  let emittedAgentMessage = false
  let resolveCompletion: () => void = () => {}
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })

  const unparsedLines: string[] = []
  let unparsedSize = 0
  function captureUnparsed(line: string) {
    if (unparsedSize >= 4096) return
    const trimmed = line.trim()
    if (!trimmed) return
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

  const replayAgentMessagesFromStdout = (stdout: string | undefined) => {
    if (!stdout) return

    for (const line of stdout.split(/\r?\n/)) {
      const token = parseCodexCliLine(line)
      if (token !== null) {
        emittedAgentMessage = true
        onToken(token)
      }
    }
  }

  const abortListener = () => {
    aborted = true
    void invoke("codex_cli_kill", { streamId }).catch(() => {})
    finishWith(onDone)
  }
  if (aborted) {
    finishWith(onDone)
    return
  }
  signal?.addEventListener("abort", abortListener)

  try {
    unlistenData = await listen<string>(`codex-cli:${streamId}`, (event) => {
      const token = parseCodexCliLine(event.payload)
      if (token !== null) {
        emittedAgentMessage = true
        onToken(token)
      } else {
        captureUnparsed(event.payload)
      }
    })
    if (aborted || finished) {
      cleanup()
      return
    }

    unlistenDone = await listen<{ code: number | null; stderr: string; stdout?: string }>(
      `codex-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        const stderr = event.payload?.stderr?.trim() ?? ""
        const stdout = event.payload?.stdout ?? ""
        if (code !== null && code !== undefined && code !== 0) {
          const details = stderr || stdout.trim() || unparsedLines.join("\n")
          finishWith(() =>
            onError(new Error(
              details
                ? `Codex CLI exited with code ${code}:\n${details}`
                : `Codex CLI exited with code ${code}. Run \`codex\` in a terminal to inspect the problem.`,
            )),
          )
        } else {
          if (!emittedAgentMessage) replayAgentMessagesFromStdout(stdout)
          if (!emittedAgentMessage) {
            const details = stdout.trim() || unparsedLines.join("\n").trim()
            finishWith(() =>
              onError(new Error(
                details
                  ? `Codex CLI completed but did not emit an agent_message. Raw output:\n${details}`
                  : "Codex CLI completed but did not emit an agent_message. Run `codex exec --json` in a terminal to inspect the provider output.",
              )),
            )
          } else {
            finishWith(onDone)
          }
        }
      },
    )
    if (aborted || finished) {
      cleanup()
      return
    }

    if (aborted) return

    const workingDirectory = useWikiStore.getState().project?.path
    if (!workingDirectory) {
      throw new Error("Codex CLI requires an active project working directory")
    }

    const payload: SpawnPayload = {
      streamId,
      model: config.model,
      prompt: buildPrompt(messages),
      isolateLocalConfig: config.localCliIsolation === true,
      timeoutMinutes: config.codexCliTimeoutMinutes,
      workingDirectory,
    }
    await invoke("codex_cli_spawn", payload)
    if (aborted || signal?.aborted) {
      aborted = true
      await invoke("codex_cli_kill", { streamId }).catch(() => {})
      finishWith(onDone)
      return
    }
    await completion
  } catch (err) {
    finishWith(() => {
      const message = err instanceof Error ? err.message : String(err)
      if (/not found|No such file|executable file not found/i.test(message)) {
        onError(new Error(
          "Codex CLI not found. Install `codex` with `npm install -g @openai/codex` or pick a different provider.",
        ))
      } else {
        onError(err instanceof Error ? err : new Error(message))
      }
    })
  } finally {
    signal?.removeEventListener("abort", abortListener)
  }
}
