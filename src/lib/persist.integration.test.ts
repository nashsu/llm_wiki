/**
 * Tier 4 — real-FS integration tests for persistence.
 *
 * Tests exercise saveReviewItems / loadReviewItems and saveChatHistory /
 * loadChatHistory against a REAL filesystem (temp dir per test). Mocks only
 * the Tauri invoke boundary — Node fs is the real deal. This catches bugs
 * that memory mocks can't: Unicode path handling, JSON escape round-trip,
 * directory auto-creation, legacy-format fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"
import type { ReviewItem } from "@/stores/review-store"
import type { Conversation, DisplayMessage } from "@/stores/chat-store"

vi.mock("@/commands/fs", () => realFs)

import {
  saveReviewItems,
  loadReviewItems,
  saveChatHistory,
  loadChatHistory,
} from "./persist"

let tmp: { path: string; cleanup: () => Promise<void> }

function makeReview(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r-1",
    projectId: "proj-1",
    projectPath: tmp?.path ?? "/persist-project",
    type: "missing-page",
    title: "Attention",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...overrides,
  }
}

beforeEach(async () => {
  tmp = await createTempProject("persist")
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("review persistence — round-trip", () => {
  it("save then load returns identical items", async () => {
    const items: ReviewItem[] = [
      makeReview({ id: "r-1", title: "Alpha" }),
      makeReview({ id: "r-2", title: "Beta", type: "duplicate" }),
    ]
    await saveReviewItems(tmp.path, items)
    const loaded = await loadReviewItems(tmp.path)
    expect(loaded).toEqual(items)
  })

  it("creates the .llm-wiki directory on first save", async () => {
    expect(await fileExists(`${tmp.path}/.llm-wiki`)).toBe(false)
    await saveReviewItems(tmp.path, [makeReview()])
    expect(await fileExists(`${tmp.path}/.llm-wiki/review.json`)).toBe(true)
  })

  it("returns empty array when the file is absent", async () => {
    const loaded = await loadReviewItems(tmp.path)
    expect(loaded).toEqual([])
  })

  it("returns empty array when the file is corrupted JSON", async () => {
    await writeFileRaw(`${tmp.path}/.llm-wiki/review.json`, "{not valid json")
    const loaded = await loadReviewItems(tmp.path)
    expect(loaded).toEqual([])
  })

  it("preserves Unicode titles through JSON round-trip", async () => {
    const items = [
      makeReview({ id: "r-zh", title: "注意力机制", description: "Transformer 核心" }),
      makeReview({ id: "r-ja", title: "これは日本語" }),
      makeReview({ id: "r-emoji", title: "Edge 🔥 case" }),
    ]
    await saveReviewItems(tmp.path, items)
    const loaded = await loadReviewItems(tmp.path)
    expect(loaded).toEqual(items)
    expect(loaded[0].title).toBe("注意力机制")
  })

  it("overwrites existing file on subsequent saves", async () => {
    await saveReviewItems(tmp.path, [makeReview({ id: "r-1", title: "Old" })])
    await saveReviewItems(tmp.path, [makeReview({ id: "r-2", title: "New" })])
    const loaded = await loadReviewItems(tmp.path)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].title).toBe("New")
  })

  it("normalizes Windows-style paths (backslashes) in projectPath", async () => {
    // projectPath may arrive with backslashes on Windows. Use a forward-slash
    // tmp path (already normalized) but also double up slashes to confirm
    // the helpers survive unusual input.
    const windowsy = tmp.path.replace(/\//g, "\\")
    await saveReviewItems(windowsy, [makeReview({ id: "r-1" })])
    const loaded = await loadReviewItems(windowsy)
    expect(loaded).toHaveLength(1)
  })

  it("deduplicates same-key review items before writing review.json", async () => {
    await saveReviewItems(tmp.path, [
      makeReview({ id: "older", projectId: "", createdAt: 1 }),
      makeReview({ id: "newer", projectId: "proj-1", createdAt: 2 }),
    ])

    const raw = await readFileRaw(`${tmp.path}/.llm-wiki/review.json`)
    const parsed = JSON.parse(raw) as ReviewItem[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe("newer")
  })

  it("does not auto-fill a missing projectId during save/load", async () => {
    await saveReviewItems(tmp.path, [
      makeReview({ id: "orphanish", projectId: "", projectPath: tmp.path }),
    ])

    const loaded = await loadReviewItems(tmp.path)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].projectId).toBe("")
    expect(loaded[0].projectPath).toBe(tmp.path)
  })
})

describe("chat persistence — round-trip (new format)", () => {
  function makeConv(id: string, title: string = "conv"): Conversation {
    return { id, title, createdAt: 0, updatedAt: 1 }
  }
  function makeMsg(id: string, convId: string, content: string): DisplayMessage {
    return { id, role: "user", content, timestamp: 0, conversationId: convId }
  }

  it("writes conversations.json + per-conversation chats/<id>.json", async () => {
    await saveChatHistory(
      tmp.path,
      [makeConv("c1"), makeConv("c2")],
      [
        makeMsg("m1", "c1", "hello"),
        makeMsg("m2", "c1", "world"),
        makeMsg("m3", "c2", "other"),
      ],
    )
    expect(await fileExists(`${tmp.path}/.llm-wiki/conversations.json`)).toBe(true)
    expect(await fileExists(`${tmp.path}/.llm-wiki/chats/c1.json`)).toBe(true)
    expect(await fileExists(`${tmp.path}/.llm-wiki/chats/c2.json`)).toBe(true)
  })

  it("round-trips conversations + messages", async () => {
    const convs = [makeConv("c1", "Conv 1"), makeConv("c2", "Conv 2")]
    const msgs = [
      makeMsg("m1", "c1", "hi"),
      makeMsg("m2", "c2", "你好"),
    ]
    await saveChatHistory(tmp.path, convs, msgs)
    const loaded = await loadChatHistory(tmp.path)

    expect(loaded.conversations).toEqual(convs)
    // Messages may be returned in a different order (grouped by conv file),
    // so compare as sets.
    expect(loaded.messages).toEqual(expect.arrayContaining(msgs))
    expect(loaded.messages).toHaveLength(2)
  })

  it("caps each conversation's persisted messages at 100 (oldest dropped)", async () => {
    const convs = [makeConv("c1")]
    const msgs = Array.from({ length: 150 }, (_, i) =>
      makeMsg(`m${i}`, "c1", `msg ${i}`),
    )
    await saveChatHistory(tmp.path, convs, msgs)
    const loaded = await loadChatHistory(tmp.path)
    expect(loaded.messages).toHaveLength(100)
    // Should have kept the LAST 100 (m50 .. m149)
    expect(loaded.messages[0].id).toBe("m50")
    expect(loaded.messages[99].id).toBe("m149")
  })

  it("returns empty data when no persistence file exists", async () => {
    const loaded = await loadChatHistory(tmp.path)
    expect(loaded).toEqual({ conversations: [], messages: [] })
  })

  it("skips missing per-conversation files without throwing", async () => {
    // conversations.json references c1 + c2, but chats/c2.json is missing
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/conversations.json`,
      JSON.stringify([makeConv("c1"), makeConv("c2")]),
    )
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/chats/c1.json`,
      JSON.stringify([makeMsg("m1", "c1", "hi")]),
    )
    const loaded = await loadChatHistory(tmp.path)
    expect(loaded.conversations).toHaveLength(2)
    expect(loaded.messages).toHaveLength(1)
  })

  it("preserves Unicode content through round-trip", async () => {
    const convs = [makeConv("c1", "中文对话 🎌")]
    const msgs = [
      makeMsg("m1", "c1", "你好，世界 🌍"),
      makeMsg("m2", "c1", "これはテスト"),
    ]
    await saveChatHistory(tmp.path, convs, msgs)
    const loaded = await loadChatHistory(tmp.path)
    expect(loaded.conversations[0].title).toBe("中文对话 🎌")
    expect(loaded.messages[0].content).toBe("你好，世界 🌍")
  })
})

describe("chat persistence — legacy format fallback", () => {
  function makeConv(id: string): Conversation {
    return { id, title: "t", createdAt: 0, updatedAt: 1 }
  }
  function makeMsg(id: string, convId: string): DisplayMessage {
    return { id, role: "user", content: "c", timestamp: 0, conversationId: convId }
  }

  it("falls back to chat-history.json flat-array format", async () => {
    // Very old format: flat array of messages
    const legacyMessages = [
      { id: "m1", role: "user", content: "old", timestamp: 100, conversationId: "ignored" },
      { id: "m2", role: "assistant", content: "older", timestamp: 200, conversationId: "ignored" },
    ]
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/chat-history.json`,
      JSON.stringify(legacyMessages),
    )

    const loaded = await loadChatHistory(tmp.path)
    expect(loaded.conversations).toHaveLength(1)
    expect(loaded.conversations[0].id).toBe("default")
    expect(loaded.messages).toHaveLength(2)
    expect(loaded.messages[0].conversationId).toBe("default")
  })

  it("falls back to chat-history.json combined-object format", async () => {
    const old = {
      conversations: [makeConv("c1")],
      messages: [makeMsg("m1", "c1")],
    }
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/chat-history.json`,
      JSON.stringify(old),
    )

    const loaded = await loadChatHistory(tmp.path)
    expect(loaded.conversations).toHaveLength(1)
    expect(loaded.messages).toHaveLength(1)
  })

  it("new format wins over legacy when both exist", async () => {
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/chat-history.json`,
      JSON.stringify({ conversations: [makeConv("legacy")], messages: [] }),
    )
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/conversations.json`,
      JSON.stringify([makeConv("new")]),
    )
    await writeFileRaw(`${tmp.path}/.llm-wiki/chats/new.json`, "[]")

    const loaded = await loadChatHistory(tmp.path)
    expect(loaded.conversations[0].id).toBe("new")
  })
})

// Keep readFileRaw exported (referenced for a future direct-inspection test)
void readFileRaw
