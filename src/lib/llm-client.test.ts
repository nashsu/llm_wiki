import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Stub getHttpFetch so streamChat hits our in-test responder; keep the
// rest of tauri-fetch (notably isFetchNetworkError) real so the existing
// cross-webview tests below still exercise the genuine classifier.
const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()
vi.mock("./tauri-fetch", async () => {
  const actual = await vi.importActual<typeof import("./tauri-fetch")>("./tauri-fetch")
  return { ...actual, getHttpFetch: () => Promise.resolve(mockHttpFetch) }
})

import { isFetchNetworkError, isReasoningOnlyResponseError, streamChat, streamChatWithReasoningRetry } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * Guards for cross-webview error detection. Tauri renders the frontend
 * with WebKit on macOS/Linux and Edge WebView2 (Chromium) on Windows,
 * and each backend phrases fetch failures differently. These tests pin
 * down that every real-world error shape gets classified as a network
 * error so the user sees a helpful message instead of a raw stack.
 */
describe("isFetchNetworkError — cross-webview fetch failures", () => {
  it("recognises WebKit's 'Load failed' (macOS / Linux GTK)", () => {
    const e = new Error("Load failed")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises Chromium/Edge's TypeError: Failed to fetch (Windows)", () => {
    // Real Chromium throws a TypeError with this exact shape.
    const e = new TypeError("Failed to fetch")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises any TypeError (Chromium fetch failure class)", () => {
    // Chromium also throws TypeError with messages like "NetworkError
    // when attempting to fetch resource." — the name alone is enough.
    const e = new TypeError("NetworkError when attempting to fetch resource.")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises messages containing 'network error' (mid-stream drops)", () => {
    const e = new Error("The network error occurred while reading")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("rejects AbortError (user cancelled)", () => {
    const e = new Error("The operation was aborted.")
    e.name = "AbortError"
    expect(isFetchNetworkError(e)).toBe(false)
  })

  it("rejects plain application errors (HTTP 4xx surfaced as Error)", () => {
    const e = new Error("HTTP 401: Unauthorized")
    expect(isFetchNetworkError(e)).toBe(false)
  })

  it("rejects non-Error values (strings, null, objects)", () => {
    expect(isFetchNetworkError("boom")).toBe(false)
    expect(isFetchNetworkError(null)).toBe(false)
    expect(isFetchNetworkError(undefined)).toBe(false)
    expect(isFetchNetworkError({ message: "Load failed" })).toBe(false)
  })
})

describe("isReasoningOnlyResponseError", () => {
  it("recognises the reasoning-only stream diagnostic", () => {
    expect(isReasoningOnlyResponseError(
      new Error("Model produced 2,176 characters of reasoning / chain-of-thought, but no actual response content. Try again."),
    )).toBe(true)
    expect(isReasoningOnlyResponseError(new Error("plain provider error"))).toBe(false)
  })
})

/**
 * The streaming-path abort handling. When the 30-min backstop fires
 * mid-stream the Tauri HTTP plugin tears the body stream down with a
 * BARE STRING "Request cancelled" (controller.error(string)), not an
 * Error. The old guard only matched `err instanceof Error`, so that
 * string fell through to the generic branch and surfaced verbatim —
 * exactly the cryptic "request cancelled" the dedup scan showed. These
 * pin down that the string is now recognized as an abort and mapped to
 * the actionable timeout message (or a silent cancel when no backstop).
 */
const cfg: LlmConfig = {
  provider: "ollama",
  apiKey: "",
  model: "qwen3:8b",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxContextSize: 8192,
}

const customStreamingCfg: LlmConfig = {
  ...cfg,
  provider: "custom",
  model: "local-openai-model",
  customEndpoint: "http://127.0.0.1:13305/v1",
}

function openAiSseToken(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`
}

function openAiSseReasoning(reasoning: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}`
}

/** Opening chunk of every OpenAI-compatible stream: role only, empty content. */
function openAiSseRoleOnly(): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" } }] })}`
}

/** Closing chunk of such a stream: empty content plus finish_reason. */
function openAiSseFinish(): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: "" }, finish_reason: "stop" }],
  })}`
}

function sseResponse(...records: string[]): Response {
  return new Response([...records, "data: [DONE]"].join("\n\n"), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

/**
 * Issue #743: a reasoning-capable model on a OpenAI-compatible gateway can
 * spend its entire output budget on chain-of-thought and end the stream with
 * no `content`. Structured ingest calls used a fixed small budget, so the
 * diagnostic fired and the page was lost. These pin down the recovery: one
 * re-issue with a larger budget, and no retry when that cannot help.
 */
describe("streamChatWithReasoningRetry", () => {
  beforeEach(() => mockHttpFetch.mockReset())

  it("re-issues the request with a larger budget when the model only thought", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(sseResponse(openAiSseReasoning("t".repeat(300))))
      .mockResolvedValueOnce(sseResponse(openAiSseToken("analysis")))

    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
      undefined,
      { temperature: 0.1, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body)).max_tokens).toBe(4_096)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body)).max_tokens).toBe(16_384)
    expect(onToken).toHaveBeenCalledWith("analysis")
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("retries when the gateway brackets the stream with empty content deltas", async () => {
    // The #743 wire shape: `content: ""` in the role-only opening chunk and
    // again in the finish_reason chunk. Counting those empty deltas as "the
    // model answered" kept the retry from ever firing on the endpoints this
    // fix targets, so the CoT-only analysis was still lost.
    mockHttpFetch
      .mockResolvedValueOnce(sseResponse(
        openAiSseRoleOnly(),
        openAiSseReasoning("t".repeat(300)),
        openAiSseFinish(),
      ))
      .mockResolvedValueOnce(sseResponse(openAiSseToken("analysis")))

    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
      undefined,
      { temperature: 0.1, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body)).max_tokens).toBe(16_384)
    // The answer arrives exactly once — the re-issue cannot duplicate it.
    expect(onToken.mock.calls.filter((call) => call[0] === "analysis")).toHaveLength(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("does not retry an empty stream that never thought", async () => {
    // Guards the character accounting from over-retrying: empty deltas with
    // no reasoning are a clean (if useless) stream, not the #743 failure.
    mockHttpFetch.mockImplementation(async () =>
      sseResponse(openAiSseRoleOnly(), openAiSseFinish()),
    )

    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
      undefined,
      { max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("surfaces the diagnostic instead of retrying once the budget is at the ceiling", async () => {
    mockHttpFetch.mockImplementation(async () => sseResponse(openAiSseReasoning("t".repeat(300))))

    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
      undefined,
      { max_tokens: 32_768 },
    )

    // Re-sending an identical request would fail identically, so the original
    // diagnostic is the honest answer.
    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(isReasoningOnlyResponseError(onError.mock.calls[0][0])).toBe(true)
    expect(onDone).not.toHaveBeenCalled()
  })

  it("passes a normal successful stream straight through", async () => {
    mockHttpFetch.mockImplementation(async () => sseResponse(openAiSseToken("ok")))

    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
      undefined,
      { max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith("ok")
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("does not retry unrelated endpoint errors", async () => {
    mockHttpFetch.mockImplementation(async () => new Response(
      JSON.stringify({ error: { code: 400, message: "request exceeds available context" } }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ))

    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
      undefined,
      { max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe(
      "LLM endpoint error 400: request exceeds available context",
    )
    expect(onDone).not.toHaveBeenCalled()
  })

  it("makes at most one budget retry", async () => {
    mockHttpFetch.mockImplementation(async () => sseResponse(openAiSseReasoning("t".repeat(300))))

    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError },
      undefined,
      { max_tokens: 4_096 },
    )

    // 4096 -> 16384 once, then stop: a second bump would re-send a request that
    // has already failed twice.
    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body)).max_tokens).toBe(16_384)
    expect(isReasoningOnlyResponseError(onError.mock.calls[0][0])).toBe(true)
    expect(onError.mock.calls[0][0].message).toContain("retried with max_tokens=16384")
  })

  it("keeps the original diagnostic when the retry fails for another reason", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(sseResponse(openAiSseReasoning("t".repeat(300))))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "max_tokens is too large: 32768" },
      }), { status: 400 }))

    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError },
      undefined,
      { max_tokens: 8_192 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    const message = String(onError.mock.calls[0][0].message)
    // The root cause stays first so the anchored detector still recognises it,
    // and the retry's own failure is attached instead of replacing it.
    expect(message.startsWith("Model produced")).toBe(true)
    expect(isReasoningOnlyResponseError(onError.mock.calls[0][0])).toBe(true)
    expect(message).toContain("max_tokens is too large")
  })

  it("honours a caller-supplied output ceiling for the retry", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(sseResponse(openAiSseReasoning("t".repeat(300))))
      .mockResolvedValueOnce(sseResponse(openAiSseToken("ok")))

    const onToken = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone: vi.fn(), onError: vi.fn() },
      undefined,
      { max_tokens: 4_096 },
      { maxTokensCeiling: 8_192 },
    )

    expect(JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body)).max_tokens).toBe(8_192)
    expect(onToken).toHaveBeenCalledWith("ok")
  })

  it("retries once when a non-streaming endpoint answers with no content", async () => {
    const nonStreaming: LlmConfig = { ...customStreamingCfg, streamingEnabled: false }
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "" } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "complete answer" } }],
      }), { status: 200 }))

    const onToken = vi.fn()
    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      nonStreaming,
      [{ role: "user", content: "hi" }],
      { onToken, onDone: vi.fn(), onError },
      undefined,
      { max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body)).max_tokens).toBe(16_384)
    expect(onToken).toHaveBeenCalledWith("complete answer")
    expect(onError).not.toHaveBeenCalled()
  })

  it("does not start a retry after the caller cancels", async () => {
    const controller = new AbortController()
    mockHttpFetch.mockImplementation(async () => {
      controller.abort()
      return sseResponse(openAiSseReasoning("t".repeat(300)))
    })

    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChatWithReasoningRetry(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      controller.signal,
      { max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("releases the backstop timer when a request settles", async () => {
    vi.useFakeTimers()
    try {
      mockHttpFetch.mockImplementation(async () => sseResponse(openAiSseToken("ok")))
      const controller = new AbortController()
      const onDone = vi.fn()

      await streamChat(
        customStreamingCfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError: vi.fn() },
        controller.signal,
      )

      expect(onDone).toHaveBeenCalledTimes(1)
      // Without the settle() cleanup this stays at 1 for the full 30-minute
      // backstop window, once per attempt.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("streamChat — buffered streaming responses", () => {
  beforeEach(() => mockHttpFetch.mockReset())

  it("surfaces a JSON endpoint error returned inside HTTP 200", async () => {
    mockHttpFetch.mockResolvedValue(new Response(JSON.stringify({
      error: { code: 400, message: "request exceeds available context" },
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe(
      "LLM endpoint error 400: request exceeds available context",
    )
    expect(onToken).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("retries a custom endpoint without temperature when the provider rejects it", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unsupported parameter: temperature" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response([
        openAiSseToken("retried"),
        "data: [DONE]",
      ].join("\n\n"), { status: 200 }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
      undefined,
      { temperature: 0.1, max_tokens: 512 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))).toMatchObject({
      temperature: 0.1,
      max_tokens: 512,
    })
    const retryBody = JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body))
    expect(retryBody.temperature).toBeUndefined()
    expect(retryBody.max_tokens).toBe(512)
    expect(onToken).toHaveBeenCalledWith("retried")
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("does not blame a field the endpoint never carried", async () => {
    // OpenRouter owns its reasoning mapping, so the explicit method is never
    // sent and a 400 naming it must not be read as a rejection of our field.
    const openrouter: LlmConfig = {
      ...customStreamingCfg,
      customEndpoint: "https://openrouter.ai/api/v1",
      reasoningDisable: "chat_template_kwargs",
    }
    mockHttpFetch.mockImplementation(async () => new Response(JSON.stringify({
      error: { message: "Unrecognized request argument: chat_template_kwargs" },
    }), { status: 400 }))

    const onError = vi.fn()

    await streamChat(
      openrouter,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError },
      undefined,
      { reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it("matches the field the chosen method actually sends", async () => {
    // `thinking_disabled` sends `thinking`, which a fixed keyword list missed.
    const config: LlmConfig = { ...customStreamingCfg, reasoningDisable: "thinking_disabled" }
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unrecognized request argument: thinking" },
      }), { status: 400 }))
      .mockResolvedValueOnce(sseResponse(openAiSseToken("ok")))

    const onToken = vi.fn()

    await streamChat(
      config,
      [{ role: "user", content: "hi" }],
      { onToken, onDone: vi.fn(), onError: vi.fn() },
      undefined,
      { reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(onToken).toHaveBeenCalledWith("ok")
  })

  it("retries once even when the rejection names no field", async () => {
    // Recovery-first: a gateway rejecting an unknown key often says only
    // "invalid request body", and not trying can cost the whole page.
    const config: LlmConfig = { ...customStreamingCfg, reasoningDisable: "enable_thinking" }
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "invalid request body" },
      }), { status: 400 }))
      .mockResolvedValueOnce(sseResponse(openAiSseToken("ok")))

    const onToken = vi.fn()
    const onNotice = vi.fn()

    await streamChat(
      config,
      [{ role: "user", content: "hi" }],
      { onToken, onDone: vi.fn(), onError: vi.fn(), onNotice },
      undefined,
      { reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body)).enable_thinking).toBeUndefined()
    expect(onToken).toHaveBeenCalledWith("ok")
    // The notice states outcomes, not causes.
    const notice = String(onNotice.mock.calls[0][0])
    expect(notice).toContain("retrying without enable_thinking succeeded")
    expect(notice).not.toContain("rejected")
  })

  it("reports both errors when the recovery attempt also fails", async () => {
    const config: LlmConfig = { ...customStreamingCfg, reasoningDisable: "enable_thinking" }
    mockHttpFetch.mockImplementation(async () => new Response(JSON.stringify({
      error: { message: "invalid request body" },
    }), { status: 400 }))

    const onNotice = vi.fn()
    const onError = vi.fn()

    await streamChat(
      config,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError, onNotice },
      undefined,
      { reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(onNotice).not.toHaveBeenCalled()
    const message = String(onError.mock.calls[0][0].message)
    expect(message).toContain("invalid request body")
    expect(message).toContain("also failed")
  })

  it("delivers the notice before the terminal callback", async () => {
    const config: LlmConfig = { ...customStreamingCfg, reasoningDisable: "chat_template_kwargs" }
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unrecognized request argument: chat_template_kwargs" },
      }), { status: 400 }))
      .mockResolvedValueOnce(sseResponse(openAiSseToken("ok")))

    const order: string[] = []

    await streamChat(
      config,
      [{ role: "user", content: "hi" }],
      {
        onToken: vi.fn(),
        onNotice: () => { order.push("notice") },
        onDone: () => { order.push("done") },
        onError: () => { order.push("error") },
      },
      undefined,
      { reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    // Callers finalize state (and persist warnings) on onDone.
    expect(order).toEqual(["notice", "done"])
  })

  it("puts nothing on the wire when the caller cancelled before the attempt", async () => {
    const config: LlmConfig = { ...customStreamingCfg, reasoningDisable: "chat_template_kwargs" }
    mockHttpFetch.mockImplementation(async () => sseResponse(openAiSseToken("ok")))

    const controller = new AbortController()
    controller.abort()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      config,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      controller.signal,
      { reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    // An abort that happened before we subscribed never fires the listener.
    expect(mockHttpFetch).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("keeps the request count bounded at five on the worst reachable path", async () => {
    // The reachable maximum, not a guess: the temperature retry can itself end
    // in a reasoning-only answer, which triggers the outer budget retry with the
    // original overrides restored, and that attempt can walk the same two
    // fallbacks again. 1 temperature 400 -> 2 without temperature, reasoning
    // only -> 3 budget retry, temperature 400 again -> 4 without temperature,
    // field 400 -> 5 without the field. A failed downgrade composes an error
    // that is not retryable, so it stops there.
    const config: LlmConfig = { ...customStreamingCfg, reasoningDisable: "chat_template_kwargs" }
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unsupported parameter: temperature" },
      }), { status: 400 }))
      .mockResolvedValueOnce(sseResponse(openAiSseReasoning("t".repeat(300))))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unsupported parameter: temperature" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unrecognized request argument supplied: chat_template_kwargs" },
      }), { status: 400 }))
      .mockImplementation(async () => new Response(JSON.stringify({
        error: { message: "still broken" },
      }), { status: 400 }))

    const onError = vi.fn()
    const onDone = vi.fn()

    await streamChatWithReasoningRetry(
      config,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      undefined,
      { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(5)
    const bodies = mockHttpFetch.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
    )
    // 1: as configured. 2: temperature dropped, field kept.
    expect(bodies[0]).toMatchObject({ temperature: 0.1, max_tokens: 4_096 })
    expect(bodies[1].temperature).toBeUndefined()
    expect(bodies[1].chat_template_kwargs).toEqual({ enable_thinking: false })
    // 3: budget retry restores the original overrides with a larger budget.
    expect(bodies[2]).toMatchObject({ temperature: 0.1, max_tokens: 16_384 })
    // 4: temperature dropped again, field kept. 5: field dropped too.
    expect(bodies[3].temperature).toBeUndefined()
    expect(bodies[3].chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(bodies[4].temperature).toBeUndefined()
    expect(bodies[4].chat_template_kwargs).toBeUndefined()

    // Exactly one terminal callback, and it is the failure.
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
  })

  it("settles a cancel through the wrapper exactly once, with no retry", async () => {
    vi.useFakeTimers()
    try {
      mockHttpFetch.mockReset()
      const { response, getReject, readCalled } = pendingStreamResponse()
      mockHttpFetch.mockResolvedValue(response)

      const onError = vi.fn()
      const onDone = vi.fn()
      const promise = streamChatWithReasoningRetry(
        customStreamingCfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError },
      )

      await readCalled
      getReject()("Request cancelled")
      await promise

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
      expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("settles a backstop timeout through the wrapper exactly once", async () => {
    vi.useFakeTimers()
    try {
      mockHttpFetch.mockReset()
      const { response, getReject, readCalled } = pendingStreamResponse()
      mockHttpFetch.mockResolvedValue(response)

      const onError = vi.fn()
      const onDone = vi.fn()
      const promise = streamChatWithReasoningRetry(
        customStreamingCfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError },
      )

      await readCalled
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      getReject()("Request cancelled")
      await promise

      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0][0].message).toMatch(/timed out after 30 min/)
      expect(onDone).not.toHaveBeenCalled()
      // A timeout is not an empty answer, so it must not be retried.
      expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports both errors and no notice when the downgraded request fails", async () => {
    const config: LlmConfig = { ...customStreamingCfg, reasoningDisable: "chat_template_kwargs" }
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unrecognized request argument: chat_template_kwargs" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "still broken" },
      }), { status: 400 }))

    const onNotice = vi.fn()
    const onError = vi.fn()
    const onDone = vi.fn()

    await streamChat(
      config,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError, onNotice },
      undefined,
      { reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    // The downgrade never happened, so it must not be reported as one.
    expect(onNotice).not.toHaveBeenCalled()
    // ...and the failure is the single terminal callback.
    expect(onDone).not.toHaveBeenCalled()
    const message = String(onError.mock.calls[0][0].message)
    expect(message).toContain("chat_template_kwargs")
    expect(message).toContain("still broken")
  })

  it("still cleans up and retries when the notice handler throws", async () => {
    vi.useFakeTimers()
    try {
      const config: LlmConfig = { ...customStreamingCfg, reasoningDisable: "chat_template_kwargs" }
      mockHttpFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({
          error: { message: "Unrecognized request argument: chat_template_kwargs" },
        }), { status: 400 }))
        .mockResolvedValueOnce(sseResponse(openAiSseToken("ok")))

      const controller = new AbortController()
      const onToken = vi.fn()
      const onDone = vi.fn()
      const onNotice = vi.fn(() => {
        throw new Error("observer blew up")
      })

      await streamChat(
        config,
        [{ role: "user", content: "hi" }],
        { onToken, onDone, onError: vi.fn(), onNotice },
        controller.signal,
        { reasoning: { mode: "off" }, max_tokens: 4_096 },
      )

      expect(onToken).toHaveBeenCalledWith("ok")
      expect(onDone).toHaveBeenCalledTimes(1)
      // A throwing observer must not be able to leak the backstop timer.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops the rejected stop-thinking field and retries with thinking on", async () => {
    const configWithMethod: LlmConfig = {
      ...customStreamingCfg,
      reasoningDisable: "chat_template_kwargs",
    }
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unrecognized request argument supplied: chat_template_kwargs" },
      }), { status: 400 }))
      .mockResolvedValueOnce(sseResponse(openAiSseToken("ok")))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    const onNotice = vi.fn()

    await streamChat(
      configWithMethod,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError, onNotice },
      undefined,
      { reasoning: { mode: "off" }, temperature: 0.1, max_tokens: 4_096 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))
    expect(firstBody.chat_template_kwargs).toEqual({ enable_thinking: false })
    // Only the selected method is sent: a second guess would make a gateway that
    // rejects one field reject both.
    expect(firstBody.reasoning_effort).toBeUndefined()
    // The re-issue keeps the sampling knobs but leaves thinking enabled, so a
    // gateway that cannot express "off" still completes the ingest.
    const retryBody = JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body))
    expect(retryBody.chat_template_kwargs).toBeUndefined()
    expect(retryBody.temperature).toBe(0.1)
    // ...and the downgrade of an explicit user choice is reported, not silent.
    expect(onNotice).toHaveBeenCalledTimes(1)
    expect(String(onNotice.mock.calls[0][0])).toContain("chat_template_kwargs")
    expect(onToken).toHaveBeenCalledWith("ok")
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("sends nothing for off while no stop-thinking method is configured", async () => {
    // The default contract: an untouched custom config must behave exactly as it
    // did before the selector existed, even with reasoning off.
    mockHttpFetch.mockImplementation(async () => sseResponse(openAiSseToken("ok")))
    const onNotice = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onNotice },
      undefined,
      { reasoning: { mode: "off" }, max_tokens: 4_096 },
    )

    const body = JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))
    expect(body.chat_template_kwargs).toBeUndefined()
    expect(body.enable_thinking).toBeUndefined()
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
    expect(onNotice).not.toHaveBeenCalled()
  })

  it("also falls back when the config, not an override, asked for off", async () => {
    // Callers such as lint, deep research and enrich-wikilinks pass no reasoning
    // override, so their effective mode comes from the config. The fallback must
    // fire for them too, which is why the guard asks the body builder's own
    // predicate instead of re-reading `requestOverrides`.
    const configOff: LlmConfig = {
      ...customStreamingCfg,
      reasoning: { mode: "off" },
      reasoningDisable: "chat_template_kwargs",
    }
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Extra inputs are not permitted: chat_template_kwargs" },
      }), { status: 400 }))
      .mockResolvedValueOnce(sseResponse(openAiSseToken("ok")))

    const onToken = vi.fn()
    const onError = vi.fn()

    await streamChat(configOff, [{ role: "user", content: "hi" }], {
      onToken,
      onDone: vi.fn(),
      onError,
    })

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body)).chat_template_kwargs)
      .toEqual({ enable_thinking: false })
    const retryBody = JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body))
    expect(retryBody.chat_template_kwargs).toBeUndefined()
    expect(retryBody.reasoning_effort).toBeUndefined()
    expect(onToken).toHaveBeenCalledWith("ok")
    expect(onError).not.toHaveBeenCalled()
  })

  it("cancels a still-open response body after an SSE endpoint error", async () => {
    let bodyCancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"error":{"message":"stream failed"}}\n',
        ))
      },
      cancel() {
        bodyCancelled = true
      },
    })
    mockHttpFetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe("LLM endpoint error: stream failed")
    expect(bodyCancelled).toBe(true)
    expect(onToken).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("parses every record from a fully buffered SSE body", async () => {
    const body = [
      openAiSseToken("Hello"),
      "",
      openAiSseToken(" world"),
      "",
      "data: [DONE]",
      "",
    ].join("\n")
    mockHttpFetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onToken.mock.calls.map(([token]) => token)).toEqual(["Hello", " world"])
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("normalizes escaped separators in a buffered SSE body", async () => {
    const body = [
      openAiSseToken("Hello"),
      openAiSseToken(" world"),
      "data: [DONE]",
    ].join("\\n\\n")
    mockHttpFetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onToken.mock.calls.map(([token]) => token)).toEqual(["Hello", " world"])
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("does not split separator-like text inside streamed JSON content", async () => {
    const content = "first line\n\ndata: still model output"
    const body = [
      openAiSseToken(content),
      "data: [DONE]",
    ].join("\\n\\n")
    mockHttpFetch.mockResolvedValue(new Response(body, { status: 200 }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onToken).toHaveBeenCalledWith(content)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe("streamChat — non-streaming HTTP responses", () => {
  beforeEach(() => mockHttpFetch.mockReset())

  it("emits one complete token and completes", async () => {
    mockHttpFetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "complete answer" } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      { ...cfg, streamingEnabled: false },
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onToken).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith("complete answer")
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))).toMatchObject({ stream: false })
  })

  it("reports an empty complete response instead of silently succeeding", async () => {
    mockHttpFetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "" } }],
    }), { status: 200 }))
    const onError = vi.fn()

    await streamChat(
      { ...cfg, streamingEnabled: false },
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError },
    )

    expect(onError.mock.calls[0][0].message).toContain("empty non-streaming response")
  })
})

/** A Response whose reader.read() stays pending until we reject it,
 *  letting the test interleave the 30-min backstop before the abort.
 *  `readCalled` resolves once streamChat reaches read(), so the test
 *  can await it instead of guessing how many microtasks to flush. */
function pendingStreamResponse(): {
  response: Response
  getReject: () => (e: unknown) => void
  readCalled: Promise<void>
} {
  let reject!: (e: unknown) => void
  let signalReadCalled!: () => void
  const readCalled = new Promise<void>((res) => { signalReadCalled = res })
  const reader = {
    read: () =>
      new Promise<never>((_resolve, rej) => {
        reject = rej
        signalReadCalled()
      }),
    releaseLock: () => {},
    cancel: () => {},
  }
  const response = {
    ok: true,
    body: { getReader: () => reader },
  } as unknown as Response
  return { response, getReject: () => reject, readCalled }
}

describe("streamChat — mid-stream abort mapping", () => {
  beforeEach(() => {
    mockHttpFetch.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("maps the plugin's bare-string abort to the timeout message when the 30-min backstop fired", async () => {
    const { response, getReject, readCalled } = pendingStreamResponse()
    mockHttpFetch.mockResolvedValue(response)

    const onError = vi.fn()
    const onDone = vi.fn()
    const promise = streamChat(
      cfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      undefined,
      {},
    )

    // Wait until streamChat is parked in read(), then fire the long-horizon
    // backstop and let the plugin error the stream with its bare string.
    await readCalled
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    getReject()("Request cancelled")
    await promise

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toMatch(/timed out after 30 min/)
    expect(onDone).not.toHaveBeenCalled()
  })

  it("uses the provider's configured request timeout", async () => {
    const { response, getReject, readCalled } = pendingStreamResponse()
    mockHttpFetch.mockResolvedValue(response)
    const onError = vi.fn()
    const promise = streamChat(
      { ...cfg, requestTimeoutMinutes: 90 },
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError },
    )
    await readCalled
    await vi.advanceTimersByTimeAsync(90 * 60 * 1000)
    getReject()("Request cancelled")
    await promise
    expect(onError.mock.calls[0][0].message).toMatch(/timed out after 90 min/)
  })

  it("treats a bare-string abort as a silent cancel when the backstop did NOT fire", async () => {
    const { response, getReject, readCalled } = pendingStreamResponse()
    mockHttpFetch.mockResolvedValue(response)

    const onError = vi.fn()
    const onDone = vi.fn()
    const promise = streamChat(
      cfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      undefined,
      {},
    )

    await readCalled
    getReject()("Request cancelled")
    await promise

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("recognises lowercase and single-l cancelled spellings as silent cancels", async () => {
    for (const message of ["request cancelled", "Request canceled"]) {
      const { response, getReject, readCalled } = pendingStreamResponse()
      mockHttpFetch.mockResolvedValueOnce(response)

      const onError = vi.fn()
      const onDone = vi.fn()
      const promise = streamChat(
        cfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError },
        undefined,
        {},
      )

      await readCalled
      getReject()(message)
      await promise

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    }
  })

  it("treats pre-fetch bare-string cancel spellings as silent cancels", async () => {
    for (const message of ["request cancelled", "Request canceled"]) {
      mockHttpFetch.mockReset()
      mockHttpFetch.mockRejectedValueOnce(message)

      const onError = vi.fn()
      const onDone = vi.fn()
      await streamChat(
        cfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError },
        undefined,
        {},
      )

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    }
  })
})
