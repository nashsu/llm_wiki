import { describe, expect, it } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  normalizeReasoningForProvider,
  parseGlmVersion,
  resolveReasoningCapabilities,
} from "./reasoning-capabilities"

function config(provider: LlmConfig["provider"], model: string): LlmConfig {
  return {
    provider,
    model,
    apiKey: "key",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://gateway.example/v1",
    maxContextSize: 128_000,
  }
}

describe("reasoning capabilities", () => {
  it("does not infer vendor-private controls from a custom gateway model name", () => {
    const cfg = config("custom", "Qwen3-thinking-only")
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto"])
    expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "auto" })
  })

  it("offers OpenRouter's documented reasoning controls only on its endpoint", () => {
    const cfg = {
      ...config("custom", "vendor/reasoning-model"),
      customEndpoint: "https://openrouter.ai/api/v1",
    }

    expect(resolveReasoningCapabilities(cfg).modes)
      .toEqual(["auto", "off", "low", "medium", "high", "max", "custom"])
    expect(normalizeReasoningForProvider(cfg, { mode: "low" })).toEqual({ mode: "low" })
  })

  it("does not offer off for thinking-required Gemini and Claude models", () => {
    expect(resolveReasoningCapabilities(config("google", "gemini-2.5-pro")).modes)
      .not.toContain("off")
    expect(resolveReasoningCapabilities(config("anthropic", "claude-opus-4-7")).modes)
      .not.toContain("off")
    expect(resolveReasoningCapabilities(config("anthropic", "claude-sonnet-4-6")).modes)
      .not.toContain("custom")
  })

  it("offers Zhipu GLM thinking controls by generation on the BigModel endpoint", () => {
    const glm = (model: string) => ({
      ...config("custom", model),
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
    })

    // Pre-4.5 models predate `thinking` entirely.
    expect(resolveReasoningCapabilities(glm("glm-4-flash-250414")).modes).toEqual(["auto"])
    expect(resolveReasoningCapabilities(glm("glm-z1-flash")).modes).toEqual(["auto"])
    // GLM-4.5 .. 5.1 only have the on/off toggle.
    expect(resolveReasoningCapabilities(glm("glm-4.7-flash")).modes).toEqual(["auto", "off"])
    expect(resolveReasoningCapabilities(glm("glm-5.1")).modes).toEqual(["auto", "off"])
    // GLM-5.2+ adds low/high/max; medium and custom budgets never exist.
    expect(resolveReasoningCapabilities(glm("glm-5.3-flash")).modes)
      .toEqual(["auto", "off", "low", "high", "max"])
    expect(normalizeReasoningForProvider(glm("glm-5.3-flash"), { mode: "medium" }))
      .toEqual({ mode: "auto" })
    expect(normalizeReasoningForProvider(glm("glm-4.7"), { mode: "high" }))
      .toEqual({ mode: "auto" })
    // The same model ids through a generic gateway stay auto-only.
    expect(resolveReasoningCapabilities(config("custom", "glm-5.3-flash")).modes).toEqual(["auto"])
  })

  it("parses GLM generations out of model ids", () => {
    expect(parseGlmVersion("glm-4.7-flash")).toEqual({ major: 4, minor: 7 })
    expect(parseGlmVersion("GLM-5.3-Flash")).toEqual({ major: 5, minor: 3 })
    expect(parseGlmVersion("glm-5v-turbo")).toEqual({ major: 5, minor: 0 })
    expect(parseGlmVersion("glm-4.5v")).toEqual({ major: 4, minor: 5 })
    expect(parseGlmVersion("zhipu/glm-4.6")).toEqual({ major: 4, minor: 6 })
    expect(parseGlmVersion("glm-z1-flash")).toBeNull()
    expect(parseGlmVersion("deepseek-v4-flash")).toBeNull()
  })

  it("limits OpenAI reasoning models to representable effort levels", () => {
    expect(resolveReasoningCapabilities(config("openai", "gpt-5.4")).modes)
      .toEqual(["auto", "low", "medium", "high"])
    expect(normalizeReasoningForProvider(config("openai", "gpt-5.4"), { mode: "max" }))
      .toEqual({ mode: "auto" })
  })

  it("normalizes custom budgets to positive integer values", () => {
    const cfg = config("anthropic", "claude-sonnet-4-5")
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 2048.9 }))
      .toEqual({ mode: "custom", budgetTokens: 2048 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 10 }))
      .toEqual({ mode: "custom", budgetTokens: 1024 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 99_999 }))
      .toEqual({ mode: "custom", budgetTokens: 32_768 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 0 }))
      .toEqual({ mode: "auto" })
  })
})
