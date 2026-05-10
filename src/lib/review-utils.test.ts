import { describe, it, expect } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import {
  normalizeReviewTitle,
  canonicalizeReviewItems,
  bucketReviewItems,
  needsProjectAssignment,
} from "./review-utils"

function makeReview(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "r-1",
    projectId: "proj-1",
    projectPath: "/project-1",
    type: "missing-page",
    title: "Attention",
    description: "",
    options: [],
    resolved: false,
    createdAt: 1,
    ...overrides,
  }
}

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

describe("canonicalizeReviewItems", () => {
  it("keeps the more complete item when the visible key matches", () => {
    const items = canonicalizeReviewItems([
      makeReview({ id: "a", projectId: "", createdAt: 1 }),
      makeReview({ id: "b", projectId: "proj-1", createdAt: 2 }),
    ])
    expect(items.map((item) => item.id)).toEqual(["b"])
  })

  it("prefers pending over resolved for the same visible key", () => {
    const items = canonicalizeReviewItems([
      makeReview({ id: "resolved", resolved: true, createdAt: 10 }),
      makeReview({ id: "pending", resolved: false, createdAt: 1 }),
    ])
    expect(items.map((item) => item.id)).toEqual(["pending"])
  })

  it("keeps the newer item when assignment and resolution are tied", () => {
    const items = canonicalizeReviewItems([
      makeReview({ id: "older", createdAt: 1 }),
      makeReview({ id: "newer", createdAt: 5 }),
    ])
    expect(items.map((item) => item.id)).toEqual(["newer"])
  })
})

describe("bucketReviewItems", () => {
  it("shows a same-path, missing-projectId item only in Current", () => {
    const item = makeReview({ id: "r", projectId: "", projectPath: "/project-1" })
    const buckets = bucketReviewItems([item], "/project-1")
    expect(buckets.currentPending.map((it) => it.id)).toEqual(["r"])
    expect(buckets.unassigned).toEqual([])
  })

  it("does not show the same logical item in Current and Unassigned", () => {
    const current = makeReview({ id: "current", projectId: "proj-1", projectPath: "/project-1" })
    const orphanTwin = makeReview({ id: "orphan", projectId: "", projectPath: "/project-1", createdAt: 2 })
    const buckets = bucketReviewItems([current, orphanTwin], "/project-1")
    expect(buckets.currentPending).toHaveLength(1)
    expect(buckets.currentPending[0].id).toBe("current")
    expect(buckets.unassigned).toEqual([])
  })

  it("puts truly unassigned items into Unassigned", () => {
    const orphan = makeReview({ id: "orphan", projectId: "", projectPath: "" })
    const buckets = bucketReviewItems([orphan], "/project-1")
    expect(buckets.currentPending).toEqual([])
    expect(buckets.unassigned.map((it) => it.id)).toEqual(["orphan"])
  })

  it("separates resolved current items from pending count", () => {
    const pending = makeReview({ id: "pending", resolved: false })
    const resolved = makeReview({ id: "resolved", title: "Beta", resolved: true })
    const buckets = bucketReviewItems([pending, resolved], "/project-1")
    expect(buckets.currentPending.map((it) => it.id)).toEqual(["pending"])
    expect(buckets.currentResolved.map((it) => it.id)).toEqual(["resolved"])
  })
})

describe("needsProjectAssignment", () => {
  it("returns true when the item is visible in current project but missing projectId", () => {
    expect(
      needsProjectAssignment(
        makeReview({ projectId: "", projectPath: "/project-1" }),
        "/project-1",
      ),
    ).toBe(true)
  })

  it("returns false for already-assigned current items", () => {
    expect(
      needsProjectAssignment(
        makeReview({ projectId: "proj-1", projectPath: "/project-1" }),
        "/project-1",
      ),
    ).toBe(false)
  })
})
