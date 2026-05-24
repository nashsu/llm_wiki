import { create } from "zustand"
import { normalizeReviewTitle } from "@/lib/review-utils"

/** Compute priority score for a review item based on type and metadata */
function computePriority(item: Omit<ReviewItem, "id" | "resolved" | "createdAt" | "priority">): number {
  let base: number
  switch (item.type) {
    case "contradiction":
      base = 90
      break
    case "missing-page":
      base = 50
      break
    case "duplicate":
      base = 40
      break
    case "confirm":
      base = 30
      break
    case "suggestion":
      base = 20
      break
    default:
      base = 10
  }
  // Bonus for more affected pages (wider impact)
  base += Math.min((item.affectedPages?.length ?? 0) * 5, 20)
  // Bonus for having search queries (actionable)
  base += Math.min((item.searchQueries?.length ?? 0) * 3, 15)
  return base
}

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
  /** Computed priority score: higher = more urgent */
  priority?: number
}

interface ReviewState {
  items: ReviewItem[]
  addItem: (item: Omit<ReviewItem, "id" | "resolved" | "createdAt" | "priority">) => void
  addItems: (items: Omit<ReviewItem, "id" | "resolved" | "createdAt" | "priority">[]) => void
  setItems: (items: ReviewItem[]) => void
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  clearResolved: () => void
  /** Get pending items sorted by priority (highest first) */
  getSortedItems: () => ReviewItem[]
}

export const useReviewStore = create<ReviewState>((set) => ({
  items: [],

  addItem: (item) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          ...item,
          id: `review-${crypto.randomUUID().slice(0, 8)}`,
          resolved: false,
          createdAt: Date.now(),
          priority: computePriority(item),
        },
      ],
    })),

  addItems: (items) =>
    set((state) => {
      // De-dupe against pending items with same type + normalized title (all
      // 5 types — bulk ingest can re-surface the same contradiction/confirm
      // from multiple files).
      // Merge affectedPages / searchQueries / sourcePath instead of duplicating.
      const result = [...state.items]
      const keyFor = (t: string, title: string) => `${t}::${normalizeReviewTitle(title)}`

      // Build index of existing pending items for fast lookup
      const pendingIndex = new Map<string, number>()
      result.forEach((it, idx) => {
        if (!it.resolved) {
          pendingIndex.set(keyFor(it.type, it.title), idx)
        }
      })

      for (const incoming of items) {
        const k = keyFor(incoming.type, incoming.title)
        const existingIdx = pendingIndex.get(k)

        if (existingIdx !== undefined) {
          // Merge into existing
          const old = result[existingIdx]
          const mergedPages = Array.from(new Set([...(old.affectedPages ?? []), ...(incoming.affectedPages ?? [])]))
          const mergedQueries = Array.from(new Set([...(old.searchQueries ?? []), ...(incoming.searchQueries ?? [])]))
          result[existingIdx] = {
            ...old,
            description: incoming.description || old.description, // prefer newer description
            sourcePath: incoming.sourcePath ?? old.sourcePath,
            affectedPages: mergedPages.length > 0 ? mergedPages : undefined,
            searchQueries: mergedQueries.length > 0 ? mergedQueries : undefined,
          }
        } else {
          const newItem = {
            ...incoming,
            id: `review-${crypto.randomUUID().slice(0, 8)}`,
            resolved: false,
            createdAt: Date.now(),
            priority: computePriority(incoming),
          }
          result.push(newItem)
          pendingIndex.set(k, result.length - 1)
        }
      }

      return { items: result }
    }),

  setItems: (items) => set({ items }),

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

  getSortedItems: (): ReviewItem[] => {
    const items: ReviewItem[] = useReviewStore.getState().items
    return items
      .filter((item: ReviewItem) => !item.resolved)
      .sort((a: ReviewItem, b: ReviewItem) => (b.priority ?? 0) - (a.priority ?? 0))
  },
}))
