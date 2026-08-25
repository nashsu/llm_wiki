import { beforeEach, describe, it, expect, vi } from "vitest"

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

/**
 * Lone-surrogate check without String.prototype.isWellFormed(), which
 * needs lib es2024 — the project targets lower and `npm run build`
 * rejects it. encodeURIComponent throws URIError on an unpaired
 * surrogate and nothing else here does.
 */
function isWellFormedUtf16(value: string): boolean {
  try {
    encodeURIComponent(value)
    return true
  } catch {
    return false
  }
}

import {
  createClaudeCodeStreamParser,
  buildExitError,
  isDiagnosticLine,
  truncateDiagnosticLine,
  UNPARSED_BUFFER_CAP,
  streamClaudeCodeCli,
} from "../claude-cli-transport"
import { useWikiStore } from "@/stores/wiki-store"

beforeEach(() => {
  vi.clearAllMocks()
  tauriMocks.reset()
  tauriMocks.invoke.mockResolvedValue(undefined)
  useWikiStore.setState({
    project: {
      id: "project-1",
      name: "Project",
      path: "/Users/me/wiki-project",
    },
  })
})

describe("createClaudeCodeStreamParser", () => {
  it("emits text from a single stream_event text_delta", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    })
    expect(parse(line)).toBe("Hello")
  })

  it("accumulates multiple stream_event deltas in order", () => {
    const parse = createClaudeCodeStreamParser()
    const mk = (t: string) =>
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
      })
    expect(parse(mk("Hello "))).toBe("Hello ")
    expect(parse(mk("world"))).toBe("world")
    expect(parse(mk("!"))).toBe("!")
  })

  it("falls back to `assistant` message text when no deltas arrived", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi there" }] },
    })
    expect(parse(line)).toBe("Hi there")
  })

  it("emits only the novel tail when `assistant` events ship cumulative text", () => {
    // Older claude CLI versions re-send the full in-progress message on
    // each assistant event instead of emitting deltas. The parser must
    // diff those so the UI doesn't render "HiHi thereHi there, friend".
    const parse = createClaudeCodeStreamParser()
    const mk = (t: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } })
    expect(parse(mk("Hi"))).toBe("Hi")
    expect(parse(mk("Hi there"))).toBe(" there")
    expect(parse(mk("Hi there, friend"))).toBe(", friend")
  })

  it("skips `assistant` events entirely once stream_event deltas are seen", () => {
    // When both event types are present (newer CLIs with --verbose),
    // deltas are authoritative and the fat `assistant` events would
    // duplicate text if we emitted them.
    const parse = createClaudeCodeStreamParser()
    const delta = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    })
    const asst = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    })
    expect(parse(delta)).toBe("Hi")
    expect(parse(asst)).toBeNull()
  })

  it("concatenates multiple text parts inside one `assistant` event", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part one. " },
          { type: "tool_use", id: "x", name: "bash", input: {} },
          { type: "text", text: "Part two." },
        ],
      },
    })
    expect(parse(line)).toBe("Part one. Part two.")
  })

  it("returns null for system init, result, tool_use, and unknown types", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "result", subtype: "success", result: "done" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "tool_use", id: "x" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "future_type_we_dont_know" }))).toBeNull()
  })

  it("returns null for malformed JSON or blank lines", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse("")).toBeNull()
    expect(parse("   ")).toBeNull()
    expect(parse("not json at all")).toBeNull()
    expect(parse("{bad json")).toBeNull()
  })

  it("returns null for stream_event shapes we don't recognize (usage/etc.)", () => {
    const parse = createClaudeCodeStreamParser()
    // e.g. message_start / message_delta / ping — Anthropic lifecycle
    // events that carry no user-visible text.
    expect(
      parse(
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_start", message: { id: "m" } },
        }),
      ),
    ).toBeNull()
    expect(
      parse(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "{\"a\":" },
          },
        }),
      ),
    ).toBeNull()
  })
})

describe("isDiagnosticLine", () => {
  it("drops routine stream-json events", () => {
    const noise = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart" }),
      // Real hook_response events always carry an outcome; see the
      // sample in #366. A clean one is the routine case.
      JSON.stringify({ type: "system", subtype: "hook_response", stdout: "x".repeat(5000), exit_code: 0, outcome: "success" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      "   ",
    ]
    for (const line of noise) {
      expect(isDiagnosticLine(line)).toBe(false)
    }
  })

  it("keeps error signals whatever event type carries them", () => {
    // Regression: an earlier cut of this filter dropped every `system`,
    // `assistant` and `user` event, which silently ate the diagnostics
    // below. Match the signal, not a list of Anthropic's subtypes.
    const carriers = [
      // A retry the CLI reports before giving up on an auth failure.
      JSON.stringify({ type: "system", subtype: "api_retry", error_status: 401, error: "authentication_failed" }),
      // A SessionStart hook that exited non-zero.
      JSON.stringify({ type: "system", subtype: "hook_response", exit_code: 2, outcome: "error", stderr: "hook blew up\n" }),
      // An assistant turn that is really an API error envelope.
      JSON.stringify({ type: "assistant", error: "oauth_org_not_allowed", is_api_error_message: true, message: { content: [] } }),
      // Subtypes we have never seen but that name themselves.
      JSON.stringify({ type: "system", subtype: "mirror_error" }),
      JSON.stringify({ type: "system", subtype: "plugin_install", status: "failed" }),
    ]
    for (const line of carriers) {
      expect(isDiagnosticLine(line)).toBe(true)
    }
  })

  it("keeps the result shape reported in #526 (minimized fixture: subtype success, is_error true)", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in \u00b7 Please run /login",
    })
    expect(isDiagnosticLine(line)).toBe(true)
  })

  it("keeps terminal system events even when no top-level signal names them", () => {
    // Minimized representative shapes, not wire-exact payloads: each
    // documented subtype records failure in a field this filter has no
    // reason to read, and the assertion is only that an unrecognized
    // `system` subtype defaults to kept. Otherwise the next one
    // Anthropic adds is eaten silently.
    const terminal = [
      { type: "system", subtype: "status", compact_result: "failed", compact_error: "boom" },
      { type: "system", subtype: "informational", prevent_continuation: true },
      { type: "system", subtype: "model_refusal_no_fallback" },
      { type: "system", subtype: "files_persisted", failed: ["a.md"] },
      { type: "system", subtype: "task_updated", patch: { status: "failed" } },
      // Invented on purpose: a subtype that does not exist yet.
      { type: "system", subtype: "some_future_terminal_event" },
    ]
    for (const obj of terminal) {
      expect(isDiagnosticLine(JSON.stringify(obj))).toBe(true)
    }
  })

  it("drops high-volume system telemetry", () => {
    // Observed on a live CLI run: these arrive steadily and say nothing
    // about failure, so leaving them in would rebuild the wall of JSON
    // this filter exists to prevent.
    expect(isDiagnosticLine(JSON.stringify({
      type: "system", subtype: "thinking_tokens", estimated_tokens: 3, estimated_tokens_delta: 3,
    }))).toBe(false)
    // rate_limit_event is a TOP-LEVEL type and nests its status. An
    // earlier cut of this filter looked for it under `system` with a
    // flat `status`, which matched nothing the CLI actually emits.
    // overageStatus "rejected" is normal telemetry on a healthy account
    // and must not by itself keep the frame.
    expect(isDiagnosticLine(JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", overageStatus: "rejected" },
    }))).toBe(false)
  })

  it("keeps a rate_limit_event that is not merely allowed", () => {
    expect(isDiagnosticLine(JSON.stringify({
      type: "rate_limit_event", rate_limit_info: { status: "rejected" },
    }))).toBe(true)
    // No status to clear it: keep rather than guess.
    expect(isDiagnosticLine(JSON.stringify({ type: "rate_limit_event" }))).toBe(true)
  })

  it("keeps a hook_response whose outcome is missing rather than guessing", () => {
    // Ambiguous shape: no outcome to clear it. Over-keeping costs noise,
    // over-dropping costs the failure reason, so it stays.
    expect(isDiagnosticLine(JSON.stringify({
      type: "system", subtype: "hook_response", stdout: "x".repeat(50),
    }))).toBe(true)
  })

  it("keeps a stream_event carrying an inner error", () => {
    expect(isDiagnosticLine(JSON.stringify({
      type: "stream_event", event: { type: "error", error: { type: "overloaded_error" } },
    }))).toBe(true)
    expect(isDiagnosticLine(JSON.stringify({
      type: "stream_event", event: { type: "content_block_delta" },
    }))).toBe(false)
  })

  it("still drops a hook_response that succeeded", () => {
    const line = JSON.stringify({
      type: "system", subtype: "hook_response", exit_code: 0, outcome: "success", stderr: "",
    })
    expect(isDiagnosticLine(line)).toBe(false)
  })

  it("keeps lines that explain a failure", () => {
    const signal = [
      JSON.stringify({ type: "error", error: { message: "Unauthenticated" } }),
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
      JSON.stringify({ type: "result", subtype: "error_max_turns" }),
      "Error loading config.toml: unknown variant `ultra`",
      "null",
    ]
    for (const line of signal) {
      expect(isDiagnosticLine(line)).toBe(true)
    }
  })
})

describe("truncateDiagnosticLine", () => {
  it("never exceeds the cap, marker included", () => {
    const out = truncateDiagnosticLine("x".repeat(20000))
    expect(out.length).toBeLessThanOrEqual(UNPARSED_BUFFER_CAP)
    expect(out).toContain("[truncated]")
  })

  it("leaves a line that already fits completely alone", () => {
    const line = JSON.stringify({ type: "error", message: "short" })
    expect(truncateDiagnosticLine(line)).toBe(line)
  })

  it("keeps the tail of an oversized hook line, where stderr and outcome live", () => {
    // A hook writes output first and its verdict last. Head-only
    // truncation drops exactly the fields that say it failed — the same
    // loss this whole buffer exists to prevent.
    const line = JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "SessionStart:startup",
      stdout: "You have superpowers. ".repeat(400),
      stderr: "synthetic-hook-failure",
      exit_code: 2,
      outcome: "error",
    })
    expect(line.length).toBeGreaterThan(UNPARSED_BUFFER_CAP)

    const out = truncateDiagnosticLine(line)
    expect(out).toContain('"subtype":"hook_response"')   // head survived
    expect(out).toContain("synthetic-hook-failure")      // tail survived
    expect(out).toContain('"outcome":"error"')
    expect(out.length).toBeLessThanOrEqual(UNPARSED_BUFFER_CAP)
  })

  it("does not split a surrogate pair at either cut point", () => {
    // Emoji and CJK Extension B sit outside the BMP: two code units each.
    // Slicing between them yields a lone surrogate, which becomes U+FFFD.
    for (const filler of ["\u{1F600}", "\u{20BB7}"]) {
      const line = filler.repeat(6000)
      const out = truncateDiagnosticLine(line)
      expect(isWellFormedUtf16(out)).toBe(true)
      expect(out.length).toBeLessThanOrEqual(UNPARSED_BUFFER_CAP)
    }
  })
})

describe("streamClaudeCodeCli", () => {
  it("evicts the oldest diagnostics once they exceed the buffer cap", async () => {
    // Every line here survives isDiagnosticLine, so this is the test
    // that actually drives the eviction loop. Deleting the loop must
    // turn this red.
    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )
    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    })
    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }

    // 12 x ~600 chars comfortably overruns the 4096 cap.
    for (let i = 0; i < 12; i += 1) {
      tauriMocks.emit(
        `claude-cli:${payload.streamId}`,
        JSON.stringify({ type: "error", seq: `seq-${String(i).padStart(2, "0")}`, pad: "p".repeat(600) }),
      )
    }
    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({ type: "error", seq: "seq-last", message: "the real failure" }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 1, stderr: "" })
    await stream

    const message = (callbacks.onError.mock.calls[0]?.[0] as Error).message
    expect(message).toContain("seq-last")
    expect(message).toContain("the real failure")
    // The earliest lines are the ones that must have been dropped.
    expect(message).not.toContain("seq-00")
    expect(message).not.toContain("seq-01")
  })

  it("truncates a single diagnostic line larger than the cap", async () => {
    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )
    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    })
    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }

    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({ type: "error", subtype: "huge", pad: "q".repeat(20000) }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 1, stderr: "" })
    await stream

    const message = (callbacks.onError.mock.calls[0]?.[0] as Error).message
    expect(message).toContain("[truncated]")
    // The head of the line survives — that is where type/subtype live.
    expect(message).toContain('"subtype":"huge"')
    // ...but the buffer stayed bounded rather than pasting all 20 KB.
    expect(message.length).toBeLessThan(6000)
  })

  it("keeps the failure line visible when hook events flood stdout", async () => {
    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )
    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    })
    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }

    // A single SessionStart hook can echo a whole skill file, and there
    // are several of them — far more than the diagnostic buffer holds.
    for (let i = 0; i < 20; i += 1) {
      tauriMocks.emit(
        `claude-cli:${payload.streamId}`,
        JSON.stringify({
          type: "system",
          subtype: "hook_response",
          hook_name: "SessionStart:startup",
          stdout: "You have superpowers. ".repeat(200),
          exit_code: 0,
          outcome: "success",
          stderr: "",
        }),
      )
    }
    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "MCP server codex failed to start",
      }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 1, stderr: "" })
    await stream

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    const message = (callbacks.onError.mock.calls[0]?.[0] as Error).message
    expect(message).toContain("MCP server codex failed to start")
    expect(message).not.toContain("superpowers")
  })

  it("does not resolve until the Claude CLI done event arrives", async () => {
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    let settled = false
    let resolveSpawn: (() => void) | undefined
    tauriMocks.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveSpawn = resolve
    }))

    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    ).finally(() => {
      settled = true
    })

    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    })
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "claude_cli_spawn",
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Analyze this source." }],
        workingDirectory: "/Users/me/wiki-project",
      }),
    )

    expect(resolveSpawn).toBeTypeOf("function")
    let spawnSettled = false
    void Promise.resolve(tauriMocks.invoke.mock.results[0]?.value).then(() => {
      spawnSettled = true
    })
    resolveSpawn?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spawnSettled).toBe(true)
    expect(settled).toBe(false)

    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "structured analysis" },
        },
      }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 0, stderr: "" })

    await stream

    expect(callbacks.onToken).toHaveBeenCalledWith("structured analysis")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("passes local CLI isolation preference to the Rust transport", async () => {
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
        localCliIsolation: true,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )

    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "claude_cli_spawn",
        expect.objectContaining({ isolateLocalConfig: true }),
      )
    })

    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 0, stderr: "" })

    await stream
  })

  it("passes the active project path as the Claude CLI working directory", async () => {
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )

    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "claude_cli_spawn",
        expect.objectContaining({ workingDirectory: "/Users/me/wiki-project" }),
      )
    })

    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 0, stderr: "" })

    await stream
  })

  it("surfaces an error without spawning when no project is active", async () => {
    useWikiStore.setState({ project: null })
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    await streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )

    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("claude_cli_spawn", expect.anything())
    expect(tauriMocks.listen).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/working directory/),
    })
  })

  it("surfaces a clear error when completion has no assistant text", async () => {
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )

    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    })

    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 0, stderr: "" })

    await stream

    expect(callbacks.onToken).not.toHaveBeenCalled()
    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("completed but returned no content"),
      }),
    )
  })

  it("does not spawn when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    await streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
      controller.signal,
    )

    expect(tauriMocks.invoke).not.toHaveBeenCalled()
    expect(tauriMocks.listen).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
})

describe("buildExitError", () => {
  it("translates Unauthenticated stderr into an actionable login hint", () => {
    const msg = buildExitError(1, "Unauthenticated: please log in")
    expect(msg).toMatch(/not authenticated/i)
    expect(msg).toMatch(/`claude`/)
    expect(msg).toMatch(/terminal/i)
  })

  it("includes the original stderr at the bottom for context", () => {
    const stderr = "Unauthenticated: token expired"
    const msg = buildExitError(1, stderr)
    expect(msg).toContain(stderr)
  })

  it("falls through to the bare exit-code form for unrecognized stderr", () => {
    expect(buildExitError(2, "Unknown flag: --foo")).toBe(
      "claude CLI exited with code 2: Unknown flag: --foo",
    )
  })

  it("works without stderr at all (truly silent exit)", () => {
    const msg = buildExitError(127, "")
    expect(msg).toMatch(/silently/)
    expect(msg).toMatch(/127/)
    expect(msg).toMatch(/terminal/)
  })

  it("matches the case-insensitive Authentication failed variant", () => {
    const msg = buildExitError(1, "Authentication failed (401)")
    expect(msg).toMatch(/not authenticated/i)
  })

  it("falls back to unparsed stdout when stderr is empty (the real-user case)", () => {
    // Real-user scenario: claude exit 1, stderr empty, but stdout
    // had a structured error event our parser didn't recognize.
    // Without this branch the user just saw "exited with code 1"
    // and had to grep the binary to guess what went wrong.
    const stdout = '{"type":"error","subtype":"oauth_expired","message":"token revoked"}'
    const msg = buildExitError(1, "", stdout)
    expect(msg).toContain("code 1")
    expect(msg).toContain("no stderr")
    expect(msg).toContain("oauth_expired")
    expect(msg).toContain("token revoked")
  })

  it("prefers stderr over unparsed stdout when both are present", () => {
    const msg = buildExitError(1, "real stderr here", "unrelated stdout")
    expect(msg).toContain("real stderr here")
    expect(msg).not.toContain("unrelated stdout")
  })

  it("recommends terminal reproduction when both stderr and stdout are empty", () => {
    const msg = buildExitError(1, "", "")
    expect(msg).toMatch(/silently/)
    expect(msg).toMatch(/terminal/)
    expect(msg).toMatch(/Anthropic API/)
  })
})
