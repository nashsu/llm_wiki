/**
 * Regression suite for Save-to-Wiki filename generation. The bug we're
 * fixing: the previous ASCII-only slug regex made every CJK-titled
 * conversation collapse to an empty slug, colliding all same-day saves
 * into a single `-YYYY-MM-DD.md`. These tests pin the new policy.
 */
import { describe, it, expect } from "vitest"
import { makeQuerySlug, makeQueryFileName, deriveTitleFromQuestion } from "./wiki-filename"

describe("deriveTitleFromQuestion", () => {
  it("returns short questions unchanged (minus heading markers)", () => {
    expect(deriveTitleFromQuestion("## InitSyncRange 是做什么的？")).toBe("InitSyncRange 是做什么的？")
  })

  it("collapses newlines and whitespace", () => {
    expect(deriveTitleFromQuestion("第一行\n\n第二行")).toBe("第一行 第二行")
  })

  it("returns empty string for null/undefined/blank", () => {
    expect(deriveTitleFromQuestion(undefined)).toBe("")
    expect(deriveTitleFromQuestion(null)).toBe("")
    expect(deriveTitleFromQuestion("   ")).toBe("")
  })

  it("strips image markdown so an image-only question yields no title", () => {
    expect(deriveTitleFromQuestion("![screenshot](data:image/png;base64,AAAABBBBCCCC)")).toBe("")
  })

  it("keeps the text but drops the image when a question mixes both", () => {
    const q = "这张图里的报错是什么意思？ ![err](data:image/png;base64,ZZZZ)"
    expect(deriveTitleFromQuestion(q)).toBe("这张图里的报错是什么意思？")
  })

  it("summarizes an over-long question at a clause boundary with an ellipsis", () => {
    const long =
      "请帮我详细分析一下这个分布式同步系统的整体架构设计，包括它的数据一致性保证机制、节点之间的容错策略以及高并发场景下的整体性能优化方案。"
    const title = deriveTitleFromQuestion(long)
    expect(title.endsWith("…")).toBe(true)
    // Must be a clean cut, not a mid-word hard slice with trailing punctuation.
    expect(title).not.toMatch(/[，。、；]…$/)
    expect(Array.from(title).length).toBeLessThanOrEqual(61) // 60 budget + ellipsis
  })

  it("falls back to a hard cut when there is no boundary in the budget", () => {
    const long = "a".repeat(120)
    const title = deriveTitleFromQuestion(long)
    expect(title.endsWith("…")).toBe(true)
    expect(Array.from(title).length).toBe(61)
  })
})

describe("makeQuerySlug", () => {
  it("ASCII title is lowercased and hyphenated", () => {
    expect(makeQuerySlug("Understanding RoPE in LLMs")).toBe("understanding-rope-in-llms")
  })

  it("strips ASCII punctuation but keeps letters and digits", () => {
    expect(makeQuerySlug("What is GPT-4's context window?")).toBe("what-is-gpt-4s-context-window")
  })

  it("keeps CJK characters intact (the core bug fix)", () => {
    // Previously these collapsed to "" → filename collisions.
    expect(makeQuerySlug("旋转位置编码")).toBe("旋转位置编码")
    expect(makeQuerySlug("日本茶道")).toBe("日本茶道")
    expect(makeQuerySlug("政策版本差异提示")).toBe("政策版本差异提示")
  })

  it("handles mixed CJK + ASCII cleanly", () => {
    expect(makeQuerySlug("RoPE 旋转位置编码")).toBe("rope-旋转位置编码")
  })

  it("normalizes full-width digits / latin to half-width (NFKC)", () => {
    // Full-width "ＲｏＰＥ" and "２０２５" normalize to their ASCII
    // equivalents so the file tree looks consistent.
    expect(makeQuerySlug("ＲｏＰＥ ２０２５")).toBe("rope-2025")
  })

  it("keeps Japanese kana and kanji", () => {
    expect(makeQuerySlug("アテンション機構")).toBe("アテンション機構")
  })

  it("falls back to 'query' when title yields nothing usable", () => {
    // Emoji-only, punctuation-only, whitespace-only — all previously
    // would produce "-YYYY-MM-DD.md". The fallback keeps the
    // filename readable AND distinguishable (the timestamp suffix
    // on the full filename carries the uniqueness).
    expect(makeQuerySlug("🎉🔥💯")).toBe("query")
    expect(makeQuerySlug("!!! ??? ...")).toBe("query")
    expect(makeQuerySlug("   ")).toBe("query")
    expect(makeQuerySlug("")).toBe("query")
  })

  it("collapses runs of hyphens and trims leading/trailing ones", () => {
    expect(makeQuerySlug("---foo   bar---")).toBe("foo-bar")
    expect(makeQuerySlug("a - b - c")).toBe("a-b-c")
  })

  it("truncates long slugs to 50 characters", () => {
    const long = "a".repeat(200)
    expect(makeQuerySlug(long)).toHaveLength(50)
  })

  it("truncates by Unicode code point rather than leaving a lone surrogate", () => {
    const astral = "𠀀".repeat(60)
    const slug = makeQuerySlug(astral)
    expect(Array.from(slug)).toHaveLength(50)
    expect(() => encodeURIComponent(slug)).not.toThrow()
  })

  it("preserves case-insensitive equivalence for wikilink matching", () => {
    // The codebase treats wikilinks case-insensitively (see lint.ts
    // line 48 comment). Slugs are always lowercase, so two titles
    // that only differ by case always produce the SAME slug — which
    // is desirable: repeat saves of the same topic still collide on
    // slug but the timestamp in the filename keeps them distinct.
    expect(makeQuerySlug("RoPE")).toBe(makeQuerySlug("rope"))
    expect(makeQuerySlug("ATTENTION")).toBe(makeQuerySlug("attention"))
  })
})

describe("makeQueryFileName", () => {
  // Fixed UTC clock for deterministic assertions.
  const NOW = new Date("2026-04-23T14:30:52.123Z")

  it("produces slug-YYYY-MM-DD-HHMMSS.md shape", () => {
    const { fileName, slug, date, time } = makeQueryFileName("Attention Is All You Need", NOW)
    expect(slug).toBe("attention-is-all-you-need")
    expect(date).toBe("2026-04-23")
    expect(time).toBe("143052")
    expect(fileName).toBe("attention-is-all-you-need-2026-04-23-143052.md")
  })

  it("two saves of the SAME title within the same day produce DIFFERENT filenames (the reported bug)", () => {
    const a = makeQueryFileName("旋转位置编码", new Date("2026-04-23T10:00:00.000Z"))
    const b = makeQueryFileName("旋转位置编码", new Date("2026-04-23T14:30:52.123Z"))
    const c = makeQueryFileName("旋转位置编码", new Date("2026-04-23T23:59:59.999Z"))
    // All three must be distinct — this is the whole point of the fix.
    expect(new Set([a.fileName, b.fileName, c.fileName]).size).toBe(3)
    // And all three must share the same slug prefix (so users can
    // visually group them by topic in the file tree).
    expect(a.slug).toBe("旋转位置编码")
    expect(a.fileName.startsWith("旋转位置编码-2026-04-23-")).toBe(true)
    expect(b.fileName.startsWith("旋转位置编码-2026-04-23-")).toBe(true)
    expect(c.fileName.startsWith("旋转位置编码-2026-04-23-")).toBe(true)
  })

  it("keeps review-created Chinese query pages editable and linkable", () => {
    const { fileName, slug } = makeQueryFileName("政策版本差异提示", NOW)
    expect(slug).toBe("政策版本差异提示")
    expect(fileName).toBe("政策版本差异提示-2026-04-23-143052.md")
  })

  it("emoji-only title falls back to 'query' but still produces distinct filenames per save", () => {
    const a = makeQueryFileName("🎉🔥", new Date("2026-04-23T10:00:00Z"))
    const b = makeQueryFileName("🎉🔥", new Date("2026-04-23T10:00:01Z"))
    expect(a.fileName).toBe("query-2026-04-23-100000.md")
    expect(b.fileName).toBe("query-2026-04-23-100001.md")
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
