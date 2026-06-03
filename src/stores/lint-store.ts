import { create } from "zustand"
import type { LintResult } from "@/lib/lint"

export interface LintItem {
  id: string
  type: LintResult["type"]
  severity: LintResult["severity"]
  page: string
  detail: string
  affectedPages?: string[]
  createdAt: number
  source?: "manual" | "agent"
}

export type AgentLintStatus = "idle" | "queued" | "running" | "done" | "failed"

export interface AgentLintState {
  status: AgentLintStatus
  paths: string[]
  error?: string
  updatedAt?: number
}

function lintResultToItem(
  result: LintResult,
  source: LintItem["source"] = "manual",
): LintItem {
  return {
    type: result.type,
    severity: result.severity,
    page: result.page,
    detail: result.detail,
    affectedPages: result.affectedPages,
    source,
    id: `lint-${++counter}`,
    createdAt: Date.now(),
  }
}

function syncCounterFromItems(items: readonly LintItem[]): void {
  for (const item of items) {
    const match = /^lint-(\d+)$/.exec(item.id)
    if (!match) continue
    const idNumber = Number(match[1])
    if (Number.isFinite(idNumber) && idNumber > counter) {
      counter = idNumber
    }
  }
}

interface LintState {
  items: LintItem[]
  agentLint: AgentLintState
  setItems: (items: LintItem[]) => void
  addItems: (results: LintResult[], source?: LintItem["source"]) => void
  replaceAgentItems: (results: LintResult[]) => void
  removeItem: (id: string) => void
  clearItems: () => void
  setAgentLintState: (state: AgentLintState) => void
}

let counter = 0

export const useLintStore = create<LintState>((set) => ({
  items: [],
  agentLint: {
    status: "idle",
    paths: [],
  },

  setItems: (items) => {
    syncCounterFromItems(items)
    set({ items })
  },

  addItems: (results, source = "manual") =>
    set((state) => ({
      items: [...state.items, ...results.map((result) => lintResultToItem(result, source))],
    })),

  replaceAgentItems: (results) =>
    set((state) => ({
      items: [
        ...state.items.filter((item) => item.source !== "agent"),
        ...results.map((result) => lintResultToItem(result, "agent")),
      ],
    })),

  removeItem: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),

  clearItems: () => set({ items: [] }),

  setAgentLintState: (agentLint) => set({ agentLint }),
}))
