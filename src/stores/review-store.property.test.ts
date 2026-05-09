/**
 * Tier 6 — property tests for review-store dedupe invariants.
 */
import { describe, it, expect, beforeEach } from "vitest"
import fc from "fast-check"
import { useReviewStore, type ReviewItem } from "./review-store"
import { normalizeReviewTitle } from "@/lib/review-utils"

beforeEach(() => {
  useReviewStore.setState({ items: [] })
})

const typeArb = fc.constantFrom<ReviewItem["type"]>(
  "contradiction",
  "duplicate",
  "missing-page",
  "confirm",
  "suggestion",
)

const reviewInputArb = fc.record({
  projectId: fc.constant("proj-1"),
  projectPath: fc.constant("/project-1"),
  type: typeArb,
  title: fc.string({ minLength: 1, maxLength: 60 }),
  description: fc.string({ maxLength: 100 }),
  options: fc.constant([]),
  affectedPages: fc.option(fc.array(fc.string(), { maxLength: 4 })),
  searchQueries: fc.option(fc.array(fc.string(), { maxLength: 4 })),
})

function key(type: string, title: string): string {
  return `${type}::${normalizeReviewTitle(title)}`
}

describe("review-store addItems — dedupe invariants", () => {
  it("after ANY sequence of addItems, pending items have unique (type, normalized title)", () => {
    fc.assert(
      fc.property(fc.array(fc.array(reviewInputArb, { maxLength: 8 }), { maxLength: 6 }), (batches) => {
        useReviewStore.setState({ items: [] })

        for (const batch of batches) {
          const input = batch.map((b) => ({
            projectId: b.projectId,
            projectPath: b.projectPath,
            type: b.type,
            title: b.title,
            description: b.description,
            options: [...b.options],
            affectedPages: b.affectedPages ? [...b.affectedPages] : undefined,
            searchQueries: b.searchQueries ? [...b.searchQueries] : undefined,
          }))
          useReviewStore.getState().addItems(input)
        }

        const pending = useReviewStore.getState().items.filter((i) => !i.resolved)
        const keys = pending.map((i) => key(i.type, i.title))
        const unique = new Set(keys)
        expect(unique.size).toBe(keys.length)
      }),
    )
  })

  it("merge preserves the union of affectedPages across duplicates", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        typeArb,
        fc.array(fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }), { minLength: 2, maxLength: 5 }),
        (title, type, affectedBatches) => {
          useReviewStore.setState({ items: [] })

          for (const pages of affectedBatches) {
            useReviewStore.getState().addItems([
              {
                projectId: "proj-1",
                projectPath: "/project-1",
                type,
                title,
                description: "",
                options: [],
                affectedPages: pages.length > 0 ? pages : undefined,
              },
            ])
          }

          const pending = useReviewStore.getState().items.filter((i) => !i.resolved)
          // Only one item for this (type, title)
          expect(pending.length).toBe(1)

          const allExpectedPages = new Set(affectedBatches.flat())
          const actualPages = new Set(pending[0].affectedPages ?? [])
          expect(actualPages).toEqual(allExpectedPages)
        },
      ),
    )
  })

  it("resolveItem always makes resolved item eligible for a NEW pending item of same key", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        typeArb,
        (title, type) => {
          useReviewStore.setState({ items: [] })

          useReviewStore.getState().addItems([
            { projectId: "proj-1", projectPath: "/project-1", type, title, description: "", options: [], affectedPages: ["first.md"] },
          ])
          const firstId = useReviewStore.getState().items[0].id
          useReviewStore.getState().resolveItem(firstId, "auto-resolved")

          useReviewStore.getState().addItems([
            { projectId: "proj-1", projectPath: "/project-1", type, title, description: "", options: [], affectedPages: ["second.md"] },
          ])

          const all = useReviewStore.getState().items
          expect(all.length).toBe(2)
          expect(all.filter((i) => i.resolved)).toHaveLength(1)
          expect(all.filter((i) => !i.resolved)).toHaveLength(1)
        },
      ),
    )
  })
})
