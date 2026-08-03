import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Stub getHttpFetch so streamChat hits our in-test responder; keep the
// rest of tauri-fetch (notably isFetchNetworkError) real so the existing
// cross-webview tests below still exercise the genuine classifier.
const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()
vi.mock("./tauri-fetch", async () => {
  const actual = await vi.importActual<typeof import("./tauri-fetch")>("./tauri-fetch")
  return { ...actual, getHttpFetch: () => Promise.resolve(mockHttpFetch) }
})

import { isFetchNetworkError, isReasoningOnlyResponseError, streamChat } from "./llm-client"
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
