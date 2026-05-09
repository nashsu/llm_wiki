import { describe, expect, it } from "vitest"
import { resolveDocumentLlmConfig } from "./document-llm"
import type { DocumentLlmConfig, LlmConfig } from "@/stores/wiki-store"

function mainConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    apiKey: "sk-main",
    model: "gpt-4.1",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://api.example.com/v1",
    maxContextSize: 128000,
    apiMode: undefined,
    reasoning: { mode: "medium" },
    ...overrides,
  }
}

function documentConfig(overrides: Partial<DocumentLlmConfig> = {}): DocumentLlmConfig {
  return {
    useMainLlm: true,
    provider: "custom",
    apiKey: "",
    model: "gpt-4.1-mini",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "http://localhost:1234/v1",
    maxContextSize: 64000,
    apiMode: "chat_completions",
    reasoning: { mode: "off" },
    ...overrides,
  }
}

describe("resolveDocumentLlmConfig", () => {
  it("returns the main config verbatim when useMainLlm is true", () => {
    const main = mainConfig()
    expect(resolveDocumentLlmConfig(main, documentConfig({ useMainLlm: true }))).toEqual(main)
  })

  it("returns the dedicated document-processing config when useMainLlm is false", () => {
    const resolved = resolveDocumentLlmConfig(
      mainConfig(),
      documentConfig({
        useMainLlm: false,
        provider: "anthropic",
        apiKey: "sk-doc",
        model: "claude-3-5-haiku",
        customEndpoint: "ignored",
        apiMode: "anthropic_messages",
        reasoning: { mode: "low" },
      }),
    )

    expect(resolved).toEqual({
      provider: "anthropic",
      apiKey: "sk-doc",
      model: "claude-3-5-haiku",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "ignored",
      maxContextSize: 64000,
      apiMode: undefined,
      reasoning: { mode: "low" },
    })
  })

  it("keeps custom apiMode only for custom providers", () => {
    const resolved = resolveDocumentLlmConfig(
      mainConfig(),
      documentConfig({
        useMainLlm: false,
        provider: "custom",
        apiMode: "anthropic_messages",
      }),
    )

    expect(resolved.apiMode).toBe("anthropic_messages")
  })
})
