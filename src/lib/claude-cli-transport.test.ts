import { beforeEach, describe, expect, it, vi } from "vitest"

const tauriMocks = vi.hoisted(() => {
  const listeners: Record<string, (event: { payload: unknown }) => void> = {}
  return {
    invoke: vi.fn(async (_command: string, _payload?: unknown): Promise<unknown> => undefined),
    listen: vi.fn(async (event: string, cb: (event: { payload: unknown }) => void) => {
      listeners[event] = cb
      return vi.fn(() => {
        delete listeners[event]
      })
    }),
    emit: (event: string, payload: unknown) => listeners[event]?.({ payload }),
    reset: () => {
      for (const event of Object.keys(listeners)) {
        delete listeners[event]
      }
    },
  }
})

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}))

import {
  buildExitError,
  createClaudeCodeStreamParser,
  extractStreamJsonError,
  isCliErrorFrame,
  streamClaudeCodeCli,
} from "./claude-cli-transport"
import { useWikiStore } from "@/stores/wiki-store"

beforeEach(() => {
  vi.clearAllMocks()
  tauriMocks.reset()
  tauriMocks.invoke.mockResolvedValue(undefined)
  useWikiStore.setState({
    project: {
      id: "test-project",
      name: "Test Project",
      path: "/Users/me/default-wiki-project",
    },
  })
})

/**
 * The frame shapes below are copied from the reproduction in #708: the
 * session-init frame echoes a large payload, and the failure travels in
 * a following `result` frame whose `subtype` misleadingly reads
 * "success" while `is_error` is what actually matters.
 */
const INIT_FRAME = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "abc-123",
  tools: ["Read", "Write"],
})

const AUTH_ERROR_FRAME = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  duration_ms: 812,
  num_turns: 1,
  result: "Failed to authenticate: OAuth session expired and could not be refreshed",
})

describe("isCliErrorFrame", () => {
  it("recognizes a result frame that reports is_error", () => {
    expect(isCliErrorFrame(AUTH_ERROR_FRAME)).toBe(true)
  })

  it("recognizes a bare error frame", () => {
    expect(isCliErrorFrame(JSON.stringify({ type: "error", message: "boom" }))).toBe(true)
  })

  it("recognizes the api-error and hook-outcome flags", () => {
    expect(isCliErrorFrame(JSON.stringify({ type: "result", is_api_error_message: true }))).toBe(
      true,
    )
    expect(isCliErrorFrame(JSON.stringify({ type: "hook_response", outcome: "error" }))).toBe(true)
    expect(isCliErrorFrame(JSON.stringify({ type: "status", status: "failed" }))).toBe(true)
  })

  it("does not flag a successful result frame", () => {
    expect(
      isCliErrorFrame(
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "pong" }),
      ),
    ).toBe(false)
  })

  it("does not flag ordinary traffic or malformed lines", () => {
    expect(isCliErrorFrame(INIT_FRAME)).toBe(false)
    expect(isCliErrorFrame(JSON.stringify({ type: "assistant", message: { content: [] } }))).toBe(
      false,
    )
    expect(isCliErrorFrame("not json")).toBe(false)
    expect(isCliErrorFrame("")).toBe(false)
    expect(isCliErrorFrame('{"type":"result"}')).toBe(false)
  })
})

describe("extractStreamJsonError", () => {
  it("pulls the cause out of an auth error frame", () => {
    expect(extractStreamJsonError(`${INIT_FRAME}\n${AUTH_ERROR_FRAME}`)).toBe(
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    )
  })

  it("unwraps an error object envelope", () => {
    expect(
      extractStreamJsonError(JSON.stringify({ type: "error", error: { message: "rate limited" } })),
    ).toBe("rate limited")
  })

  it("reads the error field when it is a plain string", () => {
    expect(extractStreamJsonError(JSON.stringify({ type: "error", error: "socket closed" }))).toBe(
      "socket closed",
    )
  })

  it("returns an empty string when there is no error frame", () => {
    expect(extractStreamJsonError(INIT_FRAME)).toBe("")
    expect(extractStreamJsonError("plain text")).toBe("")
    expect(extractStreamJsonError("")).toBe("")
  })

  it("returns an empty string when the frame names no message", () => {
    expect(extractStreamJsonError(JSON.stringify({ type: "result", is_error: true }))).toBe("")
  })
})

describe("buildExitError", () => {
  it("surfaces the friendly auth message when only stdout reports the expiry (#708)", () => {
    const message = buildExitError(1, "", `${INIT_FRAME}\n${AUTH_ERROR_FRAME}`)

    expect(message).toContain("Claude Code CLI is not authenticated.")
    expect(message).toContain("run `claude` to complete the OAuth login")
    // The cause is shown, but not as a raw JSON wall the user must comb
    // through: the init frame is gone and the reason is verbatim.
    expect(message).toContain("OAuth session expired and could not be refreshed")
    expect(message).not.toContain('"type":"system"')
    expect(message).not.toContain("couldn't parse")
  })

  it("still reports stderr-borne auth failures", () => {
    const message = buildExitError(1, "Unauthenticated: please log in", "")
    expect(message).toContain("Claude Code CLI is not authenticated.")
  })

  it("matches the reversed 'failed to authenticate' wording", () => {
    // The pre-existing regex expected "authentication.*failed"; the CLI
    // writes it the other way round, so this phrasing used to fall
    // through to the raw dump.
    const message = buildExitError(1, "Failed to authenticate", "")
    expect(message).toContain("Claude Code CLI is not authenticated.")
  })

  it("leads with the CLI-reported cause for non-auth errors", () => {
    const frame = JSON.stringify({ type: "result", is_error: true, result: "Model not found: gpt-9" })
    const message = buildExitError(1, "", `${INIT_FRAME}\n${frame}`)

    expect(message).toContain("Reported by the CLI: Model not found: gpt-9")
    expect(message).toContain("claude CLI exited with code 1 (no stderr).")
  })

  it("keeps the raw dump when stdout holds no error frame", () => {
    const message = buildExitError(1, "", INIT_FRAME)
    expect(message).toContain("couldn't parse")
    expect(message).toContain('"type":"system"')
  })

  it("still names the auth failure when stderr carries other text", () => {
    const message = buildExitError(1, "some unrelated failure", `${INIT_FRAME}\n${AUTH_ERROR_FRAME}`)
    // The structured error frame is the stronger signal, so the
    // actionable message wins — but stderr is kept in the detail line.
    expect(message).toContain("Claude Code CLI is not authenticated.")
    expect(message).toContain("some unrelated failure")
  })

  it("still falls back to the silent-exit message", () => {
    const message = buildExitError(7, "", "")
    expect(message).toContain("exited silently with code 7")
  })
})

describe("createClaudeCodeStreamParser", () => {
  it("keeps ignoring result frames so they never reach onToken", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse(AUTH_ERROR_FRAME)).toBeNull()
    expect(parse(INIT_FRAME)).toBeNull()
  })

  it("still streams assistant text", () => {
    const parse = createClaudeCodeStreamParser()
    expect(
      parse(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "pong" }] },
        }),
      ),
    ).toBe("pong")
  })
})

describe("streamClaudeCodeCli diagnostics", () => {
  /** Drive one full spawn round-trip through the mocked Tauri events. */
  async function runWithStdout(lines: string[], done: { code: number; stderr: string }) {
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    let streamId = ""
    tauriMocks.invoke.mockImplementation(async (command: string, payload?: unknown) => {
      if (command === "claude_cli_spawn") {
        streamId = (payload as { streamId: string }).streamId
        // Deliver stdout frames, then the completion event.
        for (const line of lines) tauriMocks.emit(`claude-cli:${streamId}`, line)
        tauriMocks.emit(`claude-cli:${streamId}:done`, done)
      }
      return undefined
    })

    await streamClaudeCodeCli(
      { provider: "claude-code-cli", model: "sonnet" } as never,
      [{ role: "user", content: "ping" }] as never,
      { onToken, onDone, onError },
    )
    return { onToken, onDone, onError }
  }

  it("reports an expired OAuth session as an auth failure, not a parse dump", async () => {
    const { onError, onDone } = await runWithStdout([INIT_FRAME, AUTH_ERROR_FRAME], {
      code: 1,
      stderr: "",
    })

    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    const message = onError.mock.calls[0][0].message as string
    expect(message).toContain("Claude Code CLI is not authenticated.")
    expect(message).toContain("OAuth session expired")
  })

  it("keeps the error frame even when start-up exhausts the diagnostic budget", async () => {
    // A session-init frame fat enough to fill the 4096-unit unparsed
    // buffer on its own: the error frame arrives after it, so it would
    // be refused outright if it shared that budget.
    const fatInit = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: Array.from({ length: 400 }, (_, i) => `tool-${i}`),
      padding: "x".repeat(2000),
    })
    expect(fatInit.length).toBeGreaterThan(4096)

    const { onError } = await runWithStdout([fatInit, AUTH_ERROR_FRAME], { code: 1, stderr: "" })

    expect(onError).toHaveBeenCalledTimes(1)
    const message = onError.mock.calls[0][0].message as string
    expect(message).toContain("Claude Code CLI is not authenticated.")
    expect(message).toContain("OAuth session expired")
  })

  it("passes a successful run straight through", async () => {
    const assistant = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "pong" }] },
    })
    const { onToken, onDone, onError } = await runWithStdout(
      [INIT_FRAME, assistant, JSON.stringify({ type: "result", subtype: "success", is_error: false })],
      { code: 0, stderr: "" },
    )

    expect(onError).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith("pong")
  })

  it("still reports a genuinely silent success as no-content", async () => {
    const { onError, onDone } = await runWithStdout(
      [INIT_FRAME, JSON.stringify({ type: "result", subtype: "success", is_error: false })],
      { code: 0, stderr: "" },
    )

    expect(onDone).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toContain("returned no content")
  })
})
