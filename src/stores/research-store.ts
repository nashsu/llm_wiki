import { create } from "zustand"
import type { WebSearchResult } from "@/lib/web-search"

export interface ResearchTask {
  id: string
  topic: string
  searchQueries?: string[]
  status: "queued" | "searching" | "synthesizing" | "saving" | "done" | "error"
  webResults: WebSearchResult[]
  synthesis: string
  savedPath: string | null
  error: string | null
  createdAt: number
}

export interface RecurringResearchTask {
  id: string
  topic: string
  intervalMs: number
  lastRunAt: number | null
  lastResultSummary: string | null
  enabled: boolean
  searchQueries?: string[]
}

interface ResearchState {
  tasks: ResearchTask[]
  recurringTasks: RecurringResearchTask[]
  panelOpen: boolean
  maxConcurrent: number

  addTask: (topic: string) => string
  updateTask: (id: string, updates: Partial<ResearchTask>) => void
  removeTask: (id: string) => void
  setPanelOpen: (open: boolean) => void
  getRunningCount: () => number
  getNextQueued: () => ResearchTask | undefined
  addRecurringTask: (topic: string, intervalMs: number, searchQueries?: string[]) => string
  removeRecurringTask: (id: string) => void
  toggleRecurringTask: (id: string) => void
  updateRecurringTaskLastRun: (id: string, summary: string) => void
}

export const useResearchStore = create<ResearchState>((set, get) => ({
  tasks: [],
  recurringTasks: [],
  panelOpen: false,
  maxConcurrent: 3,

  addTask: (topic) => {
    const id = `research-${crypto.randomUUID().slice(0, 8)}`
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
      t.status === "searching" || t.status === "synthesizing" || t.status === "saving"
    ).length
  },

  getNextQueued: () => {
    const { tasks } = get()
    return tasks.find((t) => t.status === "queued")
  },

  addRecurringTask: (topic, intervalMs, searchQueries?) => {
    const id = `recurring-${crypto.randomUUID().slice(0, 8)}`
    set((state) => ({
      recurringTasks: [
        ...state.recurringTasks,
        { id, topic, intervalMs, lastRunAt: null, lastResultSummary: null, enabled: true, searchQueries },
      ],
    }))
    return id
  },

  removeRecurringTask: (id) =>
    set((state) => ({
      recurringTasks: state.recurringTasks.filter((t) => t.id !== id),
    })),

  toggleRecurringTask: (id) =>
    set((state) => ({
      recurringTasks: state.recurringTasks.map((t) =>
        t.id === id ? { ...t, enabled: !t.enabled } : t
      ),
    })),

  updateRecurringTaskLastRun: (id, summary) =>
    set((state) => ({
      recurringTasks: state.recurringTasks.map((t) =>
        t.id === id ? { ...t, lastRunAt: Date.now(), lastResultSummary: summary } : t
      ),
    })),
}))
