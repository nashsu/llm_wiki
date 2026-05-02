/**
 * deep-research.ts — Node.js port of nashsu/llm_wiki's deep research flow.
 *
 * Pipeline:
 *   1. Multi-query web search (Tavily) with URL deduplication.
 *   2. LLM synthesis into a `wiki/queries/research-<slug>-<date>.md` page,
 *      with cross-references to existing wiki pages via [[wikilinks]].
 *   3. Optional auto-ingest of the synthesis page to extract entities/concepts.
 *
 * Compared to upstream:
 *   - No Zustand research-store / queue / panel UI — the function runs
 *     synchronously and returns the saved path.
 *   - Auto-ingest is opt-in via the `autoIngest` parameter (default true).
 */
import { readFile, writeFile } from "../shims/fs-node"
import { streamChat } from "./llm-client"
import { webSearch } from "./web-search"
import { autoIngest } from "./ingest"
import { normalizePath } from "./path-utils"
import { buildLanguageDirective } from "./output-language"
import { useWikiStore, useActivityStore } from "../shims/stores-node"
import type { LlmConfig } from "../shims/stores-node"

export interface DeepResearchOptions {
  /** Optional explicit search queries; defaults to [topic]. */
  searchQueries?: string[]
  /** Max results per query (default 5). */
  maxResultsPerQuery?: number
  /** Whether to auto-ingest the synthesis page (default true). */
  autoIngest?: boolean
  /** Override LLM config (defaults to env-driven config). */
  llmConfig?: LlmConfig
  /** Cancellation signal. */
  signal?: AbortSignal
}

export interface DeepResearchResult {
  topic: string
  savedPath: string
  fullPath: string
  webResultCount: number
  ingested: boolean
  ingestedFiles: string[]
  warnings: string[]
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50) || "topic"
}

export async function deepResearch(
  projectPath: string,
  topic: string,
  opts: DeepResearchOptions = {},
): Promise<DeepResearchResult> {
  const pp = normalizePath(projectPath)
  const llmConfig = opts.llmConfig ?? useWikiStore.getState().llmConfig
  const activity = useActivityStore
  const activityId = activity.addItem({
    type: "deep-research", title: topic, status: "running", detail: "Starting...", filesWritten: [],
  })

  if (!llmConfig.apiKey && !llmConfig.baseUrl) {
    const msg = "No LLM configured: set OPENAI_API_KEY (or LLM_API_KEY) and optionally LLM_BASE_URL / LLM_MODEL."
    activity.updateItem(activityId, { status: "error", detail: msg })
    throw new Error(msg)
  }

  const warnings: string[] = []
  const queries = opts.searchQueries && opts.searchQueries.length > 0 ? opts.searchQueries : [topic]
  const maxResults = opts.maxResultsPerQuery ?? 5

  // Step 1: web search (multi-query, dedup by URL)
  activity.updateItem(activityId, { detail: `Searching web (${queries.length} queries)...` })
  const seenUrls = new Set<string>()
  const allResults: { title: string; url: string; content: string; score: number }[] = []
  for (const q of queries) {
    try {
      const resp = await webSearch(q, maxResults)
      for (const r of resp.results) {
        if (!r.url || seenUrls.has(r.url)) continue
        seenUrls.add(r.url)
        allResults.push(r)
      }
    } catch (err) {
      const msg = `Web search failed for "${q}": ${err instanceof Error ? err.message : err}`
      warnings.push(msg)
      console.warn(`[deep-research] ${msg}`)
    }
  }

  if (allResults.length === 0) {
    const msg = "No web search results — check TAVILY_API_KEY or query terms."
    activity.updateItem(activityId, { status: "error", detail: msg })
    throw new Error(msg)
  }

  // Step 2: LLM synthesis
  activity.updateItem(activityId, { detail: `Synthesizing (${allResults.length} sources)...` })

  let wikiIndex = ""
  try { wikiIndex = await readFile(`${pp}/wiki/index.md`) } catch { /* no index yet */ }

  const searchContext = allResults
    .map((r, i) => `[${i + 1}] **${r.title}** (${new URL(r.url).hostname})\n${r.content}`)
    .join("\n\n")

  const systemPrompt = [
    "You are a research assistant. Synthesize the web search results into a comprehensive wiki page.",
    "",
    buildLanguageDirective(topic),
    "",
    "## Cross-referencing (IMPORTANT)",
    "- The wiki already has existing pages listed in the Wiki Index below.",
    "- When your synthesis mentions an entity or concept that exists in the wiki, ALWAYS use [[wikilink]] syntax.",
    "",
    "## Writing Rules",
    "- Organize into clear sections with headings",
    "- Cite web sources using [N] notation",
    "- Note contradictions or gaps",
    "- Neutral, encyclopedic tone",
    "",
    wikiIndex ? `## Existing Wiki Index\n${wikiIndex}` : "",
  ].filter(Boolean).join("\n")

  let synthesis = ""
  let streamError: Error | null = null
  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Research topic: **${topic}**\n\n## Web Search Results\n\n${searchContext}\n\nSynthesize into a wiki page.` },
    ],
    {
      onToken: (t) => { synthesis += t },
      onDone: () => {},
      onError: (err) => { streamError = err },
    },
    opts.signal,
    { temperature: 0.2 },
  )
  if (streamError) {
    activity.updateItem(activityId, { status: "error", detail: `Synthesis failed: ${(streamError as Error).message}` })
    throw streamError
  }

  // Step 3: write wiki/queries/research-<slug>-<date>.md
  const date = new Date().toISOString().slice(0, 10)
  const slug = slugify(topic)
  const fileName = `research-${slug}-${date}.md`
  const savedPath = `wiki/queries/${fileName}`
  const fullPath = `${pp}/${savedPath}`

  const references = allResults.map((r, i) => {
    let host = ""
    try { host = new URL(r.url).hostname } catch { host = "" }
    return `${i + 1}. [${r.title}](${r.url})${host ? ` — ${host}` : ""}`
  }).join("\n")

  const cleanedSynthesis = synthesis
    .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
    .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "")
    .trimStart()

  const pageContent = [
    "---",
    "type: query",
    `title: "Research: ${topic.replace(/"/g, '\\"')}"`,
    `created: ${date}`,
    "origin: deep-research",
    "tags: [research]",
    `sources: ["${fileName}"]`,
    "---",
    "",
    `# Research: ${topic}`,
    "",
    cleanedSynthesis,
    "",
    "## References",
    "",
    references,
    "",
  ].join("\n")

  await writeFile(fullPath, pageContent)

  // Step 4: optional auto-ingest
  let ingested = false
  let ingestedFiles: string[] = []
  if (opts.autoIngest !== false) {
    activity.updateItem(activityId, { detail: "Auto-ingesting research result..." })
    try {
      const result = await autoIngest(pp, fullPath, llmConfig, opts.signal)
      ingested = true
      ingestedFiles = result.writtenPaths
    } catch (err) {
      const msg = `Auto-ingest failed: ${err instanceof Error ? err.message : err}`
      warnings.push(msg)
      console.warn(`[deep-research] ${msg}`)
    }
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: ingested ? `Done — saved ${savedPath}, ingested ${ingestedFiles.length} files` : `Done — saved ${savedPath}`,
    filesWritten: [savedPath, ...ingestedFiles],
  })

  return {
    topic,
    savedPath,
    fullPath,
    webResultCount: allResults.length,
    ingested,
    ingestedFiles,
    warnings,
  }
}
