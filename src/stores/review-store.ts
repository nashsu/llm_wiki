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

let counter = 0
type ReviewInput = Omit<ReviewItem, "id" | "resolved" | "createdAt">

function maxReviewCounter(items: readonly ReviewItem[]): number {
  let max = 0
  for (const item of items) {
    const match = item.id.match(/^review-(\d+)$/)
    if (!match) continue
    max = Math.max(max, Number(match[1]))
  }
  return max
}

function nextReviewId(existingItems: readonly ReviewItem[]): string {
  counter = Math.max(counter, maxReviewCounter(existingItems))
  return `review-${++counter}`
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase()
}

function reviewTitleKey(type: string, title: string): string {
  return `${type}::${normalizeReviewTitle(title)}`
}

function exactReviewKey(item: Pick<ReviewItem, "type" | "title" | "description">): string {
  return `${reviewTitleKey(item.type, item.title)}::${normalizeText(item.description)}`
}

function mergeReviewData(old: ReviewItem, incoming: ReviewInput): ReviewItem {
  const mergedPages = Array.from(new Set([...(old.affectedPages ?? []), ...(incoming.affectedPages ?? [])]))
  const mergedQueries = Array.from(new Set([...(old.searchQueries ?? []), ...(incoming.searchQueries ?? [])]))
  const optionKeys = new Set<string>()
  const mergedOptions = [...old.options, ...incoming.options].filter((option) => {
    const key = `${option.label}::${option.action}`
    if (optionKeys.has(key)) return false
    optionKeys.add(key)
    return true
  })

  return {
    ...old,
    description: incoming.description || old.description,
    sourcePath: incoming.sourcePath ?? old.sourcePath,
    affectedPages: mergedPages.length > 0 ? mergedPages : undefined,
    searchQueries: mergedQueries.length > 0 ? mergedQueries : undefined,
    options: mergedOptions,
  }
}

export const useReviewStore = create<ReviewState>((set) => ({
  items: [],

  addItem: (item) =>
    set((state) => {
      const result = [...state.items]
      const incomingKey = exactReviewKey(item)
      const existingIdx = result.findIndex((existing) =>
        !existing.resolved && exactReviewKey(existing) === incomingKey
      )

      if (existingIdx !== -1) {
        result[existingIdx] = mergeReviewData(result[existingIdx], item)
        return { items: result }
      }

      result.push({
        ...item,
        id: nextReviewId(result),
        resolved: false,
        createdAt: Date.now(),
      })
      return { items: result }
    }),

  addItems: (items) =>
    set((state) => {
      // De-dupe against pending items with same type + normalized title (all
      // 5 types — bulk ingest can re-surface the same contradiction/confirm
      // from multiple files).
      // Merge affectedPages / searchQueries / sourcePath instead of duplicating.
      const result = [...state.items]
      counter = Math.max(counter, maxReviewCounter(result))

      // Build index of existing pending items for fast lookup
      const pendingIndex = new Map<string, number>()
      result.forEach((it, idx) => {
        if (!it.resolved) {
          pendingIndex.set(reviewTitleKey(it.type, it.title), idx)
        }
      })

      for (const incoming of items) {
        const k = reviewTitleKey(incoming.type, incoming.title)
        const existingIdx = pendingIndex.get(k)

        if (existingIdx !== undefined) {
          // Merge into existing
          result[existingIdx] = mergeReviewData(result[existingIdx], incoming)
        } else {
          const newItem = {
            ...incoming,
            id: `review-${++counter}`,
            resolved: false,
            createdAt: Date.now(),
          }
          result.push(newItem)
          pendingIndex.set(k, result.length - 1)
        }
      }

      return { items: result }
    }),

  setItems: (items) => {
    counter = maxReviewCounter(items)
    set({ items })
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
