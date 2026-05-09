import { describe, it, expect, beforeEach } from "vitest"
import { useReviewStore, type ReviewItem } from "./review-store"

// Minimal builder so each test only specifies what it cares about.
function makeInput(overrides: Partial<Omit<ReviewItem, "id" | "resolved" | "createdAt">> = {}) {
  return {
    projectId: "proj-1",
    projectPath: "/project-1",
    type: "missing-page" as ReviewItem["type"],
    title: "Attention",
    description: "description",
    options: [],
    ...overrides,
  }
}

// Reset the store between tests — Zustand stores are module-level singletons.
beforeEach(() => {
  useReviewStore.setState({ items: [] })
})

describe("review-store addItem", () => {
  it("adds a single item with generated id and resolved=false", () => {
    useReviewStore.getState().addItem(makeInput())
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].id).toMatch(/^review-\d+$/)
    expect(items[0].resolved).toBe(false)
    expect(items[0].createdAt).toBeTypeOf("number")
  })

  it("does NOT dedupe in addItem (single-item path is append-only)", () => {
    // By design — dedupe only applies to addItems (bulk path from ingest).
    const store = useReviewStore.getState()
    store.addItem(makeInput({ title: "Same" }))
    store.addItem(makeInput({ title: "Same" }))
    expect(useReviewStore.getState().items).toHaveLength(2)
  })
})

describe("review-store addItems dedupe", () => {
  it("merges two incoming items with the same type + normalized title", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "Missing page: Attention", affectedPages: ["a.md"] }),
      makeInput({ title: "缺失页面: Attention", affectedPages: ["b.md"] }),
    ])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].affectedPages).toEqual(expect.arrayContaining(["a.md", "b.md"]))
  })

  it("merges against existing pending items", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "Attention", affectedPages: ["x.md"] }),
    ])
    useReviewStore.getState().addItems([
      makeInput({ title: "Missing page: Attention", affectedPages: ["y.md"] }),
    ])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].affectedPages).toEqual(expect.arrayContaining(["x.md", "y.md"]))
  })

  it("does NOT merge across different types", () => {
    useReviewStore.getState().addItems([
      makeInput({ type: "missing-page", title: "Attention" }),
      makeInput({ type: "duplicate", title: "Attention" }),
    ])
    expect(useReviewStore.getState().items).toHaveLength(2)
  })

  it("does NOT merge items from different projects even with the same normalized title", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "Attention", projectId: "proj-1", projectPath: "/project-1" }),
      makeInput({ title: "Attention", projectId: "proj-2", projectPath: "/project-2" }),
    ])
    expect(useReviewStore.getState().items).toHaveLength(2)
  })

  it("does NOT merge into a resolved item (creates a new one)", () => {
    const store = useReviewStore.getState()
    store.addItems([makeInput({ title: "Attention" })])
    const oldId = useReviewStore.getState().items[0].id
    store.resolveItem(oldId, "user-resolved")
    store.addItems([makeInput({ title: "Attention", affectedPages: ["new.md"] })])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(2)
    expect(items.find((i) => i.resolved)?.id).toBe(oldId)
    expect(items.find((i) => !i.resolved)?.affectedPages).toEqual(["new.md"])
  })

  it("covers contradiction type (was previously skipped in dedupe)", () => {
    useReviewStore.getState().addItems([
      makeInput({ type: "contradiction", title: "Conflict A", affectedPages: ["a.md"] }),
      makeInput({ type: "contradiction", title: "Conflict A", affectedPages: ["b.md"] }),
    ])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].affectedPages).toEqual(expect.arrayContaining(["a.md", "b.md"]))
  })

  it("covers confirm type", () => {
    useReviewStore.getState().addItems([
      makeInput({ type: "confirm", title: "Confirm X" }),
      makeInput({ type: "confirm", title: "Confirm X" }),
    ])
    expect(useReviewStore.getState().items).toHaveLength(1)
  })

  it("prefers the newer non-empty description on merge", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "A", description: "old desc" }),
    ])
    useReviewStore.getState().addItems([
      makeInput({ title: "A", description: "new desc" }),
    ])
    expect(useReviewStore.getState().items[0].description).toBe("new desc")
  })

  it("keeps old description if incoming is empty", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "A", description: "keep me" }),
    ])
    useReviewStore.getState().addItems([
      makeInput({ title: "A", description: "" }),
    ])
    expect(useReviewStore.getState().items[0].description).toBe("keep me")
  })

  it("deduplicates affectedPages within the merge", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "A", affectedPages: ["x.md", "y.md"] }),
    ])
    useReviewStore.getState().addItems([
      makeInput({ title: "A", affectedPages: ["y.md", "z.md"] }),
    ])
    const merged = useReviewStore.getState().items[0]
    expect(merged.affectedPages).toEqual(["x.md", "y.md", "z.md"])
  })

  it("merges searchQueries without duplicates", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "A", searchQueries: ["q1"] }),
    ])
    useReviewStore.getState().addItems([
      makeInput({ title: "A", searchQueries: ["q1", "q2"] }),
    ])
    expect(useReviewStore.getState().items[0].searchQueries).toEqual(["q1", "q2"])
  })

  it("sets affectedPages to undefined when the merged result is empty", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "A" }),
      makeInput({ title: "A" }),
    ])
    expect(useReviewStore.getState().items[0].affectedPages).toBeUndefined()
  })

  it("handles many incoming items at once, merging same-key pairs", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "A", affectedPages: ["1.md"] }),
      makeInput({ title: "A", affectedPages: ["2.md"] }),
      makeInput({ title: "B", affectedPages: ["3.md"] }),
      makeInput({ title: "A", affectedPages: ["4.md"] }),
    ])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(2)
    const a = items.find((i) => i.title.toLowerCase().includes("a"))
    const b = items.find((i) => i.title.toLowerCase().includes("b"))
    expect(a?.affectedPages).toEqual(["1.md", "2.md", "4.md"])
    expect(b?.affectedPages).toEqual(["3.md"])
  })

  it("invariant: after addItems, no two pending items share (type, normalized title)", () => {
    useReviewStore.getState().addItems([
      makeInput({ type: "missing-page", title: "Missing page: Foo" }),
      makeInput({ type: "missing-page", title: "缺失页面: Foo" }),
      makeInput({ type: "missing-page", title: "Foo" }),
      makeInput({ type: "duplicate", title: "Foo" }),
      makeInput({ type: "duplicate", title: "Duplicate page: Foo" }),
    ])
    const pending = useReviewStore.getState().items.filter((i) => !i.resolved)
    const keys = pending.map((i) => `${i.type}::${i.title.toLowerCase().replace(/^(missing|duplicate).*?:\s*/i, "").trim()}`)
    expect(new Set(keys).size).toBe(pending.length)
  })
})

describe("review-store resolveItem / dismissItem / clearResolved", () => {
  it("resolveItem flips the flag and stores action", () => {
    useReviewStore.getState().addItem(makeInput())
    const id = useReviewStore.getState().items[0].id
    useReviewStore.getState().resolveItem(id, "auto-resolved")
    const resolved = useReviewStore.getState().items.find((i) => i.id === id)
    expect(resolved?.resolved).toBe(true)
    expect(resolved?.resolvedAction).toBe("auto-resolved")
  })

  it("resolveItem on missing id is a no-op (doesn't throw)", () => {
    useReviewStore.getState().addItem(makeInput())
    expect(() => useReviewStore.getState().resolveItem("nonexistent", "x")).not.toThrow()
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("dismissItem removes the item entirely", () => {
    useReviewStore.getState().addItem(makeInput())
    const id = useReviewStore.getState().items[0].id
    useReviewStore.getState().dismissItem(id)
    expect(useReviewStore.getState().items).toHaveLength(0)
  })

  it("clearResolved keeps only unresolved items", () => {
    useReviewStore.getState().addItems([
      makeInput({ title: "A" }),
      makeInput({ title: "B" }),
      makeInput({ title: "C" }),
    ])
    const items = useReviewStore.getState().items
    useReviewStore.getState().resolveItem(items[0].id, "user-resolved")
    useReviewStore.getState().resolveItem(items[2].id, "user-resolved")
    useReviewStore.getState().clearResolved()
    const remaining = useReviewStore.getState().items
    expect(remaining).toHaveLength(1)
    expect(remaining[0].title).toBe("B")
  })
})
