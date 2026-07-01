import { describe, it, expect, beforeEach } from "vitest"
import type { LintResult } from "@/lib/lint"
import { useLintStore, type LintItem } from "./lint-store"

function makeLintResult(overrides: Partial<Omit<LintResult, "type" | "severity" | "page" | "detail">> & { type?: LintResult["type"]; severity?: LintResult["severity"]; page?: string } = {}): LintResult {
  return {
    type: "orphan",
    severity: "info",
    page: "test-page.md",
    detail: "test detail",
    ...overrides,
  }
}

beforeEach(() => {
  useLintStore.setState({ items: [] })
})

describe("lint-store addItems", () => {
  it("converts LintResult[] to LintItem[] with generated id and createdAt", () => {
    const results = [makeLintResult({ page: "page-a.md" })]
    useLintStore.getState().addItems(results)
    const items = useLintStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].id).toMatch(/^lint-\d+$/)
    expect(items[0].createdAt).toBeTypeOf("number")
    expect(items[0].page).toBe("page-a.md")
  })

  it("adds multiple LintResult items in one call", () => {
    const results = [
      makeLintResult({ page: "page-a.md", type: "orphan" }),
      makeLintResult({ page: "page-b.md", type: "broken-link", severity: "warning" }),
      makeLintResult({ page: "page-c.md", type: "no-outlinks" }),
    ]
    useLintStore.getState().addItems(results)
    expect(useLintStore.getState().items).toHaveLength(3)
  })

  it("preserves type, severity, page, detail, affectedPages from LintResult", () => {
    const results: LintResult[] = [
      {
        type: "semantic",
        severity: "warning",
        page: "entities/transformer.md",
        detail: "contradiction: conflicting claims about model size",
        affectedPages: ["a.md", "b.md"],
        brokenTarget: "transfomer",
        suggestedTarget: "entities/transformer.md",
        suggestedSource: "concepts/attention.md",
      },
    ]
    useLintStore.getState().addItems(results)
    const item = useLintStore.getState().items[0]
    expect(item.type).toBe("semantic")
    expect(item.severity).toBe("warning")
    expect(item.page).toBe("entities/transformer.md")
    expect(item.detail).toBe("contradiction: conflicting claims about model size")
    expect(item.affectedPages).toEqual(["a.md", "b.md"])
    expect(item.brokenTarget).toBe("transfomer")
    expect(item.suggestedTarget).toBe("entities/transformer.md")
    expect(item.suggestedSource).toBe("concepts/attention.md")
  })
})

describe("lint-store setItems", () => {
  it("replaces all items with the given array", () => {
    useLintStore.getState().addItems([makeLintResult({ page: "existing.md" })])
    const incoming: LintItem[] = [
      { id: "lint-100", type: "orphan", severity: "info", page: "new.md", detail: "d", createdAt: 999 },
    ]
    useLintStore.getState().setItems(incoming)
    expect(useLintStore.getState().items).toHaveLength(1)
    expect(useLintStore.getState().items[0].page).toBe("new.md")
  })

  it("can set empty array to clear items", () => {
    useLintStore.getState().addItems([makeLintResult(), makeLintResult()])
    useLintStore.getState().setItems([])
    expect(useLintStore.getState().items).toHaveLength(0)
  })

  it("keeps generated ids unique after restoring persisted items", () => {
    useLintStore.getState().setItems([
      { id: "lint-100", type: "orphan", severity: "info", page: "old.md", detail: "d", createdAt: 999 },
    ])
    useLintStore.getState().addItems([makeLintResult({ page: "new.md" })])

    const ids = useLintStore.getState().items.map((item) => item.id)
    expect(ids[0]).toBe("lint-100")
    expect(ids[1]).toMatch(/^lint-\d+$/)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("lint-store removeItem", () => {
  it("removes the item with the given id", () => {
    useLintStore.getState().addItems([makeLintResult({ page: "to-remove.md" })])
    const id = useLintStore.getState().items[0].id
    useLintStore.getState().removeItem(id)
    expect(useLintStore.getState().items).toHaveLength(0)
  })

  it("removing a non-existent id is a no-op", () => {
    useLintStore.getState().addItems([makeLintResult()])
    expect(() => useLintStore.getState().removeItem("nonexistent")).not.toThrow()
    expect(useLintStore.getState().items).toHaveLength(1)
  })

  it("only removes the item with the matching id", () => {
    useLintStore.getState().addItems([makeLintResult({ page: "keep.md" }), makeLintResult({ page: "remove.md" })])
    const ids = useLintStore.getState().items.map((i) => i.id)
    useLintStore.getState().removeItem(ids[1])
    const remaining = useLintStore.getState().items
    expect(remaining).toHaveLength(1)
    expect(remaining[0].page).toBe("keep.md")
  })
})

describe("lint-store removeItems", () => {
  it("removes all items with matching ids", () => {
    useLintStore.getState().addItems([
      makeLintResult({ page: "keep.md" }),
      makeLintResult({ page: "remove-a.md" }),
      makeLintResult({ page: "remove-b.md" }),
    ])
    const items = useLintStore.getState().items

    useLintStore.getState().removeItems([items[1].id, items[2].id])

    const remaining = useLintStore.getState().items
    expect(remaining).toHaveLength(1)
    expect(remaining[0].page).toBe("keep.md")
  })

  it("is a no-op for an empty id list", () => {
    useLintStore.getState().addItems([makeLintResult({ page: "keep.md" })])
    useLintStore.getState().removeItems([])
    expect(useLintStore.getState().items).toHaveLength(1)
  })
})

describe("lint-store clearItems", () => {
  it("removes all items", () => {
    useLintStore.getState().addItems([makeLintResult(), makeLintResult(), makeLintResult()])
    useLintStore.getState().clearItems()
    expect(useLintStore.getState().items).toHaveLength(0)
  })

  it("clearItems on already-empty store is safe", () => {
    expect(() => useLintStore.getState().clearItems()).not.toThrow()
  })
})
