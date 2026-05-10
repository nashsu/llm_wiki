/**
 * Regression suite for Save-to-Wiki filename generation. The bug we're
 * fixing: the previous ASCII-only filename regex made every CJK-titled
 * conversation collapse to an empty stem. These tests pin the readable
 * Obsidian filename policy.
 */
import { describe, it, expect } from "vitest"
import { makeQuerySlug, makeQueryFileName } from "./wiki-filename"

describe("makeQuerySlug", () => {
  it("keeps ASCII titles readable with spaces", () => {
    expect(makeQuerySlug("Understanding RoPE in LLMs")).toBe("Understanding RoPE in LLMs")
  })

  it("strips unsafe punctuation but does not insert hyphens", () => {
    expect(makeQuerySlug("What is GPT-4's context window?")).toBe("What is GPT 4s context window")
  })

  it("keeps CJK characters intact (the core bug fix)", () => {
    // Previously these collapsed to "" → filename collisions.
    expect(makeQuerySlug("旋转位置编码")).toBe("旋转位置编码")
    expect(makeQuerySlug("日本茶道")).toBe("日本茶道")
  })

  it("handles mixed CJK + ASCII cleanly", () => {
    expect(makeQuerySlug("RoPE 旋转位置编码")).toBe("RoPE 旋转位置编码")
  })

  it("normalizes full-width digits / latin to half-width (NFKC)", () => {
    // Full-width "ＲｏＰＥ" and "２０２５" normalize to their ASCII
    // equivalents so the file tree looks consistent.
    expect(makeQuerySlug("ＲｏＰＥ ２０２５")).toBe("RoPE 2025")
  })

  it("keeps Japanese kana and kanji", () => {
    expect(makeQuerySlug("アテンション機構")).toBe("アテンション機構")
  })

  it("falls back to 'query' when title yields nothing usable", () => {
    // Emoji-only, punctuation-only, whitespace-only — all previously
    expect(makeQuerySlug("🎉🔥💯")).toBe("저장된 질의")
    expect(makeQuerySlug("!!! ??? ...")).toBe("저장된 질의")
    expect(makeQuerySlug("   ")).toBe("저장된 질의")
    expect(makeQuerySlug("")).toBe("저장된 질의")
  })

  it("treats unnecessary hyphens as spaces", () => {
    expect(makeQuerySlug("---foo   bar---")).toBe("foo bar")
    expect(makeQuerySlug("a - b - c")).toBe("a b c")
  })

  it("truncates long stems to 80 characters", () => {
    const long = "a".repeat(200)
    expect(makeQuerySlug(long)).toHaveLength(80)
  })

  it("preserves title casing for Obsidian display", () => {
    expect(makeQuerySlug("RoPE")).toBe("RoPE")
    expect(makeQuerySlug("ATTENTION")).toBe("ATTENTION")
  })
})

describe("makeQueryFileName", () => {
  // Fixed UTC clock for deterministic assertions.
  const NOW = new Date("2026-04-23T14:30:52.123Z")

  it("produces readable-title timestamp shape without hyphen separators", () => {
    const { fileName, slug, date, time } = makeQueryFileName("Attention Is All You Need", NOW)
    expect(slug).toBe("Attention Is All You Need")
    expect(date).toBe("2026-04-23")
    expect(time).toBe("143052")
    expect(fileName).toBe("Attention Is All You Need (20260423 143052).md")
  })

  it("two saves of the SAME title within the same day produce DIFFERENT filenames (the reported bug)", () => {
    const a = makeQueryFileName("旋转位置编码", new Date("2026-04-23T10:00:00.000Z"))
    const b = makeQueryFileName("旋转位置编码", new Date("2026-04-23T14:30:52.123Z"))
    const c = makeQueryFileName("旋转位置编码", new Date("2026-04-23T23:59:59.999Z"))
    // All three must be distinct — this is the whole point of the fix.
    expect(new Set([a.fileName, b.fileName, c.fileName]).size).toBe(3)
    // And all three must share the same readable stem (so users can
    // visually group them by topic in the file tree).
    expect(a.slug).toBe("旋转位置编码")
    expect(a.fileName.startsWith("旋转位置编码 (20260423 ")).toBe(true)
    expect(b.fileName.startsWith("旋转位置编码 (20260423 ")).toBe(true)
    expect(c.fileName.startsWith("旋转位置编码 (20260423 ")).toBe(true)
  })

  it("emoji-only title falls back to 'query' but still produces distinct filenames per save", () => {
    const a = makeQueryFileName("🎉🔥", new Date("2026-04-23T10:00:00Z"))
    const b = makeQueryFileName("🎉🔥", new Date("2026-04-23T10:00:01Z"))
    expect(a.fileName).toBe("저장된 질의 (20260423 100000).md")
    expect(b.fileName).toBe("저장된 질의 (20260423 100001).md")
    expect(a.fileName).not.toBe(b.fileName)
  })

  it("uses UTC so same timestamp from different timezones hashes identically", () => {
    // toISOString always reports UTC, so the filename is stable
    // across machines with different local clocks. A regression to
    // toTimeString / getHours would make this test fail on any
    // machine not in UTC.
    const { time } = makeQueryFileName("x", new Date("2026-04-23T14:30:52.000Z"))
    expect(time).toBe("143052")
  })
})
