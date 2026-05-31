import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig, LlmConfig } from "@/stores/wiki-store"
import {
  testEmbeddingConnection,
  testEmbeddingFunction,
  testLlmConnection,
  testLlmFunction,
} from "./connection-tests"
import { fetchEmbedding, getLastEmbeddingError } from "@/lib/embedding"
import { streamChat } from "@/lib/llm-client"

vi.mock("@/lib/embedding", () => ({
  fetchEmbedding: vi.fn(),
  getLastEmbeddingError: vi.fn(),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

const fetchEmbeddingMock = vi.mocked(fetchEmbedding)
const getLastEmbeddingErrorMock = vi.mocked(getLastEmbeddingError)
const streamChatMock = vi.mocked(streamChat)

const embeddingConfig: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://localhost:1234/v1/embeddings",
  apiKey: "",
  model: "text-embedding-test",
}

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "",
  model: "test-model",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "http://localhost:1234/v1",
  maxContextSize: 4096,
  apiMode: "chat_completions",
}

beforeEach(() => {
  vi.clearAllMocks()
  getLastEmbeddingErrorMock.mockReturnValue(null)
})

describe("provider connection tests", () => {
  it("reports embedding connection dimensions", async () => {
    fetchEmbeddingMock.mockResolvedValueOnce([0.1, 0.2, 0.3])

    const result = await testEmbeddingConnection(embeddingConfig)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("3 dimensions")
    expect(fetchEmbeddingMock).toHaveBeenCalledWith(expect.any(String), embeddingConfig, 0)
  })

  it("fails embedding functional test when dimensions are unstable", async () => {
    fetchEmbeddingMock
      .mockResolvedValueOnce([0.1, 0.2])
      .mockResolvedValueOnce([0.1, 0.2, 0.3])

    const result = await testEmbeddingFunction(embeddingConfig)

    expect(result.ok).toBe(false)
    expect(result.message).toContain("dimension changed")
  })

  it("passes LLM connection when any content is streamed", async () => {
    streamChatMock.mockImplementationOnce(async (_cfg, _messages, callbacks) => {
      callbacks.onToken("OK")
      callbacks.onDone()
    })

    const result = await testLlmConnection(llmConfig)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("Response: OK")
  })

  it("validates LLM functional output token", async () => {
    streamChatMock.mockImplementationOnce(async (_cfg, _messages, callbacks) => {
      callbacks.onToken("LLM_WIKI_TEST_OK")
      callbacks.onDone()
    })

    const result = await testLlmFunction(llmConfig)

    expect(result.ok).toBe(true)
    expect(streamChatMock).toHaveBeenCalledWith(
      llmConfig,
      expect.any(Array),
      expect.any(Object),
      undefined,
      { max_tokens: 32, reasoning: { mode: "off" } },
    )
  })
})
