import type { AnyTxtConfig, LlmConfig } from "@/stores/wiki-store"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"
import { normalizePath } from "@/lib/path-utils"
import { streamChat } from "@/lib/llm-client"
import type { WebSearchResult } from "./web-search"

export const DEFAULT_ANYTXT_ENDPOINT = "http://127.0.0.1:9920"
export const DEFAULT_ANYTXT_FILTER_EXT = "*"
export const DEFAULT_ANYTXT_LIMIT = 20
const ANYTXT_LAST_MODIFY_END = 2147483647 // AnyTXT docs use signed 32-bit Unix timestamps.
const ANYTXT_QUERY_LIMIT = 3
let nextRpcId = 1

interface AnyTxtRpcResponse {
  result?: unknown
  error?: string | { message?: string; code?: number }
}

interface AnyTxtItem {
  fid: string
  path: string
  title: string
  snippet: string
}

export function normalizeAnyTxtConfig(config?: AnyTxtConfig, _projectPath?: string): Required<AnyTxtConfig> {
  return {
    enabled: config?.enabled ?? Boolean(config?.endpoint?.trim()),
    endpoint: normalizeAnyTxtEndpoint(config?.endpoint),
    filterDir: config?.filterDir?.trim() || defaultAnyTxtFilterDir(_projectPath),
    filterExt: config?.filterExt?.trim() || DEFAULT_ANYTXT_FILTER_EXT,
    limit: clampAnyTxtLimit(config?.limit),
  }
}

export function hasConfiguredAnyTxt(config?: AnyTxtConfig): boolean {
  const resolved = normalizeAnyTxtConfig(config)
  return Boolean(resolved.enabled && resolved.endpoint.trim())
}

export async function anyTxtSearch(
  query: string,
  config?: AnyTxtConfig,
  maxResults: number = DEFAULT_ANYTXT_LIMIT,
  projectPath?: string,
): Promise<WebSearchResult[]> {
  if (!query.trim()) return []
  const resolved = normalizeAnyTxtConfig(config, projectPath)
  if (!resolved.enabled) return []
  const limit = Math.min(clampAnyTxtLimit(maxResults), resolved.limit)
  const response = await callAnyTxtRpc(resolved.endpoint, "ATRpcServer.Searcher.V1.GetResult", buildAnyTxtSearchInput({
    pattern: query,
    filterDir: resolved.filterDir,
    filterExt: resolved.filterExt,
    lastModifyBegin: 0,
    lastModifyEnd: ANYTXT_LAST_MODIFY_END,
    // AnyTXT's documented GetResult shape expects limit as a string while
    // offset/order/timestamps are numbers.
    limit: String(limit),
    offset: 0,
    order: 0,
  }))

  const items = extractAnyTxtItems(response).slice(0, limit)
  const out: WebSearchResult[] = []
  for (const item of items) {
    const fragment = item.fid
      ? await getAnyTxtFragment(resolved.endpoint, item.fid, query).catch(() => "")
      : ""
    out.push({
      title: item.title,
      url: fileUrlForPath(item.path) || (item.fid ? `anytxt://${item.fid}` : ""),
      snippet: trimFragment(fragment || item.snippet || item.path),
      source: "AnyTXT",
    })
  }
  return out.filter((item) => item.url || item.snippet)
}

export async function anyTxtSearchSmart(
  query: string | string[],
  config?: AnyTxtConfig,
  llmConfig?: LlmConfig,
  maxResults: number = DEFAULT_ANYTXT_LIMIT,
  projectPath?: string,
): Promise<WebSearchResult[]> {
  const resolved = normalizeAnyTxtConfig(config, projectPath)
  if (!resolved.enabled) return []
  const queries = Array.isArray(query) ? query : [query]
  const preparedQueries = await prepareAnyTxtQueries(queries, llmConfig)
  const allResults: WebSearchResult[] = []
  const seen = new Set<string>()

  for (const preparedQuery of preparedQueries) {
    const results = await anyTxtSearch(preparedQuery, resolved, maxResults, projectPath)
    for (const result of results) {
      const key = (result.url || `${result.source}:${result.title}:${result.snippet}`).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      allResults.push(result)
      if (allResults.length >= maxResults) return allResults
    }
  }

  return allResults
}

export async function prepareAnyTxtQueries(queries: string[], llmConfig?: LlmConfig): Promise<string[]> {
  const cleanQueries = uniqueAnyTxtQueries(queries)
  if (cleanQueries.length === 0) return []
  if (!llmConfig) return cleanQueries

  try {
    const rewritten = await rewriteAnyTxtQueries(cleanQueries, llmConfig)
    return uniqueAnyTxtQueries([...rewritten, ...cleanQueries])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("[AnyTXT] query rewrite failed, using original queries:", message)
    return cleanQueries
  }
}

export async function rewriteAnyTxtQueries(queries: string[], llmConfig: LlmConfig): Promise<string[]> {
  const cleanQueries = uniqueAnyTxtQueries(queries)
  if (cleanQueries.length === 0) return []

  const prompt = [
    "Convert the user's search or research topics into concise AnyTXT local file search keyword queries.",
    "",
    "AnyTXT searches local indexed file text. Natural-language questions often fail, so produce keyword-style searches.",
    "Rules:",
    "- Return ONLY a JSON array of strings.",
    "- Produce 1-3 search queries total.",
    "- Keep proper nouns, filenames, technical terms, dates, abbreviations, and non-English terms.",
    "- Prefer compact keyword phrases over full questions.",
    "- Do not add explanations, markdown, comments, or code fences.",
    "",
    "User topics:",
    JSON.stringify(cleanQueries, null, 2),
  ].join("\n")

  let output = ""
  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { output += token },
      onDone: () => {},
      onError: () => {},
    },
    undefined,
    { temperature: 0.1, max_tokens: 512, reasoning: { mode: "off" } },
  )

  const rewritten = parseAnyTxtQueryRewrite(output)
  return rewritten.length > 0 ? rewritten : cleanQueries
}

export function parseAnyTxtQueryRewrite(output: string): string[] {
  const stripped = output
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim()

  const jsonMatch = stripped.match(/\[[\s\S]*\]/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (Array.isArray(parsed)) {
        return uniqueAnyTxtQueries(parsed.map((item) => typeof item === "string" ? item : ""))
      }
    } catch {
      // Fall through to line parser.
    }
  }

  return uniqueAnyTxtQueries(stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)]|QUERY:)\s*/i, "").trim()))
}

export function uniqueAnyTxtQueries(queries: string[], limit: number = ANYTXT_QUERY_LIMIT): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of queries) {
    const query = raw.replace(/^["']|["']$/g, "").trim()
    if (!query) continue
    const key = query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(query)
    if (out.length >= limit) break
  }
  return out
}

async function getAnyTxtFragment(endpoint: string, fid: string, pattern: string): Promise<string> {
  const response = await callAnyTxtRpc(endpoint, "ATRpcServer.Searcher.V1.GetFragment", {
    fid,
    pattern,
  })
  return extractFragmentText(response)
}

async function callAnyTxtRpc(endpoint: string, method: string, input: Record<string, unknown>): Promise<unknown> {
  const httpFetch = await getHttpFetch()
  let response: Response
  try {
    response = await httpFetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: nextRpcId++,
        jsonrpc: "2.0",
        method,
        params: { input },
      }),
    })
  } catch (err) {
    if (isFetchNetworkError(err)) {
      throw new Error("Network error reaching AnyTXT. Check that ATGUI.exe is running and the JSON-RPC API is listening.")
    }
    throw err
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`AnyTXT request failed (${response.status}): ${errorText}`)
  }

  const data = (await response.json()) as AnyTxtRpcResponse
  if (data.error) {
    const message = typeof data.error === "string" ? data.error : data.error.message ?? JSON.stringify(data.error)
    throw new Error(`AnyTXT error: ${message}`)
  }
  return data.result
}

function extractAnyTxtItems(result: unknown): AnyTxtItem[] {
  const rawItems = firstArray(
    result,
    getPath(result, ["output"]),
    getPath(result, ["output", "items"]),
    getPath(result, ["output", "results"]),
    getPath(result, ["output", "list"]),
    getPath(result, ["output", "files"]),
    getPath(result, ["output", "data"]),
    getPath(result, ["output", "value"]),
    getPath(result, ["data", "output", "files"]),
    getPath(result, ["data", "output", "items"]),
    getPath(result, ["data", "output", "results"]),
    getPath(result, ["data", "output", "list"]),
    getPath(result, ["data", "files"]),
    getPath(result, ["data", "items"]),
    getPath(result, ["data", "results"]),
    getPath(result, ["data", "list"]),
    getPath(result, ["items"]),
    getPath(result, ["results"]),
    getPath(result, ["list"]),
    getPath(result, ["files"]),
    getPath(result, ["data"]),
    getPath(result, ["value"]),
  )
  const fields = firstStringArray(
    getPath(result, ["field"]),
    getPath(result, ["output", "field"]),
    getPath(result, ["data", "output", "field"]),
    getPath(result, ["data", "field"]),
  )

  return rawItems.map((item) => normalizeAnyTxtItem(item, fields)).filter((item): item is AnyTxtItem => item !== null)
}

function normalizeAnyTxtItem(item: unknown, fields: string[] = []): AnyTxtItem | null {
  if (!item || (typeof item !== "object" && !Array.isArray(item))) return null
  const record = Array.isArray(item) ? recordFromFields(fields, item) : item as Record<string, unknown>
  const fid = stringField(record, "fid", "id", "fileId", "file_id")
  const path = normalizePath(stringField(record, "path", "file", "filePath", "file_path", "fullPath", "full_path", "filename", "fileName", "name"))
  const title = stringField(record, "title", "name", "fileName", "filename") || basename(path) || fid || "AnyTXT result"
  const snippet = stringField(record, "snippet", "fragment", "content", "contents", "text", "summary", "highlight", "hitText")
  if (!fid && !path && !snippet) return null
  return { fid, path, title, snippet }
}

function extractFragmentText(result: unknown): string {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return result.map(extractFragmentText).filter(Boolean).join("\n\n")
  if (!result || typeof result !== "object") return ""
  const record = result as Record<string, unknown>
  return stringField(record, "text", "fragment", "content", "snippet", "html")
    || extractFragmentText(record.output)
    || extractFragmentText(record.result)
    || extractFragmentText(record.data)
    || extractFragmentText(getPath(record, ["data", "output"]))
    || extractFragmentText(record.fragments)
    || extractFragmentText(record.items)
    || extractFragmentText(record.list)
}

function buildAnyTxtSearchInput(input: {
  pattern: string
  filterDir: string
  filterExt: string
  lastModifyBegin: number
  lastModifyEnd: number
  limit: string
  offset: number
  order: number
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    pattern: input.pattern,
    filterExt: input.filterExt,
    lastModifyBegin: input.lastModifyBegin,
    lastModifyEnd: input.lastModifyEnd,
    limit: input.limit,
    offset: input.offset,
    order: input.order,
  }
  if (input.filterDir.trim()) {
    out.filterDir = input.filterDir
  }
  return out
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) return value
  }
  return []
}

function firstStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value
    }
  }
  return []
}

function recordFromFields(fields: string[], row: unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  fields.forEach((field, index) => {
    record[field] = row[index]
  })
  return record
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
}

function normalizeAnyTxtEndpoint(endpoint?: string): string {
  const trimmed = endpoint?.trim() || DEFAULT_ANYTXT_ENDPOINT
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

function clampAnyTxtLimit(limit: unknown): number {
  const parsed = typeof limit === "number" ? limit : Number(limit)
  if (!Number.isFinite(parsed)) return DEFAULT_ANYTXT_LIMIT
  return Math.min(100, Math.max(1, Math.floor(parsed)))
}

function defaultAnyTxtFilterDir(projectPath?: string): string {
  const pp = projectPath ? normalizePath(projectPath) : ""
  // On the macOS/Linux AnyTXT API, omitting filterDir has been observed to
  // fall back to "C:" instead of "all indexed files". Use "/" as the explicit
  // unrestricted root for Unix-style projects. Keep Windows blank because
  // AnyTXT cannot represent "all drive letters" with one filterDir.
  return pp.startsWith("/") ? "/" : ""
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ""
}

function fileUrlForPath(path: string): string {
  if (!path) return ""
  const normalized = normalizePath(path)
  if (/^[a-z]+:\/\//i.test(normalized)) return normalized
  if (normalized.startsWith("//")) return `file:${encodeURI(normalized)}`
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`
  if (normalized.startsWith("/")) return `file://${encodeURI(normalized)}`
  return normalized
}

function trimFragment(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 1200)
}
