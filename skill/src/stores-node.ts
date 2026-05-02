/**
 * Node.js state management replacement for React stores.
 * Replaces zustand-based stores with simple module-level state.
 *
 * Affected stores:
 *   @/stores/wiki-store       → wikiStore
 *   @/stores/research-store   → researchStore
 *   @/stores/chat-store       → chatStore
 *   @/stores/activity-store   → activityStore
 *   @/stores/review-store     → reviewStore
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmConfig {
  provider: "openai" | "anthropic" | "google" | "ollama" | "custom"
  apiKey: string
  model: string
  baseUrl?: string
}

export interface EmbeddingConfig {
  enabled: boolean
  model: string
  apiBase?: string
}

export interface SearchApiConfig {
  provider: "tavily" | "serper" | "none"
  apiKey?: string
}

export interface ReviewItem {
  id: string
  filePath: string
  content: string
  reason: string
}

// ---------------------------------------------------------------------------
// Wiki Store (replaces useWikiStore)
// ---------------------------------------------------------------------------

const _wikiState = {
  projectPath: "",
  dataVersion: 0,
  embeddingConfig: {
    enabled: false,
    model: "",
    apiBase: undefined as string | undefined,
  } as EmbeddingConfig,
  llmConfig: {
    provider: "openai" as const,
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "gpt-4o",
    baseUrl: process.env.OPENAI_API_BASE,
  } as LlmConfig,
  fileTree: [] as unknown[],
}

export const useWikiStore = {
  getState: () => ({
    ..._wikiState,
    setFileTree: (tree: unknown[]) => { _wikiState.fileTree = tree },
    bumpDataVersion: () => { _wikiState.dataVersion++ },
  }),
}

export function configureWikiStore(opts: {
  projectPath: string
  llmConfig?: Partial<LlmConfig>
  embeddingConfig?: Partial<EmbeddingConfig>
}) {
  _wikiState.projectPath = opts.projectPath
  if (opts.llmConfig) Object.assign(_wikiState.llmConfig, opts.llmConfig)
  if (opts.embeddingConfig) Object.assign(_wikiState.embeddingConfig, opts.embeddingConfig)
}

// ---------------------------------------------------------------------------
// Research Store (replaces useResearchStore)
// ---------------------------------------------------------------------------

interface ResearchTask {
  id: string
  topic: string
  status: "queued" | "searching" | "synthesizing" | "saving" | "done" | "error"
  searchQueries?: string[]
  webResults?: unknown[]
  synthesis?: string
  savedPath?: string
  error?: string
}

const _researchState = {
  tasks: [] as ResearchTask[],
  maxConcurrent: 3,
  panelOpen: false,
}

export const useResearchStore = {
  getState: () => ({
    ..._researchState,
    addTask: (topic: string) => {
      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`
      _researchState.tasks.push({ id, topic, status: "queued" })
      return id
    },
    updateTask: (id: string, updates: Partial<ResearchTask>) => {
      const task = _researchState.tasks.find((t) => t.id === id)
      if (task) Object.assign(task, updates)
    },
    getNextQueued: () => _researchState.tasks.find((t) => t.status === "queued") ?? null,
    getRunningCount: () => _researchState.tasks.filter(
      (t) => t.status === "searching" || t.status === "synthesizing" || t.status === "saving"
    ).length,
    setPanelOpen: (open: boolean) => { _researchState.panelOpen = open },
  }),
}

// ---------------------------------------------------------------------------
// Activity Store (replaces useActivityStore)
// ---------------------------------------------------------------------------

export const useActivityStore = {
  getState: () => ({
    addActivity: (msg: string) => {
      console.log(`[Activity] ${msg}`)
    },
  }),
}

// ---------------------------------------------------------------------------
// Chat Store (replaces useChatStore)
// ---------------------------------------------------------------------------

export const useChatStore = {
  getState: () => ({
    addMessage: () => {},
  }),
}

// ---------------------------------------------------------------------------
// Review Store (replaces useReviewStore)
// ---------------------------------------------------------------------------

const _reviewState = {
  items: [] as ReviewItem[],
}

export const useReviewStore = {
  getState: () => ({
    items: _reviewState.items,
    addItem: (item: ReviewItem) => { _reviewState.items.push(item) },
    removeItem: (id: string) => {
      _reviewState.items = _reviewState.items.filter((i) => i.id !== id)
    },
  }),
}
