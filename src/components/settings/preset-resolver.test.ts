import { describe, expect, it } from "vitest"
import { LLM_PRESETS } from "./llm-presets"
import { disabledLlmConfig, resolveConfig } from "./preset-resolver"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import type { LlmConfig } from "@/stores/wiki-store"
import type { LlmPreset } from "./llm-presets"

function fallbackConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    apiKey: "sk-old",
    model: "gpt-4o",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://example.test/v1",
    maxContextSize: 8192,
    reasoning: { mode: "high" },
    ...overrides,
  }
}

describe("resolveConfig", () => {
  it("keeps DeepSeek presets aligned with the current V4 model list", () => {
    const deepseek = LLM_PRESETS.find((preset) => preset.id === "deepseek")

    expect(deepseek?.defaultModel).toBe("deepseek-v4-flash")
    expect(deepseek?.suggestedModels).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-chat",
      "deepseek-reasoner",
    ])
  })

  it("exposes Atlas Cloud as an OpenAI-compatible chat-completions preset", () => {
    const atlas = LLM_PRESETS.find((preset) => preset.id === "atlascloud")

    expect(atlas?.provider).toBe("custom")
    expect(atlas?.baseUrl).toBe("https://api.atlascloud.ai/v1")
    expect(atlas?.apiMode).toBe("chat_completions")
    expect(atlas?.defaultModel).toBe("deepseek-ai/deepseek-v4-pro")
    expect(atlas?.suggestedModels).toContain("deepseek-ai/deepseek-v4-pro")
  })

  it("keeps Xiaomi MiMo presets aligned with current official and Token Plan endpoints", () => {
    const mimo = LLM_PRESETS.find((preset) => preset.id === "xiaomi-mimo")

    expect(mimo?.defaultModel).toBe("mimo-v2.5-pro")
    expect(mimo?.suggestedContextSize).toBe(1000000)
    expect(mimo?.baseUrl).toBe("https://api.xiaomimimo.com/v1")
    expect(mimo?.baseUrlByMode).toEqual({
      chat_completions: "https://token-plan-cn.xiaomimimo.com/v1",
      anthropic_messages: "https://token-plan-cn.xiaomimimo.com/anthropic",
    })
    expect(mimo?.suggestedModels).toEqual([
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ])
  })

  it("defaults reasoning to auto instead of inheriting another preset's fallback", () => {
    const preset: LlmPreset = {
      id: "deepseek",
      label: "DeepSeek",
      provider: "custom",
      baseUrl: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
      apiMode: "chat_completions",
    }

    const resolved = resolveConfig(preset, undefined, fallbackConfig())

    expect(resolved.reasoning).toEqual({ mode: "auto" })
  })

  it("keeps an explicit provider-level reasoning override", () => {
    const preset: LlmPreset = {
      id: "qwen",
      label: "Qwen",
      provider: "custom",
      baseUrl: "http://localhost:8000/v1",
      defaultModel: "Qwen3.5-122B",
      apiMode: "chat_completions",
    }

    const resolved = resolveConfig(
      preset,
      { reasoning: { mode: "off" } },
      fallbackConfig(),
    )

    expect(resolved.reasoning).toEqual({ mode: "off" })
  })

  it("carries Azure API version and model family overrides", () => {
    const preset: LlmPreset = {
      id: "azure",
      label: "Azure OpenAI",
      provider: "azure",
      baseUrl: "https://resource.openai.azure.com",
      defaultModel: "wiki-main",
      azureApiVersion: "2024-10-21",
    }

    const resolved = resolveConfig(
      preset,
      { azureApiVersion: "2025-01-01-preview", azureModelFamily: "gpt5" },
      fallbackConfig(),
    )

    expect(resolved.azureApiVersion).toBe("2025-01-01-preview")
    expect(resolved.azureModelFamily).toBe("gpt5")
  })

  it("carries local CLI isolation for Claude Code and Codex CLI presets", () => {
    const preset: LlmPreset = {
      id: "codex-cli",
      label: "Codex CLI",
      provider: "codex-cli",
      defaultModel: "gpt-5",
    }

    const resolved = resolveConfig(
      preset,
      { localCliIsolation: true },
      fallbackConfig(),
    )

    expect(resolved.localCliIsolation).toBe(true)
  })

  it("carries Codex CLI timeout only for the Codex CLI preset", () => {
    const codexPreset: LlmPreset = {
      id: "codex-cli",
      label: "Codex CLI",
      provider: "codex-cli",
      defaultModel: "gpt-5",
    }
    const claudePreset: LlmPreset = {
      id: "claude-code-cli",
      label: "Claude Code CLI",
      provider: "claude-code",
      defaultModel: "sonnet",
    }

    expect(resolveConfig(
      codexPreset,
      { codexCliTimeoutMinutes: 9999 },
      fallbackConfig(),
    ).codexCliTimeoutMinutes).toBe(240)
    expect(resolveConfig(
      claudePreset,
      { codexCliTimeoutMinutes: 45 },
      fallbackConfig(),
    ).codexCliTimeoutMinutes).toBeUndefined()
  })

  it("does not apply local CLI isolation to hosted providers", () => {
    const preset: LlmPreset = {
      id: "openai",
      label: "OpenAI",
      provider: "openai",
      defaultModel: "gpt-5",
    }

    const resolved = resolveConfig(
      preset,
      { localCliIsolation: true },
      fallbackConfig({ localCliIsolation: true }),
    )

    expect(resolved.localCliIsolation).toBe(false)
  })
})

describe("disabledLlmConfig", () => {
  it("turns a keyless previous provider into an unusable LLM config", () => {
    const cleared = disabledLlmConfig(fallbackConfig({
      provider: "claude-code",
      apiKey: "",
      model: "sonnet",
    }))

    expect(cleared.provider).toBe("openai")
    expect(cleared.apiKey).toBe("")
    expect(hasUsableLlm(cleared)).toBe(false)
  })

  it("does not erase provider-specific saved details from the fallback object shape", () => {
    const cleared = disabledLlmConfig(fallbackConfig({
      provider: "codex-cli",
      model: "gpt-5",
      maxContextSize: 123456,
      customEndpoint: "http://local.test/v1",
    }))

    expect(cleared.model).toBe("gpt-5")
    expect(cleared.maxContextSize).toBe(123456)
    expect(cleared.customEndpoint).toBe("http://local.test/v1")
    expect(cleared.provider).toBe("openai")
    expect(hasUsableLlm(cleared)).toBe(false)
  })
})
