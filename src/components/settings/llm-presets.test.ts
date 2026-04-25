import { describe, expect, it } from "vitest"
import type { LlmConfig, ProviderOverride } from "@/stores/wiki-store"
import { LLM_PRESETS, matchPreset } from "./llm-presets"
import { resolveConfig } from "./preset-resolver"

const fallback: LlmConfig = {
  provider: "openai",
  apiKey: "",
  model: "",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 204800,
}

describe("Alibaba Bailian Token Plan preset", () => {
  const preset = LLM_PRESETS.find((p) => p.id === "bailian-token")

  it("is registered with the Token Plan OpenAI-compatible defaults", () => {
    expect(preset).toMatchObject({
      label: "阿里百炼 Token Plan",
      provider: "custom",
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiMode: "chat_completions",
      defaultModel: "qwen3.6-plus",
    })
    expect(preset?.suggestedModels).toEqual([
      "qwen3.6-plus",
      "deepseek-v3.2",
      "glm-5",
      "MiniMax-M2.6",
    ])
  })

  it("resolves the Anthropic-compatible Token Plan endpoint when the mode is overridden", () => {
    expect(preset).toBeDefined()
    const override: ProviderOverride = {
      apiMode: "anthropic_messages",
    }

    const cfg = resolveConfig(preset!, override, fallback)

    expect(cfg.provider).toBe("custom")
    expect(cfg.apiMode).toBe("anthropic_messages")
    expect(cfg.customEndpoint).toBe(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    )
    expect(cfg.model).toBe("qwen3.6-plus")
  })

  it("matches either Token Plan wire endpoint back to the same preset", () => {
    expect(
      matchPreset({
        provider: "custom",
        customEndpoint: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        ollamaUrl: "",
        apiMode: "chat_completions",
      })?.id,
    ).toBe("bailian-token")

    expect(
      matchPreset({
        provider: "custom",
        customEndpoint: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
        ollamaUrl: "",
        apiMode: "anthropic_messages",
      })?.id,
    ).toBe("bailian-token")
  })
})
