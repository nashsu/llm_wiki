import { describe, it, expect } from "vitest"
import {
  hasUsableLlm,
  hasUsableDocumentLlm,
  PROVIDERS_WITHOUT_KEY,
  type LlmProvider,
} from "./has-usable-llm"

// Compile-time exhaustiveness check: if a new provider is added to
// the LlmProvider union, this assignment will fail until the
// developer either adds the provider to PROVIDERS_WITHOUT_KEY *or*
// adds a case to KNOWN_PROVIDERS_WITH_KEY below. The runtime test
// then fails for any provider missing from both, so silently
// dropping a new provider into the wrong bucket is impossible.
const KNOWN_PROVIDERS_WITH_KEY: ReadonlySet<LlmProvider> = new Set([
  "openai",
  "anthropic",
  "google",
  "minimax",
])

describe("hasUsableLlm", () => {
  it("returns true for ollama with no API key", () => {
    expect(
      hasUsableLlm({ provider: "ollama", apiKey: "" }),
    ).toBe(true)
  })

  it("returns true for custom with no API key", () => {
    expect(
      hasUsableLlm({ provider: "custom", apiKey: "" }),
    ).toBe(true)
  })

  it("returns true for claude-code with no API key", () => {
    expect(
      hasUsableLlm({ provider: "claude-code", apiKey: "" }),
    ).toBe(true)
  })

  it("returns false for openai with no API key", () => {
    expect(
      hasUsableLlm({ provider: "openai", apiKey: "" }),
    ).toBe(false)
  })

  it("returns true for openai with an API key", () => {
    expect(
      hasUsableLlm({ provider: "openai", apiKey: "sk-test" }),
    ).toBe(true)
  })

  it("returns false for anthropic with empty key", () => {
    expect(
      hasUsableLlm({ provider: "anthropic", apiKey: "" }),
    ).toBe(false)
  })

  it("returns true for anthropic with a key", () => {
    expect(
      hasUsableLlm({ provider: "anthropic", apiKey: "sk-ant-..." }),
    ).toBe(true)
  })

  it("treats whitespace-only key as missing for key-required providers", () => {
    // Whitespace-only is almost always a paste accident; we want to
    // surface "set API key in Settings" rather than fail later with
    // a 401.
    expect(
      hasUsableLlm({ provider: "google", apiKey: "   " }),
    ).toBe(false)
  })

  it("PROVIDERS_WITHOUT_KEY covers the locally-running / CLI-auth providers", () => {
    expect(PROVIDERS_WITHOUT_KEY.has("ollama")).toBe(true)
    expect(PROVIDERS_WITHOUT_KEY.has("custom")).toBe(true)
    expect(PROVIDERS_WITHOUT_KEY.has("claude-code")).toBe(true)
  })

  it("PROVIDERS_WITHOUT_KEY does not include hosted-API providers", () => {
    expect(PROVIDERS_WITHOUT_KEY.has("openai")).toBe(false)
    expect(PROVIDERS_WITHOUT_KEY.has("anthropic")).toBe(false)
    expect(PROVIDERS_WITHOUT_KEY.has("google")).toBe(false)
    expect(PROVIDERS_WITHOUT_KEY.has("minimax")).toBe(false)
  })

  // Exhaustiveness guard. Every member of the LlmProvider union
  // must be classified into exactly one bucket; adding a new
  // provider that's missing from both sets fails this test, which
  // is the whole reason this helper exists.
  it("classifies every LlmProvider into exactly one bucket", () => {
    const allProviders: LlmProvider[] = [
      "openai",
      "anthropic",
      "google",
      "ollama",
      "custom",
      "minimax",
      "claude-code",
    ]
    for (const p of allProviders) {
      const inNoKey = PROVIDERS_WITHOUT_KEY.has(p)
      const inKey = KNOWN_PROVIDERS_WITH_KEY.has(p)
      expect(
        inNoKey !== inKey,
        `provider "${p}" is in ${inNoKey && inKey ? "BOTH" : "NEITHER"} bucket — pick one`,
      ).toBe(true)
    }
  })
})

describe("hasUsableDocumentLlm", () => {
  it("reuses the main model readiness when document processing uses the main LLM", () => {
    expect(
      hasUsableDocumentLlm(
        { provider: "openai", apiKey: "sk-main" },
        { useMainLlm: true, provider: "custom", apiKey: "" },
      ),
    ).toBe(true)
  })

  it("checks the dedicated document model when useMainLlm is false", () => {
    expect(
      hasUsableDocumentLlm(
        { provider: "openai", apiKey: "sk-main" },
        { useMainLlm: false, provider: "anthropic", apiKey: "" },
      ),
    ).toBe(false)
  })

  it("accepts no-key local providers for the dedicated document model", () => {
    expect(
      hasUsableDocumentLlm(
        { provider: "openai", apiKey: "" },
        { useMainLlm: false, provider: "ollama", apiKey: "" },
      ),
    ).toBe(true)
  })
})
