/**
 * Node.js drop-in for React zustand stores used by nashsu/llm_wiki lib files.
 * Replaces all useXxxStore.getState() calls with module-level state.
 */

export interface LlmConfig {
  provider: string
  apiKey: string
  model: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
}

export interface EmbeddingConfig {
  enabled: boolean
  model: string
  apiBase?: string
  apiKey?: string
}

interface WikiState {
  projectPath: string
  dataVersion: number
  llmConfig: LlmConfig
  embeddingConfig: EmbeddingConfig
}

let wikiState: WikiState = {
  projectPath: "",
  dataVersion: 0,
  llmConfig: {
    provider: process.env.LLM_PROVIDER ?? "openai",
    apiKey: process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    baseUrl: process.env.LLM_BASE_URL,
  },
  embeddingConfig: {
    enabled: (process.env.EMBEDDING_ENABLED ?? "false") === "true",
    model: process.env.EMBEDDING_MODEL ?? "",
    apiBase: process.env.EMBEDDING_BASE_URL,
    apiKey: process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY,
  },
}

export const useWikiStore = {
  getState: () => ({ ...wikiState }),
  setState: (updater: Partial<WikiState> | ((s: WikiState) => Partial<WikiState>)) => {
    if (typeof updater === "function") {
      wikiState = { ...wikiState, ...updater(wikiState) }
    } else {
      wikiState = { ...wikiState, ...updater }
    }
  },
}

/** Configure the wiki store from environment variables or explicit config */
export function configureWikiStore(config: Partial<WikiState>) {
  wikiState = { ...wikiState, ...config }
}

// ── Research store ───────────────────────────────────────────────────────────
interface ResearchState {
  activeProjectPath: string
  isResearching: boolean
}

let researchState: ResearchState = {
  activeProjectPath: "",
  isResearching: false,
}

export const useResearchStore = {
  getState: () => ({ ...researchState }),
  setState: (updater: Partial<ResearchState>) => {
    researchState = { ...researchState, ...updater }
  },
}

// ── Activity store (replaces Tauri event system) ─────────────────────────────
export interface ActivityItem {
  id: string
  type: string
  title: string
  status: "pending" | "running" | "done" | "error"
  detail?: string
  filesWritten?: string[]
}

let activityItems: ActivityItem[] = []
let activityIdCounter = 0

export const useActivityStore = {
  getState: () => ({
    items: [...activityItems],
    addItem: (item: Omit<ActivityItem, "id">): string => {
      const id = `activity-${++activityIdCounter}`
      const newItem: ActivityItem = { id, ...item }
      activityItems.push(newItem)
      if (process.env.SKILL_VERBOSE === "1") {
        console.error(`[activity:${item.type}] ${item.title} — ${item.status}`)
      }
      return id
    },
    updateItem: (id: string, updates: Partial<ActivityItem>): void => {
      const idx = activityItems.findIndex((i) => i.id === id)
      if (idx >= 0) {
        activityItems[idx] = { ...activityItems[idx], ...updates }
        if (process.env.SKILL_VERBOSE === "1") {
          const item = activityItems[idx]
          console.error(`[activity:update] ${item.title} — ${item.status}: ${item.detail ?? ""}`)
        }
      }
    },
    clearItems: () => { activityItems = [] },
  }),
  addItem: (item: Omit<ActivityItem, "id">): string => {
    return useActivityStore.getState().addItem(item)
  },
  updateItem: (id: string, updates: Partial<ActivityItem>): void => {
    useActivityStore.getState().updateItem(id, updates)
  },
}

// ── Chat store ───────────────────────────────────────────────────────────────
export const useChatStore = {
  getState: () => ({ messages: [] as unknown[] }),
  setState: (_updater: unknown) => {},
}

// ── Review store ─────────────────────────────────────────────────────────────
export const useReviewStore = {
  getState: () => ({ queue: [] as unknown[], isProcessing: false }),
  setState: (_updater: unknown) => {},
}
