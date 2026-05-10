import { describe, it, expect } from "vitest"
import { normalizeReviewTitle } from "./review-utils"

describe("normalizeReviewTitle", () => {
  it("returns the title lowercased when no prefix", () => {
    expect(normalizeReviewTitle("Attention Mechanism")).toBe("attention mechanism")
  })

  it("strips English 'Missing page:' prefix", () => {
    expect(normalizeReviewTitle("Missing page: Attention")).toBe("attention")
  })

  it("strips English 'Missing wiki page:' prefix", () => {
    expect(normalizeReviewTitle("Missing wiki page: dify")).toBe("dify")
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
