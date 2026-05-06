import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
import type { StreamCallbacks } from "./llm-client"

type LocalCliProvider = "codex-cli" | "gemini-cli"

type SpawnPayload = Record<string, unknown> & {
  streamId: string
  provider: LocalCliProvider
  model: string
  messages: Array<{ role: ChatMessage["role"]; content: string }>
}

function stringifyContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => block.type === "text" ? block.text : `[image: ${block.mediaType}]`)
    .join("\n")
}

export async function streamLocalCli(
  config: LlmConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  overrides?: RequestOverrides,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks
  const provider = config.provider
  if (provider !== "codex-cli" && provider !== "gemini-cli") {
    onError(new Error(`Unsupported local CLI provider: ${String(provider)}`))
    return
  }

  if (import.meta.env?.DEV && overrides) {
    for (const key of ["temperature", "top_p", "top_k", "max_tokens", "stop"] as const) {
      if (overrides[key] !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(`[${provider}] ignoring unsupported override "${key}": CLI transport has no equivalent flag`)
      }
    }
  }

  const streamId = crypto.randomUUID()
  let unlistenData: UnlistenFn | undefined
  let unlistenDone: UnlistenFn | undefined
  let finished = false
  const stdoutLines: string[] = []

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
    void invoke("local_cli_kill", { streamId }).catch(() => {})
    finishWith(onDone)
  }
  signal?.addEventListener("abort", abortListener)

  try {
    unlistenData = await listen<string>(`local-cli:${streamId}`, (event) => {
      const line = event.payload.trim()
      if (line) stdoutLines.push(line)
    })

    unlistenDone = await listen<{ code: number | null; stdout: string; stderr: string }>(
      `local-cli:${streamId}:done`,
      (event) => {
        const code = event.payload?.code
        const stdout = event.payload?.stdout?.trim() || stdoutLines.join("\n").trim()
        const stderr = event.payload?.stderr?.trim() ?? ""

        if (code !== null && code !== undefined && code !== 0) {
          finishWith(() => onError(new Error(buildLocalCliError(provider, code, stderr, stdout))))
          return
        }

        const text = extractAssistantText(provider, stdout)
        if (!text) {
          finishWith(() => onError(new Error(`${provider} returned no assistant text.`)))
          return
        }
        finishWith(() => {
          onToken(text)
          onDone()
        })
      },
    )

    const payload: SpawnPayload = {
      streamId,
      provider,
      model: config.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: stringifyContent(m.content),
      })),
    }
    await invoke("local_cli_spawn", payload)
  } catch (err) {
    finishWith(() => onError(err instanceof Error ? err : new Error(String(err))))
  } finally {
    signal?.removeEventListener("abort", abortListener)
  }
}

function extractAssistantText(provider: LocalCliProvider, stdout: string): string {
  if (provider === "codex-cli") {
    // Codex writes the final answer into --output-last-message when
    // available; older/failed runs may only have terminal output. The
    // Rust side emits stdout either way, so strip common transcript
    // noise before falling back to the raw capture.
    const marker = "--- out ---"
    const markerIndex = stdout.lastIndexOf(marker)
    if (markerIndex >= 0) return stdout.slice(markerIndex + marker.length).trim()
  }
  return stdout.trim()
}

function buildLocalCliError(
  provider: LocalCliProvider,
  code: number,
  stderr: string,
  stdout: string,
): string {
  const providerName = provider === "codex-cli" ? "Codex CLI" : "Gemini CLI"
  const authHint = provider === "codex-cli"
    ? "Use OAuth login in Settings, or run `codex login` in a terminal."
    : "Use OAuth login in Settings, or run `gemini` in a terminal and complete Google sign-in."

  if (/unauth|auth|login|oauth|credential|not logged/i.test(`${stderr}\n${stdout}`)) {
    return `${providerName} is not authenticated. ${authHint}`
  }
  return [
    `${providerName} exited with code ${code}.`,
    stderr ? `\n\nstderr:\n${stderr}` : "",
    stdout ? `\n\nstdout:\n${stdout}` : "",
  ].join("").trim()
}
