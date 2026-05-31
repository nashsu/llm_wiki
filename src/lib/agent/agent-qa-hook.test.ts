import { describe, expect, it, vi, beforeEach } from "vitest"
import { shouldExtractQa, runQaHook } from "./agent-qa-hook"
import type { DisplayMessage } from "@/stores/chat-store"

// ── Helpers ──────────────────────────────────────────────────────────────────

function msg(role: "user" | "assistant", content: string): DisplayMessage {
  return { id: `${role}-${Math.random()}`, role, content, timestamp: Date.now(), conversationId: "conv-1" }
}

// ── shouldExtractQa ──────────────────────────────────────────────────────────

describe("shouldExtractQa", () => {
  it("returns false for empty messages", () => {
    expect(shouldExtractQa([]).extract).toBe(false)
  })

  it("returns false when only user messages", () => {
    expect(shouldExtractQa([msg("user", "hello")]).extract).toBe(false)
  })

  it("returns false for greeting-only conversations", () => {
    const messages = [msg("user", "hi"), msg("assistant", "Hello! How can I help?")]
    expect(shouldExtractQa(messages).extract).toBe(false)
  })

  it("returns false when last assistant message is too short", () => {
    const messages = [msg("user", "What is RAG?"), msg("assistant", "RAG is retrieval augmented generation.")]
    expect(shouldExtractQa(messages).extract).toBe(false)
  })

  it("returns true for substantive conversation", () => {
    const longAnswer = "RAG (Retrieval-Augmented Generation) is a technique that combines retrieval from a knowledge base with language model generation. It works by first retrieving relevant documents from a vector store, then feeding those documents as context to the LLM to generate more accurate and grounded responses. This approach reduces hallucination and allows the model to access up-to-date information beyond its training data."
    const messages = [msg("user", "Explain RAG in detail"), msg("assistant", longAnswer)]
    expect(shouldExtractQa(messages).extract).toBe(true)
  })
})

// ── runQaHook — mock setup ───────────────────────────────────────────────────

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
}))

const streamChatMock = vi.hoisted(() => vi.fn(async (
  _config: unknown,
  _messages: unknown[],
  handlers: { onToken: (t: string) => void; onDone: () => void; onError?: (e: unknown) => void },
) => {
  handlers.onToken("---\ntype: qa\ntitle: What is RAG?\ntags: [qa, ai]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: RAG is retrieval augmented generation.\n\n## Key Insights\n\n- Combines retrieval with generation\n- Reduces hallucination\n")
  handlers.onDone()
}))

const webSearchMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const val = fsMock.files.get(path)
    if (val === undefined) throw new Error(`missing: ${path}`)
    return val
  }),
  listDirectory: vi.fn(async () => {
    throw new Error("no qa dir")
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsMock.files.set(path, content)
  }),
  createDirectory: vi.fn(async () => {}),
}))

vi.mock("@/lib/frontmatter", () => ({
  parseFrontmatter: vi.fn((content: string) => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return { frontmatter: null, body: content, rawBlock: "" }
    const yaml = match[1]
    const body = match[2]
    const fm: Record<string, string | string[]> = {}
    for (const line of yaml.split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (m) {
        const key = m[1]
        let val: string | string[] = m[2].trim()
        if (val.startsWith("[") && val.endsWith("]")) {
          val = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
        } else {
          val = val.replace(/^"|"$/g, "")
        }
        fm[key] = val
      }
    }
    return { frontmatter: fm, body, rawBlock: match[0] }
  }),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
}))

vi.mock("@/lib/web-search", () => ({
  webSearch: webSearchMock,
}))

vi.mock("@/lib/output-language", () => ({
  buildLanguageDirective: vi.fn(() => "Respond in the same language as the input."),
}))

// ── runQaHook tests ──────────────────────────────────────────────────────────

describe("runQaHook", () => {
  beforeEach(() => {
    fsMock.files.clear()
    vi.clearAllMocks()
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onToken("---\ntype: qa\ntitle: What is RAG?\ntags: [qa, ai]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: RAG is retrieval augmented generation.\n\n## Key Insights\n\n- Combines retrieval with generation\n- Reduces hallucination\n")
      h.onDone()
    })
  })

  const longAnswer = "RAG (Retrieval-Augmented Generation) is a technique that combines retrieval from a knowledge base with language model generation. It works by first retrieving relevant documents from a vector store, then feeding those documents as context to the LLM to generate more accurate and grounded responses."

  it("skips greeting-only conversation", async () => {
    const messages = [msg("user", "hi"), msg("assistant", "Hello!")]
    const result = await runQaHook("/project", { model: "test" } as never, { provider: "none" } as never, messages)
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("greeting-only")
  })

  it("saves QA page for substantive conversation", async () => {
    const messages = [msg("user", "What is RAG?"), msg("assistant", longAnswer)]
    const result = await runQaHook("/project", { model: "test" } as never, { provider: "none" } as never, messages)
    expect(result.ok).toBe(true)
    expect(result.saved).toBe(true)
    expect(result.qaPath).toContain("wiki/qa/")
  })

  it("returns error when streamChat fails", async () => {
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onError?.(new Error("LLM error"))
    })
    const messages = [msg("user", "What is RAG?"), msg("assistant", longAnswer)]
    await expect(
      runQaHook("/project", { model: "test" } as never, { provider: "none" } as never, messages),
    ).rejects.toThrow("LLM error")
  })

  it("skips when LLM returns SKIP", async () => {
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onToken("SKIP")
      h.onDone()
    })
    const messages = [msg("user", "fix this bug"), msg("assistant", longAnswer)]
    const result = await runQaHook("/project", { model: "test" } as never, { provider: "none" } as never, messages)
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("llm-skipped")
  })

  it("returns error when LLM output lacks qa frontmatter", async () => {
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onToken("# Just a plain response\n\nNo frontmatter.")
      h.onDone()
    })
    const messages = [msg("user", "What is RAG?"), msg("assistant", longAnswer)]
    const result = await runQaHook("/project", { model: "test" } as never, { provider: "none" } as never, messages)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("frontmatter")
  })

  it("continues when external search fails", async () => {
    webSearchMock.mockRejectedValueOnce(new Error("EXA down"))
    const messages = [msg("user", "What is RAG?"), msg("assistant", longAnswer)]
    const result = await runQaHook("/project", { model: "test" } as never, { provider: "none" } as never, messages)
    expect(result.ok).toBe(true)
    expect(result.saved).toBe(true)
  })
})
