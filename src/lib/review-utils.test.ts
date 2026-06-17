import { describe, it, expect } from "vitest"
import { normalizeReviewTitle, extractMissingEntityNames } from "./review-utils"

describe("normalizeReviewTitle", () => {
  it("returns the title lowercased when no prefix", () => {
    expect(normalizeReviewTitle("Attention Mechanism")).toBe("attention mechanism")
  })

  it("strips English 'Missing page:' prefix", () => {
    expect(normalizeReviewTitle("Missing page: Attention")).toBe("attention")
  })

  it("strips hyphenated 'Missing-Page:' prefix", () => {
    expect(normalizeReviewTitle("Missing-Page: Attention")).toBe("attention")
  })

  it("strips Chinese '缺失页面：' prefix (full-width colon)", () => {
    expect(normalizeReviewTitle("缺失页面：注意力机制")).toBe("注意力机制")
  })

  it("strips Chinese '缺失页面:' prefix (half-width colon)", () => {
    expect(normalizeReviewTitle("缺失页面: 注意力机制")).toBe("注意力机制")
  })

  it("strips alternative '缺少页面:' prefix", () => {
    expect(normalizeReviewTitle("缺少页面: 注意力")).toBe("注意力")
  })

  it("strips English 'Duplicate page:' prefix", () => {
    expect(normalizeReviewTitle("Duplicate page: LLM")).toBe("llm")
  })

  it("strips Chinese '重复页面：' prefix", () => {
    expect(normalizeReviewTitle("重复页面：大模型")).toBe("大模型")
  })

  it("strips 'Possible duplicate:' prefix", () => {
    expect(normalizeReviewTitle("Possible duplicate: Graph RAG")).toBe("graph rag")
  })

  it("collapses internal whitespace", () => {
    expect(normalizeReviewTitle("Missing page:   Attention   Mechanism")).toBe("attention mechanism")
  })

  it("is case-insensitive on the prefix match", () => {
    expect(normalizeReviewTitle("MISSING PAGE: Attention")).toBe("attention")
    expect(normalizeReviewTitle("missing page: Attention")).toBe("attention")
    expect(normalizeReviewTitle("MiSsInG pAgE: Attention")).toBe("attention")
  })

  it("considers two variant-prefixed titles equal after normalization", () => {
    const a = normalizeReviewTitle("Missing page: 注意力机制")
    const b = normalizeReviewTitle("缺失页面: 注意力机制")
    expect(a).toBe(b)
  })

  it("handles empty string", () => {
    expect(normalizeReviewTitle("")).toBe("")
  })

  it("handles only-prefix input", () => {
    expect(normalizeReviewTitle("Missing page: ")).toBe("")
  })

  it("preserves colons inside the title body (not as prefix)", () => {
    // 'Overview' is not a recognized prefix, so the colon after it must stay
    expect(normalizeReviewTitle("Overview: Some Topic")).toBe("overview: some topic")
  })

  it("only strips ONE prefix occurrence (no recursive stripping)", () => {
    // If the title accidentally has a double prefix, only the first is stripped
    expect(normalizeReviewTitle("Missing page: 缺失页面: Foo")).toBe("缺失页面: foo")
  })
})

describe("extractMissingEntityNames", () => {
  it("returns a single entity from an English missing-page title", () => {
    expect(extractMissingEntityNames("Missing page: attention")).toEqual(["attention"])
  })

  it("returns a single entity from a Chinese-prefixed title", () => {
    expect(extractMissingEntityNames("缺失页面: 注意力机制")).toEqual(["注意力机制"])
  })

  it("splits multiple entities on the Chinese enumeration comma", () => {
    expect(extractMissingEntityNames("缺失页面: CallMethod、StartFunc、Print")).toEqual([
      "CallMethod",
      "StartFunc",
      "Print",
    ])
  })

  it("splits multiple entities on ASCII/full-width commas", () => {
    expect(extractMissingEntityNames("Missing page: Foo, Bar，Baz")).toEqual(["Foo", "Bar", "Baz"])
  })

  it("recovers hyphen-joined identifier lists after a descriptive CJK prefix (issue #414)", () => {
    expect(extractMissingEntityNames("核心测试项实体页缺失-CallMethod-StartFunc-Print")).toEqual([
      "CallMethod",
      "StartFunc",
      "Print",
    ])
  })

  it("preserves the casing of entity identifiers", () => {
    expect(extractMissingEntityNames("Missing page: HttpClient")).toEqual(["HttpClient"])
  })

  it("does NOT shred genuine lowercase kebab-case names", () => {
    expect(extractMissingEntityNames("Missing page: self-attention")).toEqual(["self-attention"])
  })

  it("returns [] for an empty or prefix-only title", () => {
    expect(extractMissingEntityNames("")).toEqual([])
    expect(extractMissingEntityNames("Missing page: ")).toEqual([])
  })

  it("trims surrounding whitespace on each name", () => {
    expect(extractMissingEntityNames("缺失页面:  A 、 B ")).toEqual(["A", "B"])
  })
})
