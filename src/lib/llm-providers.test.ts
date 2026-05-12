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
import { getProviderConfig, type ChatMessage, type ContentBlock } from "./llm-providers"
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
    ]) as { system?: string; messages: unknown[] }
    expect(body.system).toBe("be terse")
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

describe("Ollama / custom (chat_completions) — vision content", () => {
  it("ollama uses native /api/chat image fields", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen2.5vl",
      ollamaUrl: "http://localhost:11434",
      maxContextSize: 32768,
    })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ content: unknown; images?: string[] }>
      options: { num_ctx: number }
    }
    expect(body.messages[0].content).toBe("What's in this image?")
    expect(body.messages[0].images).toEqual([TINY_PNG_B64])
    expect(body.options.num_ctx).toBe(32768)
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
  it("maps DeepSeek-compatible custom endpoints to thinking disabled for structured tasks", () => {
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

    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body.reasoning).toBeUndefined()
  })

  it("maps DeepSeek high reasoning to thinking enabled plus reasoning_effort", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-reasoner",
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
      model: "deepseek-reasoner",
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

  it("maps Anthropic reasoning budget to extended thinking and removes sampling knobs", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "custom", budgetTokens: 2048 }, temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
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

  it("maps Gemini 3 reasoning off to thinkingLevel minimal", () => {
    const cfg = mkConfig({ provider: "google", model: "gemini-3-flash-preview" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as { generationConfig?: Record<string, unknown> }

    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "minimal" })
  })

  it("maps Gemini 3 medium reasoning to thinkingLevel medium", () => {
    const cfg = mkConfig({ provider: "google", model: "gemini-3-flash-preview" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "medium" } },
    ) as { generationConfig?: Record<string, unknown> }

    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "medium" })
  })
})
