/**
 * Unit coverage for `captionImage`. Mocks streamChat so we can
 * pin the wire shape (one user message, text+image content blocks,
 * exact prompt) without hitting the network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// `vi.mock` is hoisted to the top of the file before imports run.
// A plain `const mockStreamChat = vi.fn()` outside the factory
// would be in a TDZ when the factory executes — `vi.hoisted`
// hoists the declaration alongside the mock so the factory sees a
// real fn.
const { mockStreamChat } = vi.hoisted(() => ({ mockStreamChat: vi.fn() }))
vi.mock("./llm-client", async () => {
  const actual = await vi.importActual<typeof import("./llm-client")>("./llm-client")
  return {
    ...actual,
    streamChat: mockStreamChat,
  }
})

import { captionImage, CAPTION_PROMPT } from "./vision-caption"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage } from "./llm-providers"

const cfg: LlmConfig = {
  provider: "custom",
  apiKey: "",
  model: "vl-model",
  ollamaUrl: "",
  customEndpoint: "http://example/v1",
  apiMode: "chat_completions",
  maxContextSize: 8192,
}

const TINY_B64 = "iVBORw0KGgo="

beforeEach(() => {
  mockStreamChat.mockReset()
})

describe("captionImage", () => {
  it("sends one user message with text+image blocks and the pinned prompt", async () => {
    mockStreamChat.mockImplementation(
      async (
        _config: LlmConfig,
        _messages: ChatMessage[],
        callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void },
      ) => {
        callbacks.onToken("a red square")
        callbacks.onDone()
      },
    )

    const out = await captionImage(TINY_B64, "image/png", cfg)
    expect(out).toBe("a red square")

    expect(mockStreamChat).toHaveBeenCalledTimes(1)
    const messages = mockStreamChat.mock.calls[0][1] as ChatMessage[]
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")
    const blocks = messages[0].content as Array<{ type: string }>
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: "text", text: CAPTION_PROMPT })
    expect(blocks[1]).toEqual({
      type: "image",
      mediaType: "image/png",
      dataBase64: TINY_B64,
    })
  })

  it("joins multiple streamed tokens into one trimmed string", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken("  Red ")
      cb.onToken("square ")
      cb.onToken("on white  ")
      cb.onDone()
    })

    const out = await captionImage(TINY_B64, "image/png", cfg)
    // Trailing/leading whitespace removed; INNER spaces preserved.
    expect(out).toBe("Red square on white")
  })

  it("rethrows when streamChat reports an error (no silent empty caption)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onError(new Error("HTTP 500: model unavailable"))
    })

    await expect(captionImage(TINY_B64, "image/png", cfg)).rejects.toThrow(
      /HTTP 500: model unavailable/,
    )
  })

  it("passes through temperature and maxTokens overrides to streamChat", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onDone()
    })

    await captionImage(TINY_B64, "image/png", cfg, undefined, {
      temperature: 0.3,
      maxTokens: 256,
    })

    const overrides = mockStreamChat.mock.calls[0][4]
    expect(overrides).toEqual({
      temperature: 0.3,
      max_tokens: 256,
      reasoning: { mode: "off" },
    })
  })

  it("uses defaults (temp=0, max_tokens=4096) when no options passed", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onDone()
    })

    await captionImage(TINY_B64, "image/png", cfg)

    const overrides = mockStreamChat.mock.calls[0][4]
    expect(overrides).toEqual({
      temperature: 0,
      max_tokens: 4096,
      reasoning: { mode: "off" },
    })
  })

  it("forces reasoning off so main reasoning models produce captions instead of thinking-only streams", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken("caption")
      cb.onDone()
    })

    const reasoningCfg: LlmConfig = {
      ...cfg,
      reasoning: { mode: "high" },
    }
    await captionImage(TINY_B64, "image/png", reasoningCfg)

    expect(mockStreamChat.mock.calls[0][4]).toMatchObject({
      reasoning: { mode: "off" },
    })
  })

  it("rejects Codex CLI captioning because that transport omits image bytes", async () => {
    await expect(
      captionImage(TINY_B64, "image/png", {
        ...cfg,
        provider: "codex-cli",
      }),
    ).rejects.toThrow(/does not support image input/)
    expect(mockStreamChat).not.toHaveBeenCalled()
  })

  it("forwards the AbortSignal to streamChat (lets callers cancel batch captioning)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onDone()
    })

    const ctl = new AbortController()
    await captionImage(TINY_B64, "image/png", cfg, ctl.signal)

    const passedSignal = mockStreamChat.mock.calls[0][3]
    expect(passedSignal).toBe(ctl.signal)
  })

  it("CAPTION_PROMPT contains the verbatim factual-description directive (regression guard)", () => {
    // Plan-aligned wording — if these phrases drift, captions
    // start hallucinating again. Check the load-bearing fragments.
    expect(CAPTION_PROMPT).toMatch(/factually/)
    expect(CAPTION_PROMPT).toMatch(/visible text verbatim/)
    expect(CAPTION_PROMPT).toMatch(/Do NOT speculate/)
    expect(CAPTION_PROMPT).toMatch(/no markdown/)
  })

  it("uses the no-context prompt when context is empty / whitespace-only", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onDone()
    })

    // Empty / whitespace-only counts as "no context" — should NOT
    // upgrade to the longer context prompt with `(none)` blocks
    // (that would just waste tokens telling the model nothing).
    await captionImage(TINY_B64, "image/png", cfg, undefined, {
      contextBefore: "  \n  ",
      contextAfter: "",
    })
    const messages = mockStreamChat.mock.calls[0][1] as Array<{
      content: Array<{ type: string; text?: string }>
    }>
    const promptText = messages[0].content[0].text ?? ""
    expect(promptText).toBe(CAPTION_PROMPT)
  })

  it("switches to the context-aware prompt when EITHER side has content", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onDone()
    })

    await captionImage(TINY_B64, "image/png", cfg, undefined, {
      contextBefore: "Figure 3: Q2 revenue chart",
      contextAfter: "",
    })
    const messages = mockStreamChat.mock.calls[0][1] as Array<{
      content: Array<{ type: string; text?: string }>
    }>
    const promptText = messages[0].content[0].text ?? ""
    // Pinned framing sentences from the context-aware prompt:
    expect(promptText).toMatch(/Text before image/)
    expect(promptText).toMatch(/Text after image/)
    expect(promptText).toMatch(/MAY help describe the image/)
    expect(promptText).toMatch(/MAY ALSO be unrelated/)
    // The actual context bytes round-trip through the prompt.
    expect(promptText).toContain("Figure 3: Q2 revenue chart")
    // Empty side becomes `(none)` so the structure is uniform.
    expect(promptText).toMatch(/Text after image ---\s*\(none\)/)
  })
})
