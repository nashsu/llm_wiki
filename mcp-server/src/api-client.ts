export const DEFAULT_API_BASE_URL = "http://127.0.0.1:19828"

export interface LlmWikiApiClientOptions {
  baseUrl?: string
  token?: string
  fetchImpl?: typeof fetch
}

export interface ApiProject {
  id: string
  name: string
  path: string
  current: boolean
}

export interface ApiFileNode {
  name: string
  path: string
  isDir: boolean
  children?: ApiFileNode[]
}

export interface ApiSearchResult {
  path: string
  title: string
  snippet: string
  score: number
  titleMatch?: boolean
  images?: Array<{ url: string; alt: string }>
  vectorScore?: number | null
}

export interface ApiSearchResponse {
  results: ApiSearchResult[]
  mode?: string
  tokenHits?: number
  vectorHits?: number
}

export interface ApiChatReference {
  title: string
  path: string
  kind: string
  snippet?: string
  score?: number
}

export interface ApiChatToolEvent {
  tool: string
  status: string
  detail?: string
}

export interface ApiChatEvent {
  type: string
  [key: string]: unknown
}

export interface ApiChatUsage {
  promptChars?: number
  completionChars?: number
  referenceCount?: number
  toolEventCount?: number
}

export interface ApiChatResponse {
  projectId?: string
  sessionId: string
  mode?: string
  message: {
    role: string
    content: string
  }
  references: ApiChatReference[]
  toolEvents: ApiChatToolEvent[]
  events: ApiChatEvent[]
  usage?: ApiChatUsage
}

export interface ApiGraphNode {
  id: string
  label: string
  type: string
  path?: string
  linkCount?: number
  weight?: number
}

export interface ApiGraphEdge {
  source: string
  target: string
  weight?: number
}

export type ApiReviewStatus = "unresolved" | "resolved" | "all"

export interface ApiReviewOption {
  label: string
  action: string
}

export interface ApiReviewItem {
  id: string
  type: string
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ApiReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

export interface ApiReviewsResponse {
  projectId?: string
  status: ApiReviewStatus
  count: number
  reviews: ApiReviewItem[]
}

export interface ApiFilesResponse {
  files: ApiFileNode[]
  truncated?: boolean
}

export interface ApiHealth {
  ok?: boolean
  status?: string
  enabled?: boolean
  mcpEnabled?: boolean
  authRequired?: boolean
  authConfigured?: boolean
  allowUnauthenticated?: boolean
  tokenSource?: string
  [key: string]: unknown
}

export function normalizeBaseUrl(value?: string): string {
  const raw = (value ?? DEFAULT_API_BASE_URL).trim() || DEFAULT_API_BASE_URL
  return raw.replace(/\/+$/, "")
}

function apiPath(path: string): string {
  return path.startsWith("/api/v1") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected JSON object`)
  }
  return value as Record<string, unknown>
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export class LlmWikiApiClient {
  private readonly baseUrl: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: LlmWikiApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.LLM_WIKI_API_BASE_URL)
    this.token = options.token ?? process.env.LLM_WIKI_API_TOKEN
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async health(): Promise<ApiHealth> {
    return this.request("/health", { auth: false }) as Promise<ApiHealth>
  }

  async projects(): Promise<{ projects: ApiProject[]; currentProject: ApiProject | null }> {
    const json = await this.request("/projects")
    const projects = Array.isArray(json.projects) ? json.projects.map(parseProject) : []
    const currentProject = json.currentProject ? parseProject(json.currentProject) : null
    return { projects, currentProject }
  }

  async files(projectId = "current", options: { root?: "wiki" | "sources" | "all"; recursive?: boolean; maxFiles?: number } = {}): Promise<ApiFilesResponse> {
    const params = new URLSearchParams()
    params.set("root", options.root ?? "wiki")
    if (options.recursive !== undefined) params.set("recursive", String(options.recursive))
    if (options.maxFiles !== undefined) params.set("maxFiles", String(options.maxFiles))
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/files?${params.toString()}`)
    return {
      files: Array.isArray(json.files) ? json.files.map(parseFileNode) : [],
      truncated: json.truncated === true,
    }
  }

  async fileContent(projectId = "current", path: string): Promise<{ path: string; content: string }> {
    const params = new URLSearchParams({ path })
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/files/content?${params.toString()}`)
    return {
      path: typeof json.path === "string" ? json.path : path,
      content: typeof json.content === "string" ? json.content : "",
    }
  }

  async reviews(projectId = "current", options: { status?: ApiReviewStatus; type?: string; limit?: number } = {}): Promise<ApiReviewsResponse> {
    const params = new URLSearchParams()
    if (options.status) params.set("status", options.status)
    if (options.type) params.set("type", options.type)
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    const suffix = params.toString() ? `?${params.toString()}` : ""
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/reviews${suffix}`)
    const reviews = Array.isArray(json.reviews) ? json.reviews.map(parseReviewItem) : []
    return {
      projectId: typeof json.projectId === "string" ? json.projectId : undefined,
      status: parseReviewStatus(json.status),
      count: numberOrUndefined(json.count) ?? reviews.length,
      reviews,
    }
  }

  async search(projectId = "current", query: string, options: { topK?: number; includeContent?: boolean } = {}): Promise<ApiSearchResponse> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/search`, {
      method: "POST",
      body: {
        query,
        topK: options.topK,
        includeContent: options.includeContent,
      },
    })
    return {
      results: Array.isArray(json.results) ? json.results.map(parseSearchResult) : [],
      mode: typeof json.mode === "string" ? json.mode : undefined,
      tokenHits: numberOrUndefined(json.tokenHits),
      vectorHits: numberOrUndefined(json.vectorHits),
    }
  }

  async chat(projectId = "current", message: string, options: { sessionId?: string; mode?: string; topK?: number; includeContent?: boolean; wiki?: boolean; web?: boolean; anytxt?: boolean; skills?: string[]; persistSession?: boolean } = {}): Promise<ApiChatResponse> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/chat`, {
      method: "POST",
      body: {
        message,
        sessionId: options.sessionId,
        persistSession: options.persistSession,
        mode: options.mode,
        topK: options.topK,
        includeContent: options.includeContent,
        tools: {
          wiki: options.wiki ?? true,
          web: options.web ?? false,
          anytxt: options.anytxt ?? false,
        },
        skills: options.skills,
      },
    })
    const msg = requireObject(json.message, "chat message")
    return {
      projectId: typeof json.projectId === "string" ? json.projectId : undefined,
      sessionId: typeof json.sessionId === "string" ? json.sessionId : "",
      mode: typeof json.mode === "string" ? json.mode : undefined,
      message: {
        role: typeof msg.role === "string" ? msg.role : "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
      },
      references: Array.isArray(json.references) ? json.references.map(parseChatReference) : [],
      toolEvents: Array.isArray(json.toolEvents) ? json.toolEvents.map(parseChatToolEvent) : [],
      events: Array.isArray(json.events) ? json.events.map(parseChatEvent) : [],
      usage: parseChatUsage(json.usage),
    }
  }

  async cancelChat(projectId = "current", sessionId: string): Promise<{ sessionId: string; cancelled: boolean }> {
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
    })
    return {
      sessionId: typeof json.sessionId === "string" ? json.sessionId : sessionId,
      cancelled: json.cancelled === true,
    }
  }

  async graph(projectId = "current", options: { q?: string; nodeType?: string; limit?: number } = {}): Promise<{ nodes: ApiGraphNode[]; edges: ApiGraphEdge[] }> {
    const params = new URLSearchParams()
    if (options.q) params.set("q", options.q)
    if (options.nodeType) params.set("nodeType", options.nodeType)
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    const suffix = params.toString() ? `?${params.toString()}` : ""
    const json = await this.request(`/projects/${encodeURIComponent(projectId)}/graph${suffix}`)
    return {
      nodes: Array.isArray(json.nodes) ? json.nodes.map(parseGraphNode) : [],
      edges: Array.isArray(json.edges) ? json.edges.map(parseGraphEdge) : [],
    }
  }

  async rescan(projectId = "current"): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/sources/rescan`, {
      method: "POST",
    })
  }

  private async request(path: string, options: { method?: "GET" | "POST"; body?: unknown; auth?: boolean } = {}): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${apiPath(path)}`
    const headers: Record<string, string> = { Accept: "application/json" }
    if (options.auth !== false && this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json"

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch (err) {
      throw new Error(`LLM Wiki API request failed. Is the desktop app running? ${err instanceof Error ? err.message : String(err)}`)
    }

    const text = await response.text()
    let json: Record<string, unknown>
    try {
      json = text ? requireObject(JSON.parse(text), "LLM Wiki API response") : {}
    } catch (err) {
      throw new Error(`LLM Wiki API returned non-JSON response (${response.status}): ${text.slice(0, 300)}${err instanceof Error ? ` (${err.message})` : ""}`)
    }

    if (!response.ok || json.ok === false) {
      const message = typeof json.error === "string" ? json.error : response.statusText
      throw new Error(`LLM Wiki API ${response.status}: ${message}`)
    }
    return json
  }
}

function parseProject(value: unknown): ApiProject {
  const obj = requireObject(value, "project")
  return {
    id: String(obj.id ?? ""),
    name: String(obj.name ?? ""),
    path: String(obj.path ?? ""),
    current: obj.current === true,
  }
}

function parseFileNode(value: unknown): ApiFileNode {
  const obj = requireObject(value, "file node")
  const children = Array.isArray(obj.children) ? obj.children.map(parseFileNode) : undefined
  return {
    name: String(obj.name ?? ""),
    path: String(obj.path ?? ""),
    isDir: obj.isDir === true || obj.is_dir === true,
    ...(children ? { children } : {}),
  }
}

function parseSearchResult(value: unknown): ApiSearchResult {
  const obj = requireObject(value, "search result")
  return {
    path: String(obj.path ?? ""),
    title: String(obj.title ?? ""),
    snippet: String(obj.snippet ?? ""),
    score: numberOrUndefined(obj.score) ?? 0,
    titleMatch: obj.titleMatch === true,
    images: Array.isArray(obj.images) ? obj.images.map((image) => {
      const item = requireObject(image, "image")
      return { url: String(item.url ?? ""), alt: String(item.alt ?? "") }
    }) : [],
    vectorScore: numberOrUndefined(obj.vectorScore) ?? null,
  }
}

function parseChatReference(value: unknown): ApiChatReference {
  const obj = requireObject(value, "chat reference")
  return {
    title: String(obj.title ?? ""),
    path: String(obj.path ?? ""),
    kind: String(obj.kind ?? "wiki"),
    snippet: typeof obj.snippet === "string" ? obj.snippet : undefined,
    score: numberOrUndefined(obj.score),
  }
}

function parseChatToolEvent(value: unknown): ApiChatToolEvent {
  const obj = requireObject(value, "chat tool event")
  return {
    tool: String(obj.tool ?? ""),
    status: String(obj.status ?? ""),
    detail: typeof obj.detail === "string" ? obj.detail : undefined,
  }
}

function parseChatEvent(value: unknown): ApiChatEvent {
  const obj = requireObject(value, "chat event")
  return {
    ...obj,
    type: String(obj.type ?? ""),
  }
}

function parseChatUsage(value: unknown): ApiChatUsage | undefined {
  if (value === undefined || value === null) return undefined
  const obj = requireObject(value, "chat usage")
  return {
    promptChars: numberOrUndefined(obj.promptChars),
    completionChars: numberOrUndefined(obj.completionChars),
    referenceCount: numberOrUndefined(obj.referenceCount),
    toolEventCount: numberOrUndefined(obj.toolEventCount),
  }
}

function parseReviewStatus(value: unknown): ApiReviewStatus {
  return value === "resolved" || value === "all" ? value : "unresolved"
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => String(item))
}

function parseReviewItem(value: unknown): ApiReviewItem {
  const obj = requireObject(value, "review item")
  return {
    id: String(obj.id ?? ""),
    type: String(obj.type ?? ""),
    title: String(obj.title ?? ""),
    description: String(obj.description ?? ""),
    sourcePath: typeof obj.sourcePath === "string" ? obj.sourcePath : undefined,
    affectedPages: stringArray(obj.affectedPages),
    searchQueries: stringArray(obj.searchQueries),
    options: Array.isArray(obj.options) ? obj.options.map((option) => {
      const item = requireObject(option, "review option")
      return { label: String(item.label ?? ""), action: String(item.action ?? "") }
    }) : [],
    resolved: obj.resolved === true,
    resolvedAction: typeof obj.resolvedAction === "string" ? obj.resolvedAction : undefined,
    createdAt: numberOrUndefined(obj.createdAt) ?? 0,
  }
}

function parseGraphNode(value: unknown): ApiGraphNode {
  const obj = requireObject(value, "graph node")
  return {
    id: String(obj.id ?? ""),
    label: String(obj.label ?? ""),
    type: String(obj.nodeType ?? obj.type ?? "other"),
    path: typeof obj.path === "string" ? obj.path : undefined,
    linkCount: numberOrUndefined(obj.linkCount),
    weight: numberOrUndefined(obj.weight),
  }
}

function parseGraphEdge(value: unknown): ApiGraphEdge {
  const obj = requireObject(value, "graph edge")
  return {
    source: String(obj.source ?? ""),
    target: String(obj.target ?? ""),
    weight: numberOrUndefined(obj.weight),
  }
}
