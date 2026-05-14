import { create } from "zustand"
import type { WebSearchResult } from "@/lib/web-search"
import type { CrawledPage } from "@/lib/web-crawler"

export interface ResearchTask {
  id: string
  topic: string
  searchQueries?: string[]
  status: "queued" | "searching" | "crawling" | "synthesizing" | "saving" | "done" | "error"
  webResults: WebSearchResult[]
  synthesis: string
  savedPath: string | null
  error: string | null
  createdAt: number
  crawledPages: CrawledPage[]
  crawlProgress: { done: number; total: number } | null
  selectedUrls: Set<string>
}

interface ResearchState {
  tasks: ResearchTask[]
  panelOpen: boolean
  maxConcurrent: number

  addTask: (topic: string) => string
  updateTask: (id: string, updates: Partial<ResearchTask>) => void
  removeTask: (id: string) => void
  setPanelOpen: (open: boolean) => void
  getRunningCount: () => number
  getNextQueued: () => ResearchTask | undefined

  setCrawledPages: (id: string, pages: CrawledPage[]) => void
  appendCrawledPages: (id: string, pages: CrawledPage[]) => void
  updateCrawlProgress: (id: string, done: number, total: number) => void
  toggleUrlSelection: (id: string, url: string) => void
  selectAllSuccessful: (id: string) => void
  clearSelection: (id: string) => void
}

let counter = 0

export const useResearchStore = create<ResearchState>((set, get) => ({
  tasks: [],
  panelOpen: false,
  maxConcurrent: 3,

  addTask: (topic) => {
    const id = `research-${++counter}`
    set((state) => ({
      tasks: [
        ...state.tasks,
        {
          id,
          topic,
          status: "queued",
          webResults: [],
          synthesis: "",
          savedPath: null,
          error: null,
          createdAt: Date.now(),
          crawledPages: [],
          crawlProgress: null,
          selectedUrls: new Set(),
        },
      ],
      panelOpen: true,
    }))
    return id
  },

  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
    })),

  setPanelOpen: (panelOpen) => set({ panelOpen }),

  getRunningCount: () => {
    const { tasks } = get()
    return tasks.filter((t) =>
      t.status === "searching" || t.status === "crawling" || t.status === "synthesizing" || t.status === "saving"
    ).length
  },

  getNextQueued: () => {
    const { tasks } = get()
    return tasks.find((t) => t.status === "queued")
  },

  setCrawledPages: (id, pages) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, crawledPages: pages } : t)),
    })),

  appendCrawledPages: (id, pages) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, crawledPages: [...t.crawledPages, ...pages] } : t
      ),
    })),

  updateCrawlProgress: (id, done, total) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, crawlProgress: { done, total } } : t
      ),
    })),

  toggleUrlSelection: (id, url) =>
    set((state) => ({
      tasks: state.tasks.map((t) => {
        if (t.id !== id) return t
        const next = new Set(t.selectedUrls)
        if (next.has(url)) next.delete(url)
        else next.add(url)
        return { ...t, selectedUrls: next }
      }),
    })),

  selectAllSuccessful: (id) =>
    set((state) => ({
      tasks: state.tasks.map((t) => {
        if (t.id !== id) return t
        const urls = t.crawledPages.filter((p) => p.status === "success").map((p) => p.url)
        return { ...t, selectedUrls: new Set(urls) }
      }),
    })),

  clearSelection: (id) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, selectedUrls: new Set() } : t
      ),
    })),
}))
