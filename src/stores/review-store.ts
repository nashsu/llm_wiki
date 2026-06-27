import { create } from "zustand"
import { normalizeReviewTitle } from "@/lib/review-utils"

export interface ReviewOption {
  label: string
  action: string // identifier for the action
}

export interface ReviewItem {
  id: string
  type: "contradiction" | "duplicate" | "missing-page" | "confirm" | "suggestion"
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

interface ReviewState {
  items: ReviewItem[]
  addItem: (item: Omit<ReviewItem, "id" | "resolved" | "createdAt">) => void
  addItems: (items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]) => void
  setItems: (items: ReviewItem[]) => void
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  clearResolved: () => void
}

/**
 * Content-derived stable id. The SAME logical review (same type + same
 * normalized title) always gets the SAME id, so it survives ingest
 * regeneration, file moves, and reloads — and an external caller (the
 * resolve API) can target it reliably.
 *
 * Deliberately NOT counter-based (the old `review-N` scheme re-numbered
 * every review whenever the queue rebuilt, discarding resolved state)
 * and deliberately NOT keyed on sourcePath (mutable — a file rename
 * would re-id the review, the exact instability we're removing).
 *
 * "Collision" — two inputs sharing an id — is the intended behaviour:
 * identical content is the same review. Stability is bounded by
 * `normalizeReviewTitle` across LLM regenerations, the same ceiling the
 * previous dedup already accepted.
 */
export function reviewIdFor(item: Pick<ReviewItem, "type" | "title">): string {
  const key = `${item.type}::${normalizeReviewTitle(item.title)}`
  // FNV-1a (32-bit) — small, deterministic, dependency-free.
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `review-${(h >>> 0).toString(16).padStart(8, "0")}`
}

/** Union two optional string arrays, dropping the field when empty. */
function unionField(a?: string[], b?: string[]): string[] | undefined {
  const merged = Array.from(new Set([...(a ?? []), ...(b ?? [])]))
  return merged.length > 0 ? merged : undefined
}

/**
 * Collapse two items that resolved to the same stable id. resolved
 * wins (if either was resolved, the survivor is), union the array
 * fields, keep the earliest createdAt, prefer a non-empty description.
 */
function mergeReviewItems(a: ReviewItem, b: ReviewItem): ReviewItem {
  return {
    ...a, // a.id is kept; both share it by construction
    resolved: a.resolved || b.resolved,
    resolvedAction: a.resolved ? a.resolvedAction : b.resolved ? b.resolvedAction : a.resolvedAction,
    description: a.description || b.description,
    sourcePath: a.sourcePath ?? b.sourcePath,
    affectedPages: unionField(a.affectedPages, b.affectedPages),
    searchQueries: unionField(a.searchQueries, b.searchQueries),
    createdAt: Math.min(a.createdAt, b.createdAt),
  }
}

export const useReviewStore = create<ReviewState>((set) => ({
  items: [],

  addItem: (item) =>
    set((state) => {
      const id = reviewIdFor(item)
      // Same-content item already present (possibly resolved) → keep it
      // as-is so resolved state survives. The stable id makes this a
      // simple identity check, no separate dedup key.
      if (state.items.some((it) => it.id === id)) {
        return { items: state.items }
      }
      return {
        items: [...state.items, { ...item, id, resolved: false, createdAt: Date.now() }],
      }
    }),

  addItems: (items) =>
    set((state) => {
      // Dedup on the content-stable id against ALL existing items —
      // including resolved ones. The previous scheme only deduped
      // against *pending* items, which is exactly why re-surfacing a
      // review during ingest discarded its resolved state. Now a
      // resolved review with the same content is preserved (resolved
      // wins), with array fields merged.
      const result = [...state.items]
      const indexById = new Map<string, number>()
      result.forEach((it, idx) => indexById.set(it.id, idx))

      for (const incoming of items) {
        const id = reviewIdFor(incoming)
        const existingIdx = indexById.get(id)

        if (existingIdx !== undefined) {
          const old = result[existingIdx]
          result[existingIdx] = {
            ...old, // preserves resolved / resolvedAction / createdAt / id
            description: incoming.description || old.description,
            sourcePath: incoming.sourcePath ?? old.sourcePath,
            affectedPages: unionField(old.affectedPages, incoming.affectedPages),
            searchQueries: unionField(old.searchQueries, incoming.searchQueries),
          }
        } else {
          result.push({ ...incoming, id, resolved: false, createdAt: Date.now() })
          indexById.set(id, result.length - 1)
        }
      }

      return { items: result }
    }),

  setItems: (items) => {
    // Migrate-on-load: remap every item to its content-stable id,
    // collapsing any that share one. Old counter ids (review-N) and
    // their resolved state are folded in here (resolved wins), so a
    // resolved review keeps its resolution across the id-scheme change.
    // Computing the id from content (not the old id) makes this
    // idempotent — no migration-version flag needed.
    const byId = new Map<string, ReviewItem>()
    for (const raw of items) {
      const remapped: ReviewItem = { ...raw, id: reviewIdFor(raw) }
      const existing = byId.get(remapped.id)
      byId.set(remapped.id, existing ? mergeReviewItems(existing, remapped) : remapped)
    }
    set({ items: [...byId.values()] })
  },

  resolveItem: (id, action) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, resolved: true, resolvedAction: action } : item
      ),
    })),

  dismissItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  clearResolved: () =>
    set((state) => ({
      items: state.items.filter((item) => !item.resolved),
    })),
}))
