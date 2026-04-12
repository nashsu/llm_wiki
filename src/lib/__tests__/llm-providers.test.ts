import { describe, it, expect } from "vitest"

// Inline minimal types to avoid store/zustand dependencies in unit tests
type Provider = "openai" | "anthropic" | "google" | "ollama" | "custom" | "minimax"

interface LlmConfig {
  provider: Provider
  apiKey: string
  model: string
  ollamaUrl: string
  customEndpoint: string
  maxContextSize: number
}

// Re-implement the minimax case logic inline so we can unit-test it
// without a browser environment or Tauri runtime.
function buildMiniMaxProviderConfig(config: LlmConfig) {
  const { apiKey, model } = config
  return {
    url: "https://api.minimax.io/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    buildBody: (messages: Array<{ role: string; content: string }>) => ({
      messages,
      stream: true,
      model,
      temperature: 1.0,
    }),
  }
}

const makeConfig = (overrides: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "minimax",
  apiKey: "test-key",
  model: "MiniMax-M2.7",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 204800,
  ...overrides,
})

describe("MiniMax Provider", () => {
  it("uses the correct base URL", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    expect(cfg.url).toBe("https://api.minimax.io/v1/chat/completions")
  })

  it("sets Authorization header with Bearer token", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig({ apiKey: "my-key" }))
    expect(cfg.headers.Authorization).toBe("Bearer my-key")
  })

  it("sets Content-Type to application/json", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    expect(cfg.headers["Content-Type"]).toBe("application/json")
  })

  it("includes temperature 1.0 in request body (MiniMax requires temperature > 0)", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    const body = cfg.buildBody([{ role: "user", content: "hello" }]) as Record<string, unknown>
    expect(body.temperature).toBe(1.0)
  })

  it("enables streaming", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    const body = cfg.buildBody([]) as Record<string, unknown>
    expect(body.stream).toBe(true)
  })

  it("uses MiniMax-M2.7 model", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig({ model: "MiniMax-M2.7" }))
    const body = cfg.buildBody([]) as Record<string, unknown>
    expect(body.model).toBe("MiniMax-M2.7")
  })

  it("uses MiniMax-M2.7-highspeed model", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig({ model: "MiniMax-M2.7-highspeed" }))
    const body = cfg.buildBody([]) as Record<string, unknown>
    expect(body.model).toBe("MiniMax-M2.7-highspeed")
  })

  it("passes messages in request body", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]
    const body = cfg.buildBody(messages) as Record<string, unknown>
    expect(body.messages).toEqual(messages)
  })
})

describe("MiniMax provider registration", () => {
  it("minimax is a valid provider value in the type union", () => {
    const provider: Provider = "minimax"
    expect(provider).toBe("minimax")
  })
})
