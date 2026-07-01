/**
 * Regression suite for the wiki-cleanup helpers used when deleting a
 * source document. Each describe block targets a specific real-world
 * failure mode or nearby edge case. Failing tests here mean the
 * source-delete cleanup has regressed to either:
 *
 *   - leaving stale `[[title]]`-form wikilinks that reference pages
 *     that are no longer on disk, confusing the next ingest run, OR
 *   - collaterally wiping legitimate wikilinks whose label happens to
 *     contain a deleted slug as a substring.
 */
import { describe, it, expect } from "vitest"
import {
  buildDeletedKeys,
  cleanIndexListing,
  stripDeletedWikilinks,
  extractFrontmatterTitle,
} from "./wiki-cleanup"

// ── extractFrontmatterTitle ─────────────────────────────────────────

describe("extractFrontmatterTitle", () => {
  it("pulls a bare title value", () => {
    expect(extractFrontmatterTitle("---\ntitle: KV Cache\n---\nbody")).toBe("KV Cache")
  })

  it("strips surrounding double quotes", () => {
    expect(extractFrontmatterTitle("---\ntitle: \"KV Cache\"\n---")).toBe("KV Cache")
  })

  it("strips surrounding single quotes", () => {
    expect(extractFrontmatterTitle("---\ntitle: 'KV Cache'\n---")).toBe("KV Cache")
  })

  it("tolerates extra whitespace", () => {
    expect(extractFrontmatterTitle("title:    KV Cache   ")).toBe("KV Cache")
  })

  it("handles CJK titles", () => {
    expect(extractFrontmatterTitle("title: 长上下文 Long Context")).toBe("长上下文 Long Context")
  })

  it("returns empty string when no title present", () => {
    expect(extractFrontmatterTitle("---\ntype: concept\n---\nbody")).toBe("")
  })
})

// ── buildDeletedKeys ────────────────────────────────────────────────

describe("buildDeletedKeys", () => {
  it("includes both slug-form and title-form of every deleted page", () => {
    const keys = buildDeletedKeys([
      { slug: "kv-cache", title: "KV Cache" },
      { slug: "long-context", title: "长上下文 Long Context" },
    ])
    expect(keys.has("kvcache")).toBe(true)
    expect(keys.has("长上下文longcontext")).toBe(true)
  })

  it("treats slug and title as synonyms when they normalise equal", () => {
    const keys = buildDeletedKeys([{ slug: "kv-cache", title: "KV Cache" }])
    // "kv-cache" and "KV Cache" both normalise to "kvcache" — one set entry.
    expect(keys.size).toBe(1)
  })

  it("handles missing title gracefully", () => {
    const keys = buildDeletedKeys([{ slug: "rope", title: "" }])
    expect(keys.has("rope")).toBe(true)
    expect(keys.size).toBe(1)
  })

  it("treats path and .md variants as the same deleted wiki target", () => {
    const keys = buildDeletedKeys([{ slug: "life_is_a_mind_game", title: "" }])
    expect(keys.has("lifeisamindgame")).toBe(true)

    const pathKeys = buildDeletedKeys([
      { slug: "wiki/sources/life_is_a_mind_game.md", title: "" },
    ])
    expect(pathKeys.has("lifeisamindgame")).toBe(true)
  })

  it("is empty when given no pages", () => {
    expect(buildDeletedKeys([]).size).toBe(0)
  })
})

// ── cleanIndexListing ───────────────────────────────────────────────

describe("cleanIndexListing — title/slug matching (Bug A)", () => {
  it("drops a bullet whose primary wikilink is the title form `[[KV Cache]]`", () => {
    const text = [
      "## Concepts",
      "- [[KV Cache]] — 推理加速的标准技巧",
      "- [[Flash Attention]] — IO-aware 内核",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "kv-cache", title: "KV Cache" }])
    const result = cleanIndexListing(text, keys)
    expect(result).not.toContain("KV Cache")
    expect(result).toContain("Flash Attention")
  })

  it("drops a bullet whose primary wikilink is the slug form `[[kv-cache]]`", () => {
    const text = "- [[kv-cache]] — 推理加速"
    const keys = buildDeletedKeys([{ slug: "kv-cache", title: "KV Cache" }])
    expect(cleanIndexListing(text, keys).trim()).toBe("")
  })

  it("drops bullets for CJK title forms", () => {
    const text = [
      "## Concepts",
      "- [[长上下文 Long Context]] — 256k 上下文",
      "- [[RoPE 旋转位置编码]] — 位置编码",
    ].join("\n")
    const keys = buildDeletedKeys([
      { slug: "long-context", title: "长上下文 Long Context" },
    ])
    const result = cleanIndexListing(text, keys)
    expect(result).not.toContain("长上下文")
    expect(result).toContain("RoPE")
  })

  it("drops bullets using a pipe-separated display form `[[target|display]]`", () => {
    const text = "- [[kv-cache|KV 缓存]] — 推理加速"
    const keys = buildDeletedKeys([{ slug: "kv-cache", title: "KV Cache" }])
    expect(cleanIndexListing(text, keys).trim()).toBe("")
  })

  it("drops bullets whose wikilink target includes a path or .md suffix", () => {
    const text = [
      "- [[wiki/sources/life_is_a_mind_game.md]] — source summary",
      "- [[wiki/entities/kept.md]] — kept",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "life_is_a_mind_game", title: "" }])
    const result = cleanIndexListing(text, keys)
    expect(result).not.toContain("life_is_a_mind_game")
    expect(result).toContain("wiki/entities/kept.md")
  })
})

describe("cleanIndexListing — substring safety (Bug B)", () => {
  it("does NOT remove `[[OpenAI]]` when deleting `ai`", () => {
    const text = [
      "## Entities",
      "- [[OpenAI]] — GPT 厂商",
      "- [[Constitutional AI]] — Anthropic 理念",
      "- [[AI Safety]] — 对齐研究",
      "- [[Anthropic]] — Claude 厂商",
      "## Concepts",
      "- [[AI]] — 人工智能概念",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "ai", title: "AI" }])
    const result = cleanIndexListing(text, keys)

    // Only the pure `[[AI]]` line gets dropped.
    expect(result).not.toContain("- [[AI]] — 人工智能概念")
    // Every other bullet survives — the old `includes("ai")` logic
    // would have wiped all four of these.
    expect(result).toContain("[[OpenAI]]")
    expect(result).toContain("[[Constitutional AI]]")
    expect(result).toContain("[[AI Safety]]")
    expect(result).toContain("[[Anthropic]]")
  })

  it("does NOT remove `[[Europe]]` when deleting `rope`", () => {
    const text = [
      "- [[RoPE 旋转位置编码]] — 位置编码",
      "- [[Europe]] — 欧洲",
      "- [[Microscope]] — 显微镜",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "rope", title: "RoPE 旋转位置编码" }])
    const result = cleanIndexListing(text, keys)
    expect(result).not.toContain("RoPE 旋转位置编码")
    expect(result).toContain("Europe")
    expect(result).toContain("Microscope")
  })

  it("does NOT wipe every bullet when a 2-char slug appears in common words", () => {
    // Deleting a page with an unfortunate 2-char slug like "at" must
    // not match every wikilink containing the letters a-t anywhere.
    const text = [
      "- [[At]] — 占位",
      "- [[Attention]] — 注意力",
      "- [[Flash Attention]] — 内核",
      "- [[Cat]] — 动物",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "at", title: "At" }])
    const result = cleanIndexListing(text, keys)
    expect(result).not.toContain("- [[At]] — 占位")
    expect(result).toContain("[[Attention]]")
    expect(result).toContain("[[Flash Attention]]")
    expect(result).toContain("[[Cat]]")
  })
})

describe("cleanIndexListing — shared-source scenario", () => {
  it("keeps the index line when a multi-source page stayed on disk (caller did not include it in deletedPageInfos)", () => {
    // Shared-source pages are handled upstream: they get their sources
    // list updated and stay on disk, so they are NEVER added to the
    // deletedPageInfos passed into buildDeletedKeys. Verifying that if
    // the caller behaves correctly, our helper leaves those index
    // entries alone.
    const text = [
      "## Entities",
      "- [[Anthropic]] — Claude 厂商",
      "## Concepts",
      "- [[KV Cache]] — 推理加速",
      "- [[RoPE]] — 位置编码",
    ].join("\n")
    // Only kv-cache was fully deleted; anthropic and rope stay.
    const keys = buildDeletedKeys([{ slug: "kv-cache", title: "KV Cache" }])
    const result = cleanIndexListing(text, keys)
    expect(result).not.toContain("KV Cache")
    expect(result).toContain("Anthropic")
    expect(result).toContain("RoPE")
  })

  it("no-op when deletedPageInfos is empty (all deletions were source-only)", () => {
    const text = "- [[Anthropic]] — ..."
    expect(cleanIndexListing(text, buildDeletedKeys([]))).toBe(text)
  })
})

describe("cleanIndexListing — line-shape preservation", () => {
  it("preserves section headers even when the section goes empty", () => {
    const text = [
      "# Wiki Index",
      "",
      "## Concepts",
      "- [[Deleted One]]",
      "",
      "## Entities",
      "- [[Kept]]",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "deleted-one", title: "Deleted One" }])
    const result = cleanIndexListing(text, keys)
    expect(result).toContain("## Concepts")
    expect(result).toContain("## Entities")
    expect(result).not.toContain("Deleted One")
  })

  it("preserves non-list prose that mentions a deleted title (no bullet marker)", () => {
    const text = [
      "Some prose mentioning [[Deleted]] inline.",
      "- [[Deleted]] as a bullet",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "deleted", title: "Deleted" }])
    const result = cleanIndexListing(text, keys)
    // Bullet line dropped; prose line preserved (the bullet-matching
    // regex is anchored to `^\s*[-*]` so prose never matches).
    expect(result).toContain("Some prose mentioning [[Deleted]] inline.")
    expect(result).not.toContain("- [[Deleted]] as a bullet")
  })

  it("preserves frontmatter lines even when they contain 'title:'", () => {
    const text = [
      "---",
      "title: Wiki Index",
      "---",
      "- [[Deleted]]",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "deleted", title: "Deleted" }])
    const result = cleanIndexListing(text, keys)
    expect(result).toContain("title: Wiki Index")
    expect(result).not.toContain("[[Deleted]]")
  })

  it("preserves blank lines around the removed entry", () => {
    const text = "\n\n- [[Deleted]]\n\n"
    const keys = buildDeletedKeys([{ slug: "deleted", title: "Deleted" }])
    const result = cleanIndexListing(text, keys)
    // Bullet line disappears; the four surrounding empty strings (from
    // the leading + trailing `\n\n` padding) survive as blank entries.
    expect(result).not.toContain("[[Deleted]]")
    expect(result.split("\n").filter((l) => l === "").length).toBe(4)
  })

  it("handles asterisk bullets as well as hyphen bullets", () => {
    const text = "* [[Deleted]]"
    const keys = buildDeletedKeys([{ slug: "deleted", title: "Deleted" }])
    expect(cleanIndexListing(text, keys).trim()).toBe("")
  })

  it("ignores secondary wikilinks in the description when the primary survives", () => {
    // A bullet whose PRIMARY wikilink is a kept page should survive
    // even if the description mentions a deleted page as a secondary
    // reference. (Stripping those inline references is the job of
    // stripDeletedWikilinks, not this helper.)
    const text = "- [[Kept Page]] — see also [[Deleted Page]] for context"
    const keys = buildDeletedKeys([{ slug: "deleted-page", title: "Deleted Page" }])
    const result = cleanIndexListing(text, keys)
    expect(result).toBe(text)
  })
})

// ── stripDeletedWikilinks ──────────────────────────────────────────

describe("stripDeletedWikilinks", () => {
  it("replaces `[[deleted]]` with its bare label", () => {
    const text = "See [[Deleted]] for context."
    const keys = buildDeletedKeys([{ slug: "deleted", title: "Deleted" }])
    expect(stripDeletedWikilinks(text, keys)).toBe("See Deleted for context.")
  })

  it("replaces `[[deleted|display]]` with the display text", () => {
    const text = "See [[deleted|My Display]] for more."
    const keys = buildDeletedKeys([{ slug: "deleted", title: "Deleted" }])
    expect(stripDeletedWikilinks(text, keys)).toBe("See My Display for more.")
  })

  it("leaves wikilinks to surviving pages alone", () => {
    const text = "See [[Kept]] and [[Deleted]] side by side."
    const keys = buildDeletedKeys([{ slug: "deleted", title: "Deleted" }])
    expect(stripDeletedWikilinks(text, keys)).toBe(
      "See [[Kept]] and Deleted side by side.",
    )
  })

  it("handles mixed title/slug wikilinks pointing at the same deleted page", () => {
    const text = "Prefer [[KV Cache]] over legacy [[kv-cache]]."
    const keys = buildDeletedKeys([{ slug: "kv-cache", title: "KV Cache" }])
    expect(stripDeletedWikilinks(text, keys)).toBe(
      "Prefer KV Cache over legacy kv-cache.",
    )
  })

  it("strips wikilinks whose target includes a path or .md suffix", () => {
    const text = "See [[life_is_a_mind_game.md]] and [[wiki/sources/life_is_a_mind_game|Life]]."
    const keys = buildDeletedKeys([{ slug: "life_is_a_mind_game", title: "" }])
    expect(stripDeletedWikilinks(text, keys)).toBe(
      "See life_is_a_mind_game.md and Life.",
    )
  })

  it("does NOT wipe `[[OpenAI]]` when deleting `ai` (Bug B — substring safety)", () => {
    const text = "Companies: [[OpenAI]], [[Anthropic]]. Concept: [[AI]]."
    const keys = buildDeletedKeys([{ slug: "ai", title: "AI" }])
    expect(stripDeletedWikilinks(text, keys)).toBe(
      "Companies: [[OpenAI]], [[Anthropic]]. Concept: AI.",
    )
  })

  it("strips every occurrence in a long document", () => {
    const text = [
      "# Overview",
      "",
      "We cover [[KV Cache]] and [[Flash Attention]] in detail.",
      "See also [[KV Cache|the cache chapter]] for usage notes.",
      "[[RoPE]] is kept separate from [[KV Cache]].",
    ].join("\n")
    const keys = buildDeletedKeys([{ slug: "kv-cache", title: "KV Cache" }])
    const result = stripDeletedWikilinks(text, keys)
    expect(result).not.toContain("[[KV Cache]]")
    expect(result).not.toContain("[[KV Cache|")
    expect(result).toContain("KV Cache")
    expect(result).toContain("the cache chapter")
    expect(result).toContain("[[Flash Attention]]")
    expect(result).toContain("[[RoPE]]")
  })

  it("is a no-op when deletedKeys is empty", () => {
    const text = "[[Kept]] and [[Also Kept]]"
    expect(stripDeletedWikilinks(text, new Set())).toBe(text)
  })
})

// ── End-to-end scenarios that exercise cleanIndexListing + stripDeletedWikilinks ──

describe("End-to-end: delete a single-source page, keep a shared page", () => {
  it("strips references everywhere while leaving shared pages intact", () => {
    const indexBefore = [
      "# Wiki Index",
      "",
      "## Entities",
      "- [[Anthropic]] — Claude 厂商",
      "- [[OpenAI]] — GPT 厂商",
      "",
      "## Concepts",
      "- [[KV Cache]] — 推理加速",
      "- [[RoPE]] — 位置编码",
    ].join("\n")

    const overviewBefore = [
      "Wiki 涵盖主要 LLM 厂商 [[Anthropic]] 与 [[OpenAI]]。",
      "核心概念包括 [[KV Cache]]、[[RoPE]] 与 [[Flash Attention]]。",
      "[[KV Cache|缓存机制]]是推理加速的常见手段。",
    ].join("\n")

    // User deletes test1.md. kv-cache.md was single-sourced → deleted.
    // anthropic.md / openai.md / rope.md had other sources → kept.
    const keys = buildDeletedKeys([{ slug: "kv-cache", title: "KV Cache" }])

    const indexAfter = cleanIndexListing(indexBefore, keys)
    expect(indexAfter).toContain("[[Anthropic]]")
    expect(indexAfter).toContain("[[OpenAI]]")
    expect(indexAfter).toContain("[[RoPE]]")
    expect(indexAfter).not.toContain("KV Cache")
    // Section headers preserved.
    expect(indexAfter).toContain("## Concepts")

    const overviewAfter = stripDeletedWikilinks(overviewBefore, keys)
    expect(overviewAfter).toContain("[[Anthropic]]")
    expect(overviewAfter).toContain("[[OpenAI]]")
    expect(overviewAfter).toContain("[[RoPE]]")
    expect(overviewAfter).toContain("[[Flash Attention]]")
    expect(overviewAfter).not.toContain("[[KV Cache")
    // Pipe form was replaced with display text.
    expect(overviewAfter).toContain("缓存机制是推理加速的常见手段")
  })
})

describe("End-to-end: the user's reported regression (substring false-positive)", () => {
  it("deleting `ai.md` doesn't collaterally wipe OpenAI / Constitutional AI / AI Safety", () => {
    const indexBefore = [
      "## Entities",
      "- [[Anthropic]] — Claude 厂商",
      "- [[OpenAI]] — GPT 厂商",
      "- [[Constitutional AI]] — Anthropic 理念",
      "- [[AI Safety]] — 对齐研究",
      "",
      "## Concepts",
      "- [[AI]] — 人工智能概念",
      "- [[Attention]] — 注意力机制",
    ].join("\n")

    // Before the fix this would have wiped OpenAI / Constitutional AI
    // / AI Safety because `line.includes("ai")` matched them all.
    const keys = buildDeletedKeys([{ slug: "ai", title: "AI" }])
    const indexAfter = cleanIndexListing(indexBefore, keys)

    expect(indexAfter).toContain("[[OpenAI]]")
    expect(indexAfter).toContain("[[Constitutional AI]]")
    expect(indexAfter).toContain("[[AI Safety]]")
    expect(indexAfter).toContain("[[Attention]]")
    // Only the pure AI concept line is gone.
    expect(indexAfter).not.toContain("- [[AI]] — 人工智能概念")
  })
})

describe("End-to-end: the user's original bug (title-form wikilinks not matching slug)", () => {
  it("stale `[[KV Cache]]` style entries get removed when page kv-cache.md is deleted", () => {
    // Exact shape of the failure the user observed in production:
    // slug "kv-cache" never matched line "- [[KV Cache]] — ...".
    // With normalized key matching, it does.
    const indexBefore = [
      "## Concepts",
      "- [[Ingest 输出格式]] — 格式规范",
      "- [[KV Cache]] — 推理加速",
      "- [[推测解码 Speculative Decoding]] — 解码策略",
      "- [[长上下文 Long Context]] — 窗口大小",
      "- [[函数调用 Function Calling]] — 工具调用",
      "- [[RoPE 旋转位置编码]] — 位置编码",
    ].join("\n")

    const keys = buildDeletedKeys([
      { slug: "kv-cache", title: "KV Cache" },
      { slug: "speculative-decoding", title: "推测解码 Speculative Decoding" },
      { slug: "long-context", title: "长上下文 Long Context" },
      { slug: "function-calling", title: "函数调用 Function Calling" },
      { slug: "ingest-output-format", title: "Ingest 输出格式" },
    ])

    const indexAfter = cleanIndexListing(indexBefore, keys)

    // All five stale entries should be gone.
    expect(indexAfter).not.toContain("KV Cache")
    expect(indexAfter).not.toContain("Speculative Decoding")
    expect(indexAfter).not.toContain("Long Context")
    expect(indexAfter).not.toContain("Function Calling")
    expect(indexAfter).not.toContain("Ingest 输出格式")
    // RoPE should stay.
    expect(indexAfter).toContain("[[RoPE 旋转位置编码]]")
    // Section header survives.
    expect(indexAfter).toContain("## Concepts")
  })
})
