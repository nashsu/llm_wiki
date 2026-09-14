import { beforeEach, describe, expect, it, vi } from "vitest"

const { streamChatMock } = vi.hoisted(() => ({ streamChatMock: vi.fn() }))
vi.mock("@/lib/llm-client", () => ({ streamChat: streamChatMock }))

import { streamIngestChat } from "./ingest-llm-stream"
import type { LlmConfig } from "@/stores/wiki-store"

type Callbacks = {
  onToken: (token: string) => void
  onDone: () => void
  onError: (err: Error) => void
}
type Step = { error?: Error; content?: string }
type Overrides = { reasoning?: { mode: string } }

const REASONING_ONLY = new Error(
  "Model produced 12,345 characters of reasoning / chain-of-thought, but no actual response content. " +
  "This usually means the endpoint hit a thinking-token limit.",
)

const config = {
  provider: "custom",
  apiKey: "k",
  model: "glm-5.3-flash",
  customEndpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
  ollamaUrl: "",
  maxContextSize: 128_000,
} as unknown as LlmConfig

// Each test scripts the endpoint replies in order; the mock records the
// overrides it was called with so the fallback's reasoning mode is visible.
let steps: Step[] = []
let seen: Overrides[] = []

describe("streamIngestChat thinking fallback", () => {
  beforeEach(() => {
    steps = []
    seen = []
    streamChatMock.mockReset()
    streamChatMock.mockImplementation(async (...args: unknown[]) => {
      const cb = args[2] as Callbacks
      seen.push(args[4] as Overrides)
      const step = steps.shift() ?? {}
      if (step.error) {
        cb.onError(step.error)
        return
      }
      cb.onToken(step.content ?? "")
      cb.onDone()
    })
  })

  it("retries once with thinking off when the endpoint returns reasoning only", async () => {
    steps = [{ error: REASONING_ONLY }, { content: "## Key Entities" }]
    let out = ""
    const onError = vi.fn()

    await streamIngestChat(
      config,
      [{ role: "user", content: "hi" }],
      { onToken: (t) => { out += t }, onDone: () => {}, onError },
      undefined,
      { temperature: 0.1, reasoning: { mode: "auto" }, max_tokens: 100 },
    )

    expect(seen).toHaveLength(2)
    expect(seen[1]?.reasoning).toEqual({ mode: "off" })
    expect(out).toBe("## Key Entities")
    expect(onError).not.toHaveBeenCalled()
  })

  it("reports the error when the fallback also fails", async () => {
    steps = [{ error: REASONING_ONLY }, { error: REASONING_ONLY }]
    const onError = vi.fn()

    await streamIngestChat(
      config,
      [{ role: "user", content: "hi" }],
      { onToken: () => {}, onDone: () => {}, onError },
      undefined,
      { reasoning: { mode: "auto" } },
    )

    expect(seen).toHaveLength(2)
    expect(onError).toHaveBeenCalledWith(REASONING_ONLY)
  })

  it("does not retry other errors", async () => {
    const network = new Error("Network error reaching endpoint")
    steps = [{ error: network }]
    const onError = vi.fn()

    await streamIngestChat(config, [], { onToken: () => {}, onDone: () => {}, onError }, undefined, {})

    expect(seen).toHaveLength(1)
    expect(onError).toHaveBeenCalledWith(network)
  })

  it("does not retry when the call already ran with thinking off", async () => {
    steps = [{ error: REASONING_ONLY }]
    const onError = vi.fn()

    await streamIngestChat(
      config,
      [],
      { onToken: () => {}, onDone: () => {}, onError },
      undefined,
      { reasoning: { mode: "off" } },
    )

    expect(seen).toHaveLength(1)
    expect(onError).toHaveBeenCalledWith(REASONING_ONLY)
  })
})
