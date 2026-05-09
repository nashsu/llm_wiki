import { copyFile, createDirectory, fileExists, listDirectory, preprocessFile, writeFile } from "@/commands/fs"
import { buildChatRetrievalContext } from "@/lib/chat-retrieval"
import { searchWiki } from "@/lib/search"
import { buildWikiGraph } from "@/lib/wiki-graph"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { enqueueIngest } from "@/lib/ingest-queue"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

const API_BASE = "http://127.0.0.1:19827/api/v1"
const POLL_INTERVAL = 500
export const MCP_ACCESS_DISABLED_ERROR = "MCP access is disabled in Settings."

export interface BridgeRequest {
  id: string
  endpoint: string
  payload: Record<string, unknown>
}

let intervalId: ReturnType<typeof setInterval> | null = null
let polling = false

export function startLocalApiBridge() {
  if (intervalId) return
  intervalId = setInterval(() => {
    void pollBridge()
  }, POLL_INTERVAL)
  void pollBridge()
}

export function stopLocalApiBridge() {
  if (!intervalId) return
  clearInterval(intervalId)
  intervalId = null
}

async function pollBridge(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const res = await fetch(`${API_BASE}/bridge/pending`, { method: "GET" })
    const data = await res.json() as { ok?: boolean; requests?: BridgeRequest[] }
    if (!data.ok || !Array.isArray(data.requests) || data.requests.length === 0) return

    for (const request of data.requests) {
      await handleBridgeRequest(request)
    }
  } catch {
    // The local server may not be up yet or may be an older release.
  } finally {
    polling = false
  }
}

export async function handleBridgeRequest(request: BridgeRequest): Promise<void> {
  try {
    if (!useWikiStore.getState().mcpAccessEnabled) {
      throw new Error(MCP_ACCESS_DISABLED_ERROR)
    }
    const result = await handleRequest(request.endpoint, request.payload ?? {})
    await postBridgeResponse(request.id, true, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await postBridgeResponse(request.id, false, message)
  }
}

async function postBridgeResponse(id: string, ok: boolean, payload: unknown): Promise<void> {
  await fetch(`${API_BASE}/bridge/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload }),
  }).catch(() => {})
}

async function handleRequest(endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
  switch (endpoint) {
    case "search":
      return handleSearch(payload)
    case "retrieve":
      return handleRetrieve(payload)
    case "chat":
      return handleChat(payload)
    case "graph":
      return handleGraph(payload)
    case "ingest/file":
      return handleIngestFile(payload)
    case "ingest/clip":
      return handleIngestClip(payload)
    default:
      throw new Error(`Unsupported local API endpoint: ${endpoint}`)
  }
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === "string" ? value : ""
}

function getProject(payload: Record<string, unknown>) {
  const explicit = stringField(payload, "projectPath")
  const active = useWikiStore.getState().project
  const path = normalizePath(explicit || active?.path || "")
  if (!path) throw new Error("No projectPath provided and no active LLM Wiki project is open.")

  return {
    id: active?.path && normalizePath(active.path) === path ? active.id : "",
    name: active?.path && normalizePath(active.path) === path
      ? active.name
      : getFileName(path) || "LLM Wiki Project",
    path,
    isActive: !!active?.path && normalizePath(active.path) === path,
  }
}

async function handleSearch(payload: Record<string, unknown>) {
  const query = stringField(payload, "query").trim()
  if (!query) throw new Error("query is required")
  const limit = numberOrDefault(payload.limit, 20)
  const project = getProject(payload)
  const results = await searchWiki(project.path, query)
  return {
    projectPath: project.path,
    query,
    results: results.slice(0, limit),
  }
}

async function handleRetrieve(payload: Record<string, unknown>) {
  const query = stringField(payload, "query").trim()
  if (!query) throw new Error("query is required")
  const limit = numberOrDefault(payload.limit, 10)
  const includeContent = payload.includeContent !== false
  const project = getProject(payload)
  const store = useWikiStore.getState()
  const retrieval = await buildChatRetrievalContext({
    project,
    query,
    llmConfig: store.llmConfig,
    dataVersion: store.dataVersion,
    searchLimit: limit,
    pageLimit: limit,
  })

  return {
    projectPath: project.path,
    query,
    references: retrieval.references,
    pages: retrieval.relevantPages.map((page) => includeContent ? page : { ...page, content: undefined }),
    searchResults: retrieval.searchResults.slice(0, limit),
    graphExpansions: retrieval.graphExpansions.slice(0, limit),
    budget: retrieval.budget,
    outputLanguage: retrieval.outputLanguage,
    greetingOnly: retrieval.greetingOnly,
  }
}

async function handleChat(payload: Record<string, unknown>) {
  const query = stringField(payload, "query").trim()
  if (!query) throw new Error("query is required")
  const project = getProject(payload)
  const store = useWikiStore.getState()
  if (!hasUsableLlm(store.llmConfig)) {
    throw new Error("LLM not configured -- set API key and model in Settings.")
  }

  const maxHistoryMessages = numberOrDefault(payload.maxHistoryMessages, 10)
  const retrieval = await buildChatRetrievalContext({
    project,
    query,
    llmConfig: store.llmConfig,
    dataVersion: store.dataVersion,
  })

  const history = normalizeHistory(payload.messages).slice(-maxHistoryMessages)
  const finalUserContent = retrieval.langReminder
    ? `[${retrieval.langReminder}]\n\n${query}`
    : query
  const llmMessages: LLMMessage[] = [
    ...retrieval.systemMessages,
    ...history,
    { role: "user", content: finalUserContent },
  ]

  const answer = await streamToString(store.llmConfig, llmMessages)
  return {
    projectPath: project.path,
    query,
    answer,
    references: retrieval.references,
    outputLanguage: retrieval.outputLanguage,
  }
}

function normalizeHistory(value: unknown): LLMMessage[] {
  if (!Array.isArray(value)) return []
  const out: LLMMessage[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if ((role === "user" || role === "assistant") && typeof content === "string") {
      out.push({ role, content })
    }
  }
  return out
}

function streamToString(llmConfig: Parameters<typeof streamChat>[0], messages: LLMMessage[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let accumulated = ""
    let thinkingOpen = false

    const appendReasoning = (token: string) => {
      if (!token) return
      if (!thinkingOpen) {
        thinkingOpen = true
        accumulated += "<think>"
      }
      accumulated += token
    }

    const closeReasoning = () => {
      if (!thinkingOpen) return
      thinkingOpen = false
      accumulated += "</think>"
    }

    streamChat(
      llmConfig,
      messages,
      {
        onToken: (token) => {
          closeReasoning()
          accumulated += token
        },
        onReasoningToken: appendReasoning,
        onDone: () => {
          closeReasoning()
          resolve(accumulated)
        },
        onError: reject,
      },
    ).catch(reject)
  })
}

async function handleGraph(payload: Record<string, unknown>) {
  const project = getProject(payload)
  const graph = await buildWikiGraph(project.path)
  return {
    projectPath: project.path,
    ...graph,
  }
}

async function handleIngestFile(payload: Record<string, unknown>) {
  const sourcePath = normalizePath(stringField(payload, "sourcePath") || stringField(payload, "path"))
  if (!sourcePath) throw new Error("sourcePath is required")
  const project = getActiveProjectForIngest(payload)
  const store = useWikiStore.getState()
  if (!hasUsableLlm(store.llmConfig)) {
    throw new Error("LLM not configured -- set API key and model in Settings.")
  }

  const pp = normalizePath(project.path)
  const fileName = getFileName(sourcePath) || "source"
  const destPath = await getUniqueDestPath(`${pp}/raw/sources`, fileName)
  await createDirectory(`${pp}/raw/sources`).catch(() => {})
  await copyFile(sourcePath, destPath)
  preprocessFile(destPath).catch(() => {})
  const taskId = await enqueueIngest(project.id, destPath)
  await refreshFileTree(pp)
  return {
    projectPath: pp,
    sourcePath,
    path: getRelativePath(destPath, pp),
    absolutePath: destPath,
    taskId,
  }
}

async function handleIngestClip(payload: Record<string, unknown>) {
  const title = stringField(payload, "title").trim() || "Untitled"
  const content = stringField(payload, "content")
  const url = stringField(payload, "url")
  if (!content.trim()) throw new Error("content is required")
  const project = getActiveProjectForIngest(payload)
  const store = useWikiStore.getState()
  if (!hasUsableLlm(store.llmConfig)) {
    throw new Error("LLM not configured -- set API key and model in Settings.")
  }

  const pp = normalizePath(project.path)
  const date = new Date().toISOString().slice(0, 10)
  const dateCompact = date.replace(/-/g, "")
  const slug = slugify(title).slice(0, 50) || "untitled"
  const destPath = await getUniqueDestPath(`${pp}/raw/sources`, `${slug}-${dateCompact}.md`)
  await createDirectory(`${pp}/raw/sources`).catch(() => {})
  await writeFile(destPath, buildClipMarkdown(title, url, date, content))
  const taskId = await enqueueIngest(project.id, destPath)
  await refreshFileTree(pp)
  return {
    projectPath: pp,
    path: getRelativePath(destPath, pp),
    absolutePath: destPath,
    taskId,
  }
}

function getActiveProjectForIngest(payload: Record<string, unknown>) {
  const project = getProject(payload)
  if (!project.isActive || !project.id) {
    throw new Error("Ingest API only supports the active desktop project. Open the project in LLM Wiki first.")
  }
  return project
}

async function getUniqueDestPath(dir: string, fileName: string): Promise<string> {
  const basePath = `${dir}/${fileName}`
  if (!(await fileExists(basePath))) return basePath

  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ""
  const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const withDate = `${dir}/${nameWithoutExt}-${date}${ext}`
  if (!(await fileExists(withDate))) return withDate

  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${nameWithoutExt}-${date}-${i}${ext}`
    if (!(await fileExists(withCounter))) return withCounter
  }
  return `${dir}/${nameWithoutExt}-${Date.now()}${ext}`
}

function slugify(title: string): string {
  return title
    .split("")
    .map((ch) => /[\p{L}\p{N} -]/u.test(ch) ? ch : " ")
    .join("")
    .trim()
    .split(/\s+/)
    .join("-")
    .toLowerCase()
}

function yamlQuote(value: string): string {
  return value.replace(/"/g, '\\"')
}

function buildClipMarkdown(title: string, url: string, date: string, content: string): string {
  return [
    "---",
    "type: clip",
    `title: "${yamlQuote(title)}"`,
    `url: "${yamlQuote(url)}"`,
    `clipped: ${date}`,
    "origin: local-api",
    "sources: []",
    "tags: [web-clip]",
    "---",
    "",
    `# ${title}`,
    "",
    `Source: ${url}`,
    "",
    content,
    "",
  ].join("\n")
}

async function refreshFileTree(projectPath: string): Promise<void> {
  try {
    const tree = await listDirectory(projectPath)
    useWikiStore.getState().setFileTree(tree)
  } catch {
    // non-critical
  }
}
