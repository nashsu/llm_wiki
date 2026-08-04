// Tests for the ingest LLM call layer (issue #14 P0):
// streaming accumulation on both wires, overrides pass-through, the
// request-timeout backstop, usage-limit classification, caller cancellation,
// and the fail-fast rejection of CLI-only providers.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { streamChat, isUsageLimitError, IngestLlmError, USAGE_LIMIT_BACKOFF_MS } from "../src/ingest/llm.js"

const enc = new TextEncoder()

function sseBody(lines) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(lines.map((l) => `data: ${l}\n\n`).join("")))
      controller.close()
    },
  })
}

// A body whose reader stays pending until the given signal aborts — simulates
// a hung provider connection so the timeout backstop is what rescues us.
function hangingBody(signal) {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("This operation was aborted", "AbortError"))
      })
    },
  })
}

function openAiSseResponse(chunks) {
  const lines = chunks.map((c) => JSON.stringify({ choices: [{ delta: { content: c } }] }))
  lines.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }))
  lines.push("[DONE]")
  return { ok: true, status: 200, body: sseBody(lines), text: async () => "", json: async () => ({}) }
}

function anthropicSseResponse(parts) {
  const lines = [{ type: "message_start" }]
  for (const p of parts) lines.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } })
  lines.push({ type: "message_stop" })
  return { ok: true, status: 200, body: sseBody(lines.map((l) => JSON.stringify(l))), text: async () => "", json: async () => ({}) }
}

const openaiConfig = { provider: "openai", apiKey: "sk-test", model: "gpt-4o" }
const anthropicConfig = { provider: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-4-6" }
const MESSAGES = [
  { role: "system", content: "You are precise." },
  { role: "user", content: "Analyze this source document." },
]

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe("streamChat — OpenAI wire", () => {
  it("accumulates streamed deltas into the full text", async () => {
    fetchMock.mockResolvedValueOnce(openAiSseResponse(["Hello ", "wiki", "!"]))
    const tokens = []
    const text = await streamChat(openaiConfig, MESSAGES, { onToken: (t) => tokens.push(t) })
    expect(text).toBe("Hello wiki!")
    expect(tokens).toEqual(["Hello ", "wiki", "!"])
  })

  it("passes temperature and max_tokens overrides in the request body", async () => {
    fetchMock.mockResolvedValueOnce(openAiSseResponse(["ok"]))
    await streamChat(openaiConfig, MESSAGES, { overrides: { temperature: 0.1, max_tokens: 4096 } })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/chat/completions")
    const body = JSON.parse(opts.body)
    expect(body.temperature).toBe(0.1)
    expect(body.max_tokens).toBe(4096)
    expect(body.model).toBe("gpt-4o")
    expect(opts.headers.Authorization).toBe("Bearer sk-test")
  })

  it("omits sampling keys when no overrides are given", async () => {
    fetchMock.mockResolvedValueOnce(openAiSseResponse(["ok"]))
    await streamChat(openaiConfig, MESSAGES)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).not.toHaveProperty("temperature")
    expect(body).not.toHaveProperty("max_tokens")
  })
})

describe("streamChat — Anthropic wire", () => {
  it("accumulates text_delta blocks and hoists the system prompt", async () => {
    fetchMock.mockResolvedValueOnce(anthropicSseResponse(["Front", "matter."]))
    const text = await streamChat(anthropicConfig, MESSAGES)
    expect(text).toBe("Frontmatter.")
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.anthropic.com/v1/messages")
    const body = JSON.parse(opts.body)
    expect(body.system).toBe("You are precise.")
    expect(body.max_tokens).toBe(8192) // default preserved
    expect(opts.headers["x-api-key"]).toBe("sk-ant")
    // system is not duplicated into messages
    expect(body.messages.every((m) => m.role !== "system")).toBe(true)
  })

  it("applies the max_tokens override", async () => {
    fetchMock.mockResolvedValueOnce(anthropicSseResponse(["ok"]))
    await streamChat(anthropicConfig, MESSAGES, { overrides: { max_tokens: 4096 } })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(4096)
  })
})

describe("streamChat — failure classification", () => {
  it("classifies a 429 response as a usage-limit error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, body: null, text: async () => '{"error":"rate limit exceeded"}' })
    await expect(streamChat(openaiConfig, MESSAGES)).rejects.toSatisfy((err) =>
      err instanceof IngestLlmError && err.usageLimit === true && /429|rate limit/i.test(err.message))
  })

  it("classifies usage-limit wording inside error messages", () => {
    expect(isUsageLimitError("HTTP 429: too many requests")).toBe(true)
    expect(isUsageLimitError("Usage limit reached for this billing period")).toBe(true)
    expect(isUsageLimitError("monthly quota exceeded")).toBe(true)
    expect(isUsageLimitError("Rate-Limit: slow down")).toBe(true)
    expect(isUsageLimitError("Internal server error")).toBe(false)
    expect(isUsageLimitError("")).toBe(false)
    expect(isUsageLimitError(null)).toBe(false)
  })

  it("exports the 15-minute desktop backoff", () => {
    expect(USAGE_LIMIT_BACKOFF_MS).toBe(15 * 60 * 1000)
  })

  it("surfaces the timeout backstop as a timeout error", async () => {
    fetchMock.mockImplementationOnce((_url, opts) =>
      Promise.resolve({ ok: true, status: 200, body: hangingBody(opts.signal), text: async () => "" }))
    await expect(streamChat(openaiConfig, MESSAGES, { timeoutMs: 30 }))
      .rejects.toSatisfy((err) => err instanceof IngestLlmError && err.timeout === true && /timed out/i.test(err.message))
  })

  it("propagates caller cancellation untouched", async () => {
    fetchMock.mockImplementationOnce((_url, opts) =>
      Promise.resolve({ ok: true, status: 200, body: hangingBody(opts.signal), text: async () => "" }))
    const controller = new AbortController()
    const p = streamChat(openaiConfig, MESSAGES, { signal: controller.signal, timeoutMs: 60_000 })
    controller.abort()
    await expect(p).rejects.toSatisfy((err) => err?.name === "AbortError")
  })

  it("rejects CLI-only providers fast (normalizeEndpoint guard)", async () => {
    await expect(streamChat({ provider: "claude-code", model: "x" }, MESSAGES))
      .rejects.toThrow(/desktop app/)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(streamChat({ provider: "codex-cli", model: "x" }, MESSAGES))
      .rejects.toThrow(/desktop app/)
  })
})
