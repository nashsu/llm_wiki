import { create } from "zustand"
import type { WebSearchResult } from "@/lib/web-search"

export interface ResearchTask {
  id: string
  projectId: string
  projectPath: string
  topic: string
  searchQueries?: string[]
  status: "queued" | "searching" | "synthesizing" | "saving" | "done" | "error"
  webResults: WebSearchResult[]
  synthesis: string
  savedPath: string | null
  error: string | null
  createdAt: number
}

interface ResearchState {
  tasks: ResearchTask[]
  panelOpen: boolean
  maxConcurrent: number

  addTask: (topic: string, projectId: string, projectPath: string) => string
  updateTask: (id: string, updates: Partial<ResearchTask>) => void
  removeTask: (id: string) => void
  clearFinished: () => void
  setPanelOpen: (open: boolean) => void
  getRunningCount: () => number
  getNextQueued: () => ResearchTask | undefined
}

let counter = 0

export const useResearchStore = create<ResearchState>((set, get) => ({
  tasks: [],
  panelOpen: false,
  maxConcurrent: 3,

  addTask: (topic, projectId, projectPath) => {
    const id = `research-${++counter}`
    set((state) => ({
      tasks: [
        ...state.tasks,
        {
          id,
          projectId,
          projectPath,
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

  clearFinished: () =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.status !== "done" && t.status !== "error"),
    })),

  setPanelOpen: (panelOpen) => set({ panelOpen }),

  getRunningCount: () => {
    const { tasks } = get()
    return tasks.filter((t) =>
      t.status === "searching" || t.status === "synthesizing" || t.status === "saving",
    ).length
  },

  getNextQueued: () => {
    const { tasks } = get()
    return tasks.find((t) => t.status === "queued")
  },
}))
