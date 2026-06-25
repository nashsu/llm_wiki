/**
 * Wire-format coverage for `getProviderConfig().buildBody` —
 * specifically the multimodal `ContentBlock[]` path added in Phase 2
 * of the multimodal-images plan. The expectation we encode here:
 *
 *   - Each provider's body produces the EXACT shape that wire
 *     accepts for vision input. Drift in any field name or nesting
 *     (e.g. OpenAI emitting `image: {url}` instead of
 *     `image_url: {url}`, or Anthropic emitting
 *     `mediaType` instead of `media_type`) breaks vision in prod
 *     silently — the wire returns 400 but only when an image is
 *     actually sent, which is rare in our test surface.
 *
 *   - String content keeps emitting bytes byte-identical to the
 *     pre-Phase-2 shape. This is non-negotiable: regressing the
 *     text wire would break every existing call site.
 */
import { describe, it, expect } from "vitest"
import {
  buildAnthropicUrl,
  getProviderConfig,
  supportsImageInput,
  type ChatMessage,
  type ContentBlock,
} from "./llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg=="

function mkConfig(over: Partial<LlmConfig>): LlmConfig {
  return {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 8192,
    ...over,
  }
}

function visionMessage(): ChatMessage {
  const blocks: ContentBlock[] = [
    { type: "text", text: "What's in this image?" },
    { type: "image", mediaType: "image/png", dataBase64: TINY_PNG_B64 },
  ]
  return { role: "user", content: blocks }
}

describe("OpenAI buildBody — vision content", () => {
  it("emits image_url block with data: URL framing", () => {
    const cfg = mkConfig({ provider: "openai" })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages).toHaveLength(1)
    const content = body.messages[0].content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: "text", text: "What's in this image?" })
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
    })
  })

  it("flattens single-text-block array back to a string (avoids accidentally regressing text-only callers)", () => {
    const cfg = mkConfig({ provider: "openai" })
    const msg: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    }
    const body = getProviderConfig(cfg).buildBody([msg]) as {
      messages: Array<{ content: unknown }>
    }
    expect(body.messages[0].content).toBe("hello world")
  })

  it("string content stays a string (byte-identical to pre-vision wire)", () => {
    const cfg = mkConfig({ provider: "openai" })
    const body = getProviderConfig(cfg).buildBody([
      { role: "user", content: "hi" },
    ]) as { messages: Array<{ content: unknown }> }
    expect(body.messages[0].content).toBe("hi")
  })
})

describe("Anthropic buildBody — vision content", () => {
  it("emits image block with media_type/data inside source", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-3-5-sonnet-latest" })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: "text", text: "What's in this image?" })
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
    })
  })

  it("flattens system content with images by dropping image blocks (anthropic doesn't accept system images)", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-3-5-sonnet-latest" })
    const sys: ChatMessage = {
      role: "system",
      content: [
        { type: "text", text: "be terse" },
        { type: "image", mediaType: "image/png", dataBase64: TINY_PNG_B64 },
      ],
    }
    const body = getProviderConfig(cfg).buildBody([
      sys,
      { role: "user", content: "ok" },
    ]) as { system?: unknown; messages: unknown[] }
    expect(body.system).toEqual([
      {
        type: "text",
        text: "be terse",
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  it("emits Anthropic system prompts as cacheable text blocks", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-3-5-sonnet-latest" })
    const body = getProviderConfig(cfg).buildBody([
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Prefer concise answers." },
      { role: "user", content: "Hi" },
    ]) as { system?: unknown; messages: unknown[] }

    expect(body.system).toEqual([
      {
        type: "text",
        text: "You are helpful.\nPrefer concise answers.",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }])
  })
})

describe("MiniMax Anthropic-compatible endpoint", () => {
  it("normalizes bare MiniMax global host to the Anthropic messages path", () => {
    expect(buildAnthropicUrl("https://api.minimax.io")).toBe(
      "https://api.minimax.io/anthropic/v1/messages",
    )
  })

  it("normalizes bare MiniMax China host to the Anthropic messages path", () => {
    expect(buildAnthropicUrl("https://api.minimaxi.com")).toBe(
      "https://api.minimaxi.com/anthropic/v1/messages",
    )
  })

  it("recovers from MiniMax URLs pasted as /v1/messages", () => {
    expect(buildAnthropicUrl("https://api.minimaxi.com/v1/messages")).toBe(
      "https://api.minimaxi.com/anthropic/v1/messages",
    )
  })

  it("keeps already-correct MiniMax Anthropic URLs intact", () => {
    expect(buildAnthropicUrl("https://api.minimaxi.com/anthropic/v1/messages")).toBe(
      "https://api.minimaxi.com/anthropic/v1/messages",
    )
  })

  it("uses Bearer auth for bare MiniMax endpoints after normalization", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "sk-minimax",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    }))

    expect(provider.url).toBe("https://api.minimaxi.com/anthropic/v1/messages")
    expect(provider.headers.Authorization).toBe("Bearer sk-minimax")
    expect(provider.headers["x-api-key"]).toBeUndefined()
  })

  it("allows official MiniMax-M3 Anthropic image input", () => {
    const body = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "sk-minimax",
      model: "MiniMax-M3",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    })).buildBody([visionMessage()]) as { messages: Array<{ content: unknown }> }

    const content = body.messages[0].content as Array<{ type: string }>
    expect(content[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
    })
  })

  it("fails early for official MiniMax M2.x Anthropic image input", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "sk-minimax",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    }))

    expect(() => provider.buildBody([visionMessage()])).toThrow(
      /MiniMax image input is supported only by MiniMax-M3/,
    )
  })

  it("fails early for native MiniMax M2.x image input", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "minimax",
      apiKey: "sk-minimax",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
    }))

    expect(() => provider.buildBody([visionMessage()])).toThrow(
      /MiniMax image input is supported only by MiniMax-M3/,
    )
  })

  it("allows native MiniMax-M3 image input", () => {
    const body = getProviderConfig(mkConfig({
      provider: "minimax",
      apiKey: "sk-minimax",
      model: "MiniMax-M3",
      customEndpoint: "https://api.minimaxi.com",
    })).buildBody([visionMessage()]) as { messages: Array<{ content: unknown }> }

    const content = body.messages[0].content as Array<{ type: string }>
    expect(content[1]).toMatchObject({ type: "image" })
  })

  it("still allows text-only MiniMax Anthropic requests", () => {
    const body = getProviderConfig(mkConfig({
      provider: "minimax",
      apiKey: "sk-minimax",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
    })).buildBody([{ role: "user", content: "hi" }]) as Record<string, unknown>

    expect(body.model).toBe("MiniMax-M2")
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("reports official MiniMax-M3 Anthropic endpoints as image-capable", () => {
    expect(supportsImageInput(mkConfig({
      provider: "custom",
      model: "MiniMax-M3",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    }))).toBe(true)
  })

  it("reports native MiniMax-M3 as image-capable and native MiniMax M2.x as not image-capable", () => {
    expect(supportsImageInput(mkConfig({
      provider: "minimax",
      model: "MiniMax-M3",
      customEndpoint: "https://api.minimaxi.com",
    }))).toBe(true)
    expect(supportsImageInput(mkConfig({
      provider: "minimax",
      model: "MiniMax-M3-Preview",
      customEndpoint: "https://api.minimaxi.com",
    }))).toBe(true)
    expect(supportsImageInput(mkConfig({
      provider: "minimax",
      model: "MiniMax-M2.7",
      customEndpoint: "https://api.minimaxi.com",
    }))).toBe(false)
  })

  it("reports Codex CLI as not image-capable because images are text-omitted", () => {
    expect(supportsImageInput(mkConfig({
      provider: "codex-cli",
      model: "gpt-5-codex",
    }))).toBe(false)
  })

  it("reports official MiniMax M2.x Anthropic endpoints as not image-capable", () => {
    expect(supportsImageInput(mkConfig({
      provider: "custom",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    }))).toBe(false)
  })

  it("does not block non-MiniMax custom Anthropic-compatible endpoints from image input", () => {
    expect(supportsImageInput(mkConfig({
      provider: "custom",
      model: "claude-compatible-vision",
      customEndpoint: "https://example.com/anthropic",
      apiMode: "anthropic_messages",
    }))).toBe(true)
  })
})

describe("Google buildBody — vision content", () => {
  it("emits parts with inline_data for images", () => {
    const cfg = mkConfig({ provider: "google", model: "gemini-2.5-pro" })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      contents: Array<{ role: string; parts: unknown[] }>
    }
    const parts = body.contents[0].parts as Array<Record<string, unknown>>
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ text: "What's in this image?" })
    expect(parts[1]).toEqual({
      inline_data: { mime_type: "image/png", data: TINY_PNG_B64 },
    })
  })
})

describe("Zhipu BigModel / GLM vision content", () => {
  it("uses OpenAI-compatible image_url blocks for GLM vision models", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "zhipu-key",
      model: "glm-4.5v",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      apiMode: "chat_completions",
    }))
    const body = provider.buildBody([visionMessage()]) as {
      messages: Array<{ content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string }>

    expect(provider.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions")
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
    })
  })

  it("reports BigModel GLM vision models as image-capable", () => {
    for (const model of ["glm-5v-turbo", "glm-4.6v", "glm-4.5v", "glm-4v-plus"]) {
      expect(supportsImageInput(mkConfig({
        provider: "custom",
        model,
        customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
        apiMode: "chat_completions",
      }))).toBe(true)
    }
  })

  it("reports BigModel text-only GLM models as not image-capable", () => {
    for (const model of ["glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5-flash"]) {
      expect(supportsImageInput(mkConfig({
        provider: "custom",
        model,
        customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
        apiMode: "chat_completions",
      }))).toBe(false)
    }
  })

  it("fails early when BigModel text-only GLM models receive image input", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "zhipu-key",
      model: "glm-4.6",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      apiMode: "chat_completions",
    }))

    expect(() => provider.buildBody([visionMessage()])).toThrow(
      /Zhipu BigModel image input is supported only by GLM vision models/,
    )
  })

  it("keeps the default permissive image capability for OpenAI and Claude Code providers", () => {
    expect(supportsImageInput(mkConfig({
      provider: "openai",
      model: "gpt-4o-mini",
    }))).toBe(true)
    expect(supportsImageInput(mkConfig({
      provider: "claude-code",
      model: "claude-sonnet-4-5-20250929",
    }))).toBe(true)
  })
})

describe("Azure OpenAI provider", () => {
  it("uses Azure deployment URL and api-key auth", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      apiKey: "azure-key",
      model: "my-gpt-4o-deployment",
      customEndpoint: "https://example-resource.openai.azure.com",
    }))

    expect(cfg.url).toBe(
      "https://example-resource.openai.azure.com/openai/deployments/my-gpt-4o-deployment/chat/completions?api-version=2024-10-21",
    )
    expect(cfg.headers["api-key"]).toBe("azure-key")
    expect(cfg.headers.Authorization).toBeUndefined()
  })

  it("omits model from the request body because the deployment is in the URL", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "deployment-a",
      customEndpoint: "https://example-resource.openai.azure.com",
    }))
    const body = cfg.buildBody([{ role: "user", content: "hi" }]) as Record<string, unknown>

    expect(body.model).toBeUndefined()
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("uses the configured Azure API version", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "deployment-a",
      customEndpoint: "https://example-resource.openai.azure.com",
      azureApiVersion: "2025-01-01-preview",
    }))

    expect(cfg.url).toContain("api-version=2025-01-01-preview")
  })

  it("maps max_tokens to max_completion_tokens for Azure GPT-5 deployments", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "gpt-5-nano",
      customEndpoint: "https://example-resource.openai.azure.com",
    }))
    const body = cfg.buildBody(
      [{ role: "user", content: "hi" }],
      { max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBe(4096)
  })

  it("omits unsupported non-default temperature for Azure GPT-5 deployments", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "gpt-5-nano",
      customEndpoint: "https://example-resource.openai.azure.com",
    }))
    const body = cfg.buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0.1 },
    ) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
  })

  it("uses explicit Azure model family when deployment name does not reveal GPT-5", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "production-chat-deployment",
      customEndpoint: "https://example-resource.openai.azure.com",
      azureModelFamily: "gpt5",
    }))
    const body = cfg.buildBody(
      [{ role: "user", content: "hi" }],
      { max_tokens: 1024, temperature: 0.1 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBe(1024)
    expect(body.temperature).toBeUndefined()
  })

  it("applies explicit Azure model family to custom Azure endpoints", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "custom",
      model: "wiki-main",
      customEndpoint: "https://example-resource.openai.azure.com",
      azureModelFamily: "gpt5",
    }))
    const body = cfg.buildBody(
      [{ role: "user", content: "hi" }],
      { max_tokens: 512, temperature: 0.1 },
    ) as Record<string, unknown>

    expect(body.model).toBeUndefined()
    expect(body.max_completion_tokens).toBe(512)
    expect(body.temperature).toBeUndefined()
  })
})

describe("Ollama / custom (chat_completions) — vision content", () => {
  it("ollama uses OpenAI-shaped image_url block (works on /v1/chat/completions for vision-capable models)", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen2.5vl",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string }>
    expect(content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
    })
  })

  it("custom endpoint in chat_completions mode emits the same image_url block", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "Qwen3.6-27B-Q4_K_M.gguf",
      customEndpoint: "http://192.168.1.50:8000/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
    })
  })
})

describe("reasoning controls", () => {
  it("does not send thinking to legacy DeepSeek chat models that reject the field", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-chat",
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.thinking).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })

  it("maps DeepSeek V4 reasoning off to thinking disabled for structured tasks", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-v4-flash",
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body.reasoning).toBeUndefined()
  })

  it("maps DeepSeek V4 high reasoning to thinking enabled plus reasoning_effort", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-v4-pro",
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "high" } },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("high")
  })

  it("does not send an undocumented DeepSeek max_reasoning_tokens field", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-v4-pro",
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "custom", budgetTokens: 2048 } },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.max_reasoning_tokens).toBeUndefined()
  })

  it("maps Xiaomi MiMo reasoning off to thinking disabled and max_completion_tokens", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "mimo-v2.5-pro",
      customEndpoint: "https://api.xiaomimimo.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0.1, max_tokens: 2048, reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBe(2048)
    expect(body.temperature).toBe(0.1)
  })

  it("omits custom temperature for Xiaomi MiMo thinking requests on Token Plan OpenAI wire", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "custom-router-model",
      customEndpoint: "https://token-plan-cn.xiaomimimo.com/v1",
      apiMode: "chat_completions",
    })
    const provider = getProviderConfig(cfg)
    const body = provider.buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0.1, max_tokens: 4096, reasoning: { mode: "auto" } },
    ) as Record<string, unknown>

    expect(provider.url).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions")
    expect(body.temperature).toBeUndefined()
    expect(body.max_completion_tokens).toBe(4096)
  })

  it("uses Bearer auth for Xiaomi MiMo Token Plan Anthropic wire", () => {
    const cfg = mkConfig({
      provider: "custom",
      apiKey: "sk-mimo",
      model: "mimo-v2.5-pro",
      customEndpoint: "https://token-plan-cn.xiaomimimo.com/anthropic",
      apiMode: "anthropic_messages",
    })
    const provider = getProviderConfig(cfg)

    expect(provider.url).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages")
    expect(provider.headers.Authorization).toBe("Bearer sk-mimo")
    expect(provider.headers["x-api-key"]).toBeUndefined()
    expect(provider.headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("uses Bearer auth for Kimi Coding Plan Anthropic wire", () => {
    const cfg = mkConfig({
      provider: "custom",
      apiKey: "sk-kimi-test",
      model: "kimi-for-coding",
      customEndpoint: "https://api.kimi.com/coding/",
      apiMode: "anthropic_messages",
    })
    const provider = getProviderConfig(cfg)

    expect(provider.url).toBe("https://api.kimi.com/coding/v1/messages")
    expect(provider.headers.Authorization).toBe("Bearer sk-kimi-test")
    expect(provider.headers["x-api-key"]).toBeUndefined()
    expect(provider.headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("uses Bearer auth for Moonshot Anthropic wire", () => {
    const cfg = mkConfig({
      provider: "custom",
      apiKey: "sk-moonshot",
      model: "kimi-k2.6",
      customEndpoint: "https://api.moonshot.ai/anthropic",
      apiMode: "anthropic_messages",
    })
    const provider = getProviderConfig(cfg)

    expect(provider.url).toBe("https://api.moonshot.ai/anthropic/v1/messages")
    expect(provider.headers.Authorization).toBe("Bearer sk-moonshot")
    expect(provider.headers["x-api-key"]).toBeUndefined()
    expect(provider.headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("uses cacheable system blocks for custom Anthropic-wire providers", () => {
    const cfg = mkConfig({
      provider: "custom",
      apiKey: "sk-custom",
      model: "custom-claude",
      customEndpoint: "https://example.com/anthropic",
      apiMode: "anthropic_messages",
    })
    const body = getProviderConfig(cfg).buildBody([
      { role: "system", content: "Project-wide instruction." },
      { role: "user", content: "Hi" },
    ]) as { system?: unknown; messages: unknown[] }

    expect(body.system).toEqual([
      {
        type: "text",
        text: "Project-wide instruction.",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }])
  })

  it("disables Qwen3 thinking on OpenAI-compatible local endpoints", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "Qwen3.5-122B",
      customEndpoint: "http://127.0.0.1:8000/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it("strips temperature for Kimi/Moonshot OpenAI-compatible endpoints", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "kimi-k2.6",
      customEndpoint: "https://api.moonshot.ai/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
    expect(body.max_tokens).toBe(4096)
  })

  it("maps Anthropic reasoning budget to extended thinking and removes sampling knobs", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "custom", budgetTokens: 2048 }, temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
    expect(body.temperature).toBeUndefined()
  })

  it("keeps cacheable system blocks when Anthropic extended thinking is enabled", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" })
    const body = getProviderConfig(cfg).buildBody(
      [
        { role: "system", content: "Persistent project context." },
        { role: "user", content: "hi" },
      ],
      { reasoning: { mode: "low" }, temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.system).toEqual([
      {
        type: "text",
        text: "Persistent project context.",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(body.temperature).toBeUndefined()
  })

  it("maps Gemini reasoning off to thinkingBudget 0", () => {
    const cfg = mkConfig({ provider: "google", model: "gemini-2.5-pro" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as { generationConfig?: Record<string, unknown> }

    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  it("maps Ollama reasoning off to reasoning_effort none (stops thinking-runaway empty content)", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "gemma3:12b",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" }, temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.reasoning_effort).toBe("none")
  })

  it("uses Ollama-native reasoning control instead of Qwen chat_template_kwargs", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen3:8b",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.reasoning_effort).toBe("none")
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it("maps Ollama low/medium/high reasoning straight through to reasoning_effort", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen3:8b",
      ollamaUrl: "http://localhost:11434",
    })
    for (const mode of ["low", "medium", "high"] as const) {
      const body = getProviderConfig(cfg).buildBody(
        [{ role: "user", content: "hi" }],
        { reasoning: { mode } },
      ) as Record<string, unknown>
      expect(body.reasoning_effort).toBe(mode)
    }
  })

  it("maps Ollama reasoning max to the strongest supported level high", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen3:8b",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "max" } },
    ) as Record<string, unknown>

    expect(body.reasoning_effort).toBe("high")
  })

  it("leaves Ollama reasoning_effort unset on auto so the model default applies", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "gemma3:12b",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "auto" } },
    ) as Record<string, unknown>

    expect(body.reasoning_effort).toBeUndefined()
  })
})
