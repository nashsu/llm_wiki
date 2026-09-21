import { describe, expect, it } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizeReasoningForProvider, resolveReasoningCapabilities } from "./reasoning-capabilities"

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
  it("stays auto-only until the user picks a stop-thinking method", () => {
    const cfg = config("custom", "Qwen3-thinking-only")
    // With no method configured we would send no field at all, so an `off`
    // control would be a promise the wire cannot keep. This is also exactly the
    // pre-existing behaviour, so untouched configs are unchanged.
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto"])
    expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "auto" })
  })

  it("offers off once a stop-thinking method is configured", () => {
    const cfg = {
      ...config("custom", "Qwen3-thinking-only"),
      reasoningDisable: "chat_template_kwargs" as const,
    }
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto", "off"])
    expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "off" })
    // Effort levels are still not inferred from a vendor-looking model name.
    expect(normalizeReasoningForProvider(cfg, { mode: "high" })).toEqual({ mode: "auto" })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 2048 }))
      .toEqual({ mode: "auto" })
  })

  it("re-derives the modes when the endpoint or model changes", () => {
    // The settings control must show what is actually in force after a switch,
    // not what the previous endpoint allowed.
    const generic = {
      ...config("custom", "qwen3"),
      customEndpoint: "https://gateway.example/v1",
      reasoningDisable: "chat_template_kwargs" as const,
    }
    expect(resolveReasoningCapabilities(generic).modes).toEqual(["auto", "off"])

    // A native endpoint keeps `off` but through its own mapping.
    const openrouter = { ...generic, customEndpoint: "https://openrouter.ai/api/v1" }
    expect(resolveReasoningCapabilities(openrouter).modes).toContain("off")

    // A DeepSeek model that cannot express the parameter loses `off` entirely...
    const nonV4 = { ...generic, customEndpoint: "https://api.deepseek.com/v1", model: "deepseek-chat" }
    expect(resolveReasoningCapabilities(nonV4).modes).toEqual(["auto"])

    // ...and a model that can gets the vendor levels back.
    const v4 = { ...nonV4, model: "deepseek-v4-flash" }
    expect(resolveReasoningCapabilities(v4).modes).toEqual(["auto", "off", "high", "max"])

    // Moving to the Anthropic wire drops it again: there it cannot be honoured.
    const anthropicWire = { ...generic, apiMode: "anthropic_messages" as const }
    expect(resolveReasoningCapabilities(anthropicWire).modes).toEqual(["auto"])
  })

  it("keeps Anthropic-wire custom gateways auto-only, where off is unrepresentable", () => {
    // The Anthropic builder emits byte-identical bodies for auto and off, so an
    // off control there would promise a guarantee the wire cannot make.
    const cfg = { ...config("custom", "any-model"), apiMode: "anthropic_messages" as const }
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto"])
  })

  it("decides the wire before the vendor domain", () => {
    // The app ships Anthropic-wire presets on vendor domains, so a Xiaomi or
    // Moonshot domain must not unlock a control that wire cannot honour.
    const xiaomiAnthropic = {
      ...config("custom", "mimo-v2.5"),
      customEndpoint: "https://token-plan-cn.xiaomimimo.com/anthropic",
      apiMode: "anthropic_messages" as const,
    }
    expect(resolveReasoningCapabilities(xiaomiAnthropic).modes).toEqual(["auto"])

    const moonshotAnthropic = {
      ...config("custom", "kimi-k2.6"),
      customEndpoint: "https://api.moonshot.cn/anthropic",
      apiMode: "anthropic_messages" as const,
    }
    expect(resolveReasoningCapabilities(moonshotAnthropic).modes).toEqual(["auto"])
  })

  it("offers only what a DeepSeek domain can express", () => {
    const nonV4 = {
      ...config("custom", "deepseek-chat"),
      customEndpoint: "https://api.deepseek.com/v1",
    }
    // Only V4 accepts the thinking parameter, so nothing else is representable.
    expect(resolveReasoningCapabilities(nonV4).modes).toEqual(["auto"])

    const v4 = {
      ...config("custom", "deepseek-v4-flash"),
      customEndpoint: "https://api.deepseek.com/v1",
    }
    expect(resolveReasoningCapabilities(v4).modes).toEqual(["auto", "off", "high", "max"])
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
