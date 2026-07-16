import { invoke } from "@tauri-apps/api/core"
import type { AnyTxtConfig, LlmConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { streamChat } from "@/lib/llm-client"
import type { WebSearchResult } from "./web-search"

export const DEFAULT_ANYTXT_ENDPOINT = "http://127.0.0.1:9920"
export const DEFAULT_ANYTXT_FILTER_EXT = "*"
export const DEFAULT_ANYTXT_LIMIT = 20
const ANYTXT_QUERY_LIMIT = 3

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
  return invoke<WebSearchResult[]>("anytxt_search", {
    query,
    config: resolved,
    maxResults: Math.min(clampAnyTxtLimit(maxResults), resolved.limit),
  })
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
  // AnyTXT treats omitted filterDir differently across platforms. For
  // Unix-like absolute paths, "/" means "all indexed files"; on Windows
  // there is no single all-drive root, so keep the field empty.
  return pp.startsWith("/") ? "/" : ""
}
