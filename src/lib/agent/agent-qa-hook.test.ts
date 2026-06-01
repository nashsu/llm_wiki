import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  shouldExtractQa,
  markConversationDirty,
  flushQaForConversation,
  flushAllPendingQa,
  unmarkConversation,
  isConversationPending,
  getPendingQaIds,
} from "./agent-qa-hook"
import type { DisplayMessage } from "@/stores/chat-store"

// ── Helpers ──────────────────────────────────────────────────────────────────

function msg(role: "user" | "assistant", content: string, conversationId = "conv-1"): DisplayMessage {
  return { id: `${role}-${Math.random()}`, role, content, timestamp: Date.now(), conversationId }
}

const longAnswer = "RAG (Retrieval-Augmented Generation) is a technique that combines retrieval from a knowledge base with language model generation. It works by first retrieving relevant documents from a vector store, then feeding those documents as context to the LLM to generate more accurate and grounded responses."

// ── shouldExtractQa ──────────────────────────────────────────────────────────

describe("shouldExtractQa", () => {
  it("returns false for empty messages", () => {
    expect(shouldExtractQa([]).extract).toBe(false)
  })

  it("returns false when only user messages", () => {
    expect(shouldExtractQa([msg("user", "hello")]).extract).toBe(false)
  })

  it("returns false when only assistant messages", () => {
    expect(shouldExtractQa([msg("assistant", "Hello!")]).extract).toBe(false)
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
    const messages = [msg("user", "Explain RAG in detail"), msg("assistant", longAnswer)]
    expect(shouldExtractQa(messages).extract).toBe(true)
  })
})

// ── Dirty flag ───────────────────────────────────────────────────────────────

describe("dirty flag management", () => {
  beforeEach(() => {
    for (const id of getPendingQaIds()) {
      unmarkConversation(id)
    }
  })

  it("marks conversation dirty", () => {
    markConversationDirty("conv-1")
    expect(isConversationPending("conv-1")).toBe(true)
    expect(isConversationPending("conv-2")).toBe(false)
  })

  it("unmarks conversation", () => {
    markConversationDirty("conv-1")
    unmarkConversation("conv-1")
    expect(isConversationPending("conv-1")).toBe(false)
  })

  it("tracks multiple pending conversations", () => {
    markConversationDirty("conv-1")
    markConversationDirty("conv-2")
    expect(getPendingQaIds()).toEqual(expect.arrayContaining(["conv-1", "conv-2"]))
  })

  it("unmark on non-existent id is a no-op", () => {
    unmarkConversation("nonexistent")
    expect(isConversationPending("nonexistent")).toBe(false)
  })
})

// ── Mock setup ───────────────────────────────────────────────────────────────

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

const listDirectoryMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>(async () => {
  throw new Error("no qa dir")
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const val = fsMock.files.get(path)
    if (val === undefined) throw new Error(`missing: ${path}`)
    return val
  }),
  listDirectory: listDirectoryMock,
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

// ── flushQaForConversation tests ─────────────────────────────────────────────

describe("flushQaForConversation", () => {
  beforeEach(() => {
    fsMock.files.clear()
    vi.clearAllMocks()
    for (const id of getPendingQaIds()) {
      unmarkConversation(id)
    }
    listDirectoryMock.mockImplementation(async () => { throw new Error("no qa dir") })
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onToken("---\ntype: qa\ntitle: What is RAG?\ntags: [qa, ai]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: RAG is retrieval augmented generation.\n\n## Key Insights\n\n- Combines retrieval with generation\n- Reduces hallucination\n")
      h.onDone()
    })
  })

  it("skips if conversation is not pending", async () => {
    const messages = [msg("user", "What is RAG?"), msg("assistant", longAnswer)]
    const result = await flushQaForConversation("conv-1", messages, "/project", { model: "test" } as never, { provider: "none" } as never)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("not-pending")
  })

  it("extracts QA and removes from pending", async () => {
    markConversationDirty("conv-1")
    const messages = [msg("user", "What is RAG?"), msg("assistant", longAnswer)]
    const result = await flushQaForConversation("conv-1", messages, "/project", { model: "test" } as never, { provider: "none" } as never)
    expect(result.ok).toBe(true)
    expect(result.saved).toBe(true)
    expect(isConversationPending("conv-1")).toBe(false)
  })

  it("filters messages by conversationId", async () => {
    markConversationDirty("conv-1")
    const messages = [
      msg("user", "Hello", "conv-2"),
      msg("assistant", "Hi there!", "conv-2"),
      msg("user", "What is RAG?", "conv-1"),
      msg("assistant", longAnswer, "conv-1"),
    ]
    const result = await flushQaForConversation("conv-1", messages, "/project", { model: "test" } as never, { provider: "none" } as never)
    expect(result.ok).toBe(true)
    expect(result.saved).toBe(true)
  })

  it("skips when no messages for conversation", async () => {
    markConversationDirty("conv-empty")
    const result = await flushQaForConversation("conv-empty", [], "/project", { model: "test" } as never, { provider: "none" } as never)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("no-messages")
    expect(isConversationPending("conv-empty")).toBe(false)
  })

  it("removes from pending even on error", async () => {
    markConversationDirty("conv-err")
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onError?.(new Error("LLM error"))
    })
    const messages = [msg("user", "What is RAG?", "conv-err"), msg("assistant", longAnswer, "conv-err")]
    await expect(
      flushQaForConversation("conv-err", messages, "/project", { model: "test" } as never, { provider: "none" } as never),
    ).rejects.toThrow("LLM error")
    expect(isConversationPending("conv-err")).toBe(false)
  })

  it("skips when existing QA has matching title (dedup)", async () => {
    markConversationDirty("conv-dedup")
    listDirectoryMock.mockResolvedValueOnce([
      { name: "existing.md", path: "/project/wiki/qa/existing.md", is_dir: false },
    ])
    fsMock.files.set("/project/wiki/qa/existing.md",
      "---\ntype: qa\ntitle: What is RAG?\ntags: [qa]\n---\n\n# Q: What is RAG?\n\n## A: existing answer",
    )
    const messages = [msg("user", "What is RAG?", "conv-dedup"), msg("assistant", longAnswer, "conv-dedup")]
    const result = await flushQaForConversation("conv-dedup", messages, "/project", { model: "test" } as never, { provider: "none" } as never)
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("duplicate")
    expect(isConversationPending("conv-dedup")).toBe(false)
  })
})

// ── flushAllPendingQa ────────────────────────────────────────────────────────

describe("flushAllPendingQa", () => {
  beforeEach(() => {
    fsMock.files.clear()
    vi.clearAllMocks()
    for (const id of getPendingQaIds()) {
      unmarkConversation(id)
    }
    listDirectoryMock.mockImplementation(async () => { throw new Error("no qa dir") })
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onToken("---\ntype: qa\ntitle: What is RAG?\ntags: [qa]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: answer\n\n## Key Insights\n\n- Insight 1\n")
      h.onDone()
    })
  })

  it("flushes all pending conversations", async () => {
    markConversationDirty("conv-a")
    markConversationDirty("conv-b")
    const messages = [
      msg("user", "What is RAG?", "conv-a"),
      msg("assistant", longAnswer, "conv-a"),
      msg("user", "Explain transformers", "conv-b"),
      msg("assistant", longAnswer, "conv-b"),
    ]
    const results = await flushAllPendingQa(messages, "/project", { model: "test" } as never, { provider: "none" } as never)
    expect(results).toHaveLength(2)
    expect(getPendingQaIds()).toHaveLength(0)
  })

  it("handles mixed results: success + error + skip", async () => {
    markConversationDirty("conv-ok")
    markConversationDirty("conv-err")
    markConversationDirty("conv-skip")
    const messages = [
      msg("user", "What is RAG?", "conv-ok"),
      msg("assistant", longAnswer, "conv-ok"),
      msg("user", "hi", "conv-skip"),
      msg("assistant", "Hello!", "conv-skip"),
      msg("user", "What is RAG?", "conv-err"),
      msg("assistant", longAnswer, "conv-err"),
    ]
    let callCount = 0
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      callCount++
      if (callCount === 2) {
        h.onError?.(new Error("LLM error"))
        return
      }
      h.onToken("---\ntype: qa\ntitle: What is RAG?\ntags: [qa]\ncreated: 2026-05-31\n---\n\n# Q: What is RAG?\n\n## A: answer\n\n## Key Insights\n\n- Insight 1\n")
      h.onDone()
    })

    const results = await flushAllPendingQa(messages, "/project", { model: "test" } as never, { provider: "none" } as never)
    expect(results).toHaveLength(3)
    // All removed from pending despite mixed results (finally block)
    expect(getPendingQaIds()).toHaveLength(0)
  })
})
