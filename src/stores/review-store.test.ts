import { describe, it, expect, beforeEach } from "vitest"
import { useReviewStore, reviewIdFor, type ReviewItem } from "./review-store"

// Minimal builder so each test only specifies what it cares about.
function makeInput(overrides: Partial<Omit<ReviewItem, "id" | "resolved" | "createdAt">> = {}) {
  return {
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

describe("reviewIdFor — content-stable id", () => {
  it("is identical for the same type + normalized title (survives regeneration)", () => {
    // "Missing page: Attention" and "缺失页面: Attention" normalize equal.
    expect(reviewIdFor({ type: "missing-page", title: "Missing page: Attention" }))
      .toBe(reviewIdFor({ type: "missing-page", title: "缺失页面: Attention" }))
  })

  it("differs across types", () => {
    expect(reviewIdFor({ type: "missing-page", title: "Attention" }))
      .not.toBe(reviewIdFor({ type: "duplicate", title: "Attention" }))
  })

  it("differs across distinct titles", () => {
    expect(reviewIdFor({ type: "missing-page", title: "Attention" }))
      .not.toBe(reviewIdFor({ type: "missing-page", title: "Transformer" }))
  })

  it("does not depend on sourcePath (file moves keep the id stable)", () => {
    // reviewIdFor only takes type + title; sourcePath cannot affect it.
    const a = reviewIdFor({ type: "missing-page", title: "Attention" })
    const b = reviewIdFor({ type: "missing-page", title: "Attention" })
    expect(a).toBe(b)
  })
})

describe("review-store addItem", () => {
  it("adds a single item with content-stable id and resolved=false", () => {
    useReviewStore.getState().addItem(makeInput())
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(reviewIdFor(makeInput()))
    expect(items[0].resolved).toBe(false)
    expect(items[0].createdAt).toBeTypeOf("number")
  })

  it("dedupes same-content items (stable id identity), keeps distinct ones", () => {
    const store = useReviewStore.getState()
    store.addItem(makeInput({ title: "Same" }))
    store.addItem(makeInput({ title: "Same" }))
    expect(useReviewStore.getState().items).toHaveLength(1)
    store.addItem(makeInput({ title: "Different" }))
    expect(useReviewStore.getState().items).toHaveLength(2)
  })

  it("does not revive a resolved item when the same content is added again", () => {
    const store = useReviewStore.getState()
    store.addItem(makeInput({ title: "Attention" }))
    const id = useReviewStore.getState().items[0].id
    store.resolveItem(id, "user-resolved")
    store.addItem(makeInput({ title: "Attention" }))
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].resolved).toBe(true)
    expect(items[0].resolvedAction).toBe("user-resolved")
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

  it("MERGES into a resolved item and preserves its resolved state (resolved wins)", () => {
    // This is the core fix: re-surfacing a review during ingest must NOT
    // discard its resolution. The same-content item folds into the
    // resolved one (same id), keeping resolved + merging new pages.
    const store = useReviewStore.getState()
    store.addItems([makeInput({ title: "Attention" })])
    const oldId = useReviewStore.getState().items[0].id
    store.resolveItem(oldId, "user-resolved")
    store.addItems([makeInput({ title: "Attention", affectedPages: ["new.md"] })])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(oldId)
    expect(items[0].resolved).toBe(true)
    expect(items[0].resolvedAction).toBe("user-resolved")
    expect(items[0].affectedPages).toEqual(["new.md"])
  })

  it("covers contradiction type", () => {
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
    useReviewStore.getState().addItems([makeInput({ title: "A", description: "old desc" })])
    useReviewStore.getState().addItems([makeInput({ title: "A", description: "new desc" })])
    expect(useReviewStore.getState().items[0].description).toBe("new desc")
  })

  it("keeps old description if incoming is empty", () => {
    useReviewStore.getState().addItems([makeInput({ title: "A", description: "keep me" })])
    useReviewStore.getState().addItems([makeInput({ title: "A", description: "" })])
    expect(useReviewStore.getState().items[0].description).toBe("keep me")
  })

  it("deduplicates affectedPages within the merge", () => {
    useReviewStore.getState().addItems([makeInput({ title: "A", affectedPages: ["x.md", "y.md"] })])
    useReviewStore.getState().addItems([makeInput({ title: "A", affectedPages: ["y.md", "z.md"] })])
    expect(useReviewStore.getState().items[0].affectedPages).toEqual(["x.md", "y.md", "z.md"])
  })

  it("merges searchQueries without duplicates", () => {
    useReviewStore.getState().addItems([makeInput({ title: "A", searchQueries: ["q1"] })])
    useReviewStore.getState().addItems([makeInput({ title: "A", searchQueries: ["q1", "q2"] })])
    expect(useReviewStore.getState().items[0].searchQueries).toEqual(["q1", "q2"])
  })

  it("sets affectedPages to undefined when the merged result is empty", () => {
    useReviewStore.getState().addItems([makeInput({ title: "A" }), makeInput({ title: "A" })])
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

  it("invariant: after addItems, every item has a unique stable id", () => {
    useReviewStore.getState().addItems([
      makeInput({ type: "missing-page", title: "Missing page: Foo" }),
      makeInput({ type: "missing-page", title: "缺失页面: Foo" }),
      makeInput({ type: "missing-page", title: "Foo" }),
      makeInput({ type: "duplicate", title: "Foo" }),
      makeInput({ type: "duplicate", title: "Duplicate page: Foo" }),
    ])
    const ids = useReviewStore.getState().items.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("review-store setItems — migrate-on-load", () => {
  it("remaps old counter ids to content-stable ids", () => {
    useReviewStore.getState().setItems([
      { ...makeInput({ title: "Attention" }), id: "review-6", resolved: false, createdAt: 1 },
    ])
    const item = useReviewStore.getState().items[0]
    expect(item.id).toBe(reviewIdFor({ type: "missing-page", title: "Attention" }))
  })

  it("collapses two old items with identical content into one — resolved wins", () => {
    // Acceptance: two counter-id rows for the same review (one resolved)
    // must fold into a single resolved item on load.
    useReviewStore.getState().setItems([
      {
        ...makeInput({ title: "Attention", affectedPages: ["a.md"] }),
        id: "review-6",
        resolved: false,
        createdAt: 5,
      },
      {
        ...makeInput({ title: "Missing page: Attention", affectedPages: ["b.md"] }),
        id: "review-99",
        resolved: true,
        resolvedAction: "user-resolved",
        createdAt: 2,
      },
    ])
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].resolved).toBe(true)
    expect(items[0].resolvedAction).toBe("user-resolved")
    expect(items[0].affectedPages).toEqual(expect.arrayContaining(["a.md", "b.md"]))
    expect(items[0].createdAt).toBe(2) // earliest
  })

  it("is idempotent — loading already-stable ids changes nothing", () => {
    const stable = reviewIdFor({ type: "missing-page", title: "Attention" })
    useReviewStore.getState().setItems([
      { ...makeInput({ title: "Attention" }), id: stable, resolved: true, resolvedAction: "x", createdAt: 1 },
    ])
    const first = useReviewStore.getState().items
    useReviewStore.getState().setItems(first)
    const second = useReviewStore.getState().items
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(stable)
    expect(second[0].resolved).toBe(true)
  })

  it("resolve survives a re-ingest of the same source (same id, stays resolved)", () => {
    // End-to-end of the user's scenario: resolve, then ingest re-surfaces
    // the same review via addItems → it keeps its id and resolution.
    useReviewStore.getState().addItems([makeInput({ title: "Attention" })])
    const id = useReviewStore.getState().items[0].id
    useReviewStore.getState().resolveItem(id, "user-resolved")
    // simulate queue-shrink rebuild re-emitting the same review
    useReviewStore.getState().addItems([makeInput({ title: "Attention", affectedPages: ["regen.md"] })])
    const item = useReviewStore.getState().items[0]
    expect(useReviewStore.getState().items).toHaveLength(1)
    expect(item.id).toBe(id)
    expect(item.resolved).toBe(true)
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
