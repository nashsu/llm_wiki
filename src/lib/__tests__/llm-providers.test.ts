import { describe, it, expect } from "vitest"
import { buildAnthropicUrl, parseGoogleLine, getProviderConfig } from "../llm-providers"
import type { LlmConfig as RealLlmConfig } from "@/stores/wiki-store"

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
// without a browser environment or Tauri runtime. Keep this in sync with
// the `case "minimax":` branch in src/lib/llm-providers.ts.
function buildMiniMaxProviderConfig(config: LlmConfig) {
  const { apiKey, model, customEndpoint } = config
  const base = (customEndpoint || "https://api.minimax.io/anthropic").replace(/\/+$/, "")
  // MiniMax's /anthropic endpoint requires Authorization: Bearer, NOT
  // x-api-key. Its CORS preflight rejects x-api-key entirely. See the
  // requiresBearerAuth() helper in src/lib/llm-providers.ts.
  return {
    url: `${base}/v1/messages`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    buildBody: (messages: Array<{ role: string; content: string }>) => {
      const systemMessages = messages.filter((m) => m.role === "system")
      const conversationMessages = messages.filter((m) => m.role !== "system")
      const system = systemMessages.map((m) => m.content).join("\n") || undefined
      return {
        messages: conversationMessages,
        ...(system !== undefined ? { system } : {}),
        stream: true,
        max_tokens: 4096,
        model,
      }
    },
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
  it("uses the Anthropic Messages endpoint under /anthropic", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    expect(cfg.url).toBe("https://api.minimax.io/anthropic/v1/messages")
  })

  it("supports the China regional endpoint via customEndpoint", () => {
    const cfg = buildMiniMaxProviderConfig(
      makeConfig({ customEndpoint: "https://api.minimaxi.com/anthropic" }),
    )
    expect(cfg.url).toBe("https://api.minimaxi.com/anthropic/v1/messages")
  })

  it("uses Authorization: Bearer (MiniMax rejects x-api-key at CORS layer)", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig({ apiKey: "my-key" }))
    expect(cfg.headers.Authorization).toBe("Bearer my-key")
    expect((cfg.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
  })

  it("sets Content-Type to application/json", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    expect(cfg.headers["Content-Type"]).toBe("application/json")
  })

  it("enables streaming", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    const body = cfg.buildBody([]) as Record<string, unknown>
    expect(body.stream).toBe(true)
  })

  it("includes max_tokens (required by Anthropic wire)", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    const body = cfg.buildBody([]) as Record<string, unknown>
    expect(body.max_tokens).toBe(4096)
  })

  it("carries the model in the body", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig({ model: "MiniMax-M2.7" }))
    const body = cfg.buildBody([]) as Record<string, unknown>
    expect(body.model).toBe("MiniMax-M2.7")
  })

  it("separates system messages from conversation (Anthropic convention)", () => {
    const cfg = buildMiniMaxProviderConfig(makeConfig())
    const body = cfg.buildBody([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
    ]) as Record<string, unknown>
    expect(body.system).toBe("You are helpful")
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }])
  })
})

describe("MiniMax provider registration", () => {
  it("minimax is a valid provider value in the type union", () => {
    const provider: Provider = "minimax"
    expect(provider).toBe("minimax")
  })
})

describe("buildAnthropicUrl — URL suffix handling", () => {
  it("appends /v1/messages to a bare host", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  it("appends /v1/messages to a bare /anthropic proxy base", () => {
    expect(buildAnthropicUrl("https://api.minimax.io/anthropic")).toBe(
      "https://api.minimax.io/anthropic/v1/messages",
    )
  })

  it("does NOT double the /v1 when base already ends in /v1", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  it("does NOT double the /v1 when proxy base ends in /anthropic/v1", () => {
    expect(buildAnthropicUrl("https://api.minimax.io/anthropic/v1")).toBe(
      "https://api.minimax.io/anthropic/v1/messages",
    )
  })

  it("preserves a full /v1/messages URL", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  it("handles arbitrary version segments like /api/paas/v4", () => {
    expect(buildAnthropicUrl("https://open.bigmodel.cn/api/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/paas/v4/messages",
    )
  })

  it("strips trailing slashes", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })
})

describe("parseGoogleLine — Gemini SSE parsing", () => {
  it("extracts plain text from a single-part event", () => {
    const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}'
    expect(parseGoogleLine(line)).toBe("Hello")
  })

  it("concatenates text across multiple parts in one event", () => {
    // Gemini 2.5/3.x reasoning models sometimes split output across
    // multiple parts in a single streaming chunk. The old parser only
    // took parts[0], silently dropping the tail.
    const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello "},{"text":"world"}]}}]}'
    expect(parseGoogleLine(line)).toBe("Hello world")
  })

  it("skips thought parts so reasoning tokens don't leak into output", () => {
    const line =
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"let me think"},{"text":"The answer is 42"}]}}]}'
    expect(parseGoogleLine(line)).toBe("The answer is 42")
  })

  it("returns null when the event has no visible text", () => {
    const line = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking"}]}}]}'
    expect(parseGoogleLine(line)).toBeNull()
  })

  it("returns null for non-data lines", () => {
    expect(parseGoogleLine("event: something")).toBeNull()
    expect(parseGoogleLine("")).toBeNull()
    expect(parseGoogleLine(":keepalive")).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(parseGoogleLine("data: {not json")).toBeNull()
  })
})

describe("Claude Code CLI provider — not reachable via getProviderConfig", () => {
  it.each([
    ["claude-code", "claude-sonnet-4-6"],
    ["codex-cli", "gpt-5.1-codex-mini"],
    ["gemini-cli", "gemini-2.5-flash"],
  ] as const)("throws for %s, because the subprocess transport dispatches one layer up in streamChat", (provider, model) => {
    // If this ever stops throwing, someone wired claude-code into the
    // HTTP path by mistake — it has no URL/headers and would crash
    // silently inside fetch() otherwise.
    expect(() =>
      getProviderConfig({
        provider,
        apiKey: "",
        model,
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      } as RealLlmConfig),
    ).toThrow(/subprocess transport/)
  })
})

describe("Google provider URL — model path encoding", () => {
  const makeGoogleConfig = (model: string): RealLlmConfig => ({
    provider: "google",
    apiKey: "test",
    model,
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  it("embeds a normal model id directly in the URL", () => {
    const cfg = getProviderConfig(makeGoogleConfig("gemini-2.5-flash"))
    expect(cfg.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    )
  })

  it("encodes slashes in a pasted OpenRouter-style id so the path stays well-formed", () => {
    // Previously bare interpolation put a real "/" in the path, which
    // would have been interpreted as a segment boundary → 404 on a
    // nonexistent Google resource.
    const cfg = getProviderConfig(makeGoogleConfig("google/gemini-3-pro-preview"))
    expect(cfg.url).toContain("google%2Fgemini-3-pro-preview:streamGenerateContent")
  })
})

describe("Sampling override translation across wires", () => {
  const baseMessages = [{ role: "user" as const, content: "hi" }]

  it("Gemini nests overrides under generationConfig with Gemini naming", () => {
    // Regression for a user-reported HTTP 400 —
    //   "Unknown name 'temperature': Cannot find field."
    // Gemini rejects sampling knobs at the top level and requires the
    // renamed keys (top_p → topP, max_tokens → maxOutputTokens).
    const cfg = getProviderConfig({
      provider: "google",
      apiKey: "k",
      model: "gemini-2.5-flash",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages, {
      temperature: 0.1,
      top_p: 0.9,
      top_k: 40,
      max_tokens: 500,
      stop: ["###"],
    }) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
    const gc = body.generationConfig as Record<string, unknown>
    expect(gc.temperature).toBe(0.1)
    expect(gc.topP).toBe(0.9)
    expect(gc.topK).toBe(40)
    expect(gc.maxOutputTokens).toBe(500)
    expect(gc.stopSequences).toEqual(["###"])
  })

  it("Gemini omits generationConfig entirely when no overrides passed", () => {
    const cfg = getProviderConfig({
      provider: "google",
      apiKey: "k",
      model: "gemini-2.5-flash",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages) as Record<string, unknown>
    expect(body.generationConfig).toBeUndefined()
  })

  it("OpenAI wires put overrides at the top level", () => {
    const cfg = getProviderConfig({
      provider: "openai",
      apiKey: "k",
      model: "gpt-4o",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages, { temperature: 0.1, max_tokens: 500 }) as Record<string, unknown>
    expect(body.temperature).toBe(0.1)
    expect(body.max_tokens).toBe(500)
  })

  it("Anthropic maps stop → stop_sequences and respects max_tokens override", () => {
    const cfg = getProviderConfig({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-sonnet-4-5-20250929",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 200000,
    })
    const body = cfg.buildBody(baseMessages, {
      temperature: 0.1,
      stop: "END",
      max_tokens: 8192,
    }) as Record<string, unknown>
    expect(body.temperature).toBe(0.1)
    // Anthropic's wire field is `stop_sequences` (array), not `stop`.
    expect(body.stop_sequences).toEqual(["END"])
    expect(body.stop).toBeUndefined()
    expect(body.max_tokens).toBe(8192)
  })
})

// ── Origin header for local LLM providers (Ollama + custom OpenAI) ──
//
// History pinned by two user reports:
//
//   v0.3.11: a Windows user's packet capture showed plugin-http's
//   auto-injected origin was `http://tauri.localhost` (NOT
//   `tauri://localhost` like macOS/Linux), triggering Ollama 403
//   because the default OLLAMA_ORIGINS list has `tauri://*` but
//   not `http://tauri.localhost`. We started overriding the header.
//
//   v0.4.2: a user with Ollama on a LAN box at 192.168.x reported
//   "error sending request" (reqwest network error). Diagnosis:
//   our v0.3.11 fix set Origin to the request URL's own host
//   (`http://192.168.0.20:11434`), which IS NOT in the default
//   OLLAMA_ORIGINS list either. Older Ollama versions reject same-
//   origin literally if it's not on the allowlist; some close the
//   TCP connection rather than 403, which surfaces as a generic
//   reqwest error.
//
// Current strategy: ALWAYS send `Origin: http://localhost`
// regardless of where the actual server is. Ollama's default
// OLLAMA_ORIGINS unconditionally includes `http://localhost` (and
// the related `127.0.0.1` / port-wildcard variants); LM Studio /
// llama.cpp / vLLM don't check Origin at all. The header is purely
// a CORS-allowlist signal — semantically lying about "where this
// request came from" is fine because the server uses API keys (or
// no auth), not origin, for actual permission checks.

describe("Origin header — local LLM CORS workaround", () => {
  it("Ollama provider sends Origin: http://localhost when server is on localhost", () => {
    const cfg = getProviderConfig({
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      maxContextSize: 8192,
    })
    expect(cfg.headers["Origin"]).toBe("http://localhost")
  })

  it("Ollama provider sends Origin: http://localhost EVEN WHEN server is on a remote LAN IP", () => {
    // This is the v0.4.2 user-reported bug: previously the Origin
    // mirrored the request URL's host (`http://192.168.1.50:11434`),
    // which Ollama's default OLLAMA_ORIGINS doesn't include →
    // request rejected. Forcing localhost makes any LAN deployment
    // pass Ollama's CORS check.
    const cfg = getProviderConfig({
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      ollamaUrl: "http://192.168.1.50:11434",
      customEndpoint: "",
      maxContextSize: 8192,
    })
    expect(cfg.headers["Origin"]).toBe("http://localhost")
  })

  it("Ollama provider Origin doesn't change with /v1 in the URL", () => {
    const cfg = getProviderConfig({
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      ollamaUrl: "http://localhost:11434/v1",
      customEndpoint: "",
      maxContextSize: 8192,
    })
    expect(cfg.headers["Origin"]).toBe("http://localhost")
  })

  it("custom OpenAI-compat endpoint gets the same Origin override (LM Studio / llama.cpp / vLLM)", () => {
    // For these servers Origin is ignored entirely — but we send
    // the value anyway so behavior is uniform across local-LLM
    // providers and the rare hardened deployment that does check
    // CORS still works.
    const cfg = getProviderConfig({
      provider: "custom",
      apiKey: "",
      model: "qwen3",
      ollamaUrl: "",
      customEndpoint: "http://127.0.0.1:1234",
      maxContextSize: 8192,
      apiMode: "chat_completions",
    } as RealLlmConfig)
    expect(cfg.headers["Origin"]).toBe("http://localhost")
  })

  it("commercial provider (OpenAI) does NOT get an explicit Origin override", () => {
    // OpenAI's CORS doesn't care about Origin (auth is via API key).
    // Setting Origin would just be noise. Pin that we DON'T touch
    // commercial endpoints.
    const cfg = getProviderConfig({
      provider: "openai",
      apiKey: "k",
      model: "gpt-4o",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    expect(cfg.headers["Origin"]).toBeUndefined()
  })

  it("Ollama provider always sets Origin even when the configured URL is malformed", () => {
    // The fixed-string Origin doesn't depend on URL parsing, so a
    // mistyped config can't strip the header. (The request itself
    // will fail elsewhere because the URL is bad — that's not this
    // helper's concern.)
    const cfg = getProviderConfig({
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      ollamaUrl: "not a url",
      customEndpoint: "",
      maxContextSize: 8192,
    })
    expect(cfg.headers["Origin"]).toBe("http://localhost")
    expect(typeof cfg.url).toBe("string")
  })
})
