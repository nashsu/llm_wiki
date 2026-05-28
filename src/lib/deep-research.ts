import { anyTxtSearch } from "./anytxt-search"
import { hasConfiguredSearchProvider, resolveSearchConfig, webSearch } from "./web-search"
import { streamChat } from "./llm-client"
import { autoIngest } from "./ingest"
import { writeFile, readFile, listDirectory } from "@/commands/fs"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"

const MAX_RESEARCH_SOURCES = 20

interface ResearchSourceDeps {
  webSearch: typeof webSearch
  anyTxtSearch: typeof anyTxtSearch
}

interface CollectResearchSourceOptions {
  anyTxtQueries?: string[]
}

interface ResearchSourceCollection {
  results: import("./web-search").WebSearchResult[]
  errors: string[]
}

/**
 * Queue a deep research task. Automatically starts processing if under concurrency limit.
 */
export function queueResearch(
  projectPath: string,
  topic: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
  searchQueries?: string[],
): string {
  const store = useResearchStore.getState()
  const taskId = store.addTask(topic)
  // Store search queries on the task
  if (searchQueries && searchQueries.length > 0) {
    store.updateTask(taskId, { searchQueries })
  }
  // Ensure panel is open
  store.setPanelOpen(true)
  // Start processing on next tick to ensure React has rendered the panel
  setTimeout(() => {
    processQueue(projectPath, llmConfig, searchConfig)
  }, 50)
  return taskId
}

export async function collectResearchSources(
  queries: string[],
  searchConfig: SearchApiConfig,
  projectPath: string,
  deps: ResearchSourceDeps = { webSearch, anyTxtSearch },
  options: CollectResearchSourceOptions = {},
): Promise<ResearchSourceCollection> {
  const resolvedSearchConfig = resolveSearchConfig(searchConfig)
  const sourceMode = resolvedSearchConfig.deepResearchSource ?? "web"
  const useWeb = sourceMode === "web" || sourceMode === "both"
  const useAnyTxt = hasAnyTxtSource(resolvedSearchConfig)
  const webConfigured = hasConfiguredSearchProvider(resolvedSearchConfig)
  const allResults: import("./web-search").WebSearchResult[] = []
  const errors: string[] = []
  const seenUrls = new Set<string>()
  let cappedWarned = false

  function addResults(results: import("./web-search").WebSearchResult[]) {
    for (const r of results) {
      if (allResults.length >= MAX_RESEARCH_SOURCES) {
        if (!cappedWarned) {
          console.info(`[DeepResearch] capped at ${MAX_RESEARCH_SOURCES} research sources; later results were truncated.`)
          cappedWarned = true
        }
        return
      }
      const key = (r.url || `${r.source}:${r.title}:${r.snippet}`).toLowerCase()
      if (!seenUrls.has(key)) {
        seenUrls.add(key)
        allResults.push(r)
      }
    }
  }

  const webQueries = queries.map((q) => q.trim()).filter(Boolean)
  const anyTxtQueries = uniqueQueries([
    ...(options.anyTxtQueries ?? []),
    ...queries,
  ])
  const maxQueryCount = Math.max(webQueries.length, anyTxtQueries.length)

  for (let i = 0; i < maxQueryCount; i++) {
    const webQuery = webQueries[i]
    const anyTxtQuery = anyTxtQueries[i]
    const calls: Array<Promise<{ results: import("./web-search").WebSearchResult[] }>> = []
    if (useWeb && webConfigured && webQuery) {
      calls.push(deps.webSearch(webQuery, resolvedSearchConfig, 5).then((results) => ({ results })))
    }
    if (useAnyTxt && anyTxtQuery) {
      calls.push(deps.anyTxtSearch(anyTxtQuery, resolvedSearchConfig.anyTxt, 5, projectPath).then((results) => ({ results })))
    }
    const settled = await Promise.allSettled(calls)
    for (const item of settled) {
      if (item.status === "fulfilled") {
        addResults(item.value.results)
      } else {
        const message = item.reason instanceof Error ? item.reason.message : String(item.reason)
        errors.push(message)
        console.warn("[DeepResearch] source search failed:", message)
      }
    }
  }

  return { results: allResults, errors }
}

function hasAnyTxtSource(searchConfig: SearchApiConfig): boolean {
  const sourceMode = searchConfig.deepResearchSource ?? "web"
  return sourceMode === "anytxt" || sourceMode === "both"
}

export async function rewriteAnyTxtQueries(queries: string[], llmConfig: LlmConfig): Promise<string[]> {
  const cleanQueries = queries.map((q) => q.trim()).filter(Boolean)
  if (cleanQueries.length === 0) return []

  const prompt = [
    "Convert the user's research topics into concise AnyTXT local file search keyword queries.",
    "",
    "AnyTXT searches local indexed file text. Natural-language questions often fail, so produce keyword-style searches.",
    "Rules:",
    "- Return ONLY a JSON array of strings.",
    "- Produce 1-3 search queries total.",
    "- Keep proper nouns, filenames, technical terms, dates, abbreviations, and non-English terms.",
    "- Prefer compact keyword phrases over full questions.",
    "- Do not add explanations, markdown, comments, or code fences.",
    "",
    "User research topics:",
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
        return uniqueQueries(parsed.map((item) => typeof item === "string" ? item : ""))
      }
    } catch {
      // fall through to line parser
    }
  }

  return uniqueQueries(stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)]|QUERY:)\s*/i, "").trim()))
}

function uniqueQueries(queries: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of queries) {
    const query = raw.replace(/^["']|["']$/g, "").trim()
    if (!query) continue
    const key = query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(query)
    if (out.length >= 3) break
  }
  return out
}

/**
 * Process queued tasks up to maxConcurrent limit.
 */
function processQueue(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  const store = useResearchStore.getState()
  const running = store.getRunningCount()
  const available = store.maxConcurrent - running

  for (let i = 0; i < available; i++) {
    const next = useResearchStore.getState().getNextQueued()
    if (!next) break
    executeResearch(projectPath, next.id, next.topic, llmConfig, searchConfig)
  }
}

async function executeResearch(
  projectPath: string,
  taskId: string,
  topic: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  const pp = normalizePath(projectPath)
  const store = useResearchStore.getState()

  try {
    // Step 1: gather research sources — use multiple queries if available,
    // merge Web Search and local AnyTXT results, then deduplicate.
    store.updateTask(taskId, { status: "searching" })

    const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
    const queries = task?.searchQueries && task.searchQueries.length > 0
      ? task.searchQueries
      : [topic]
    let anyTxtQueries: string[] | undefined
    if (hasAnyTxtSource(resolveSearchConfig(searchConfig))) {
      try {
        anyTxtQueries = await rewriteAnyTxtQueries(queries, llmConfig)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn("[DeepResearch] AnyTXT query rewrite failed, using original queries:", message)
      }
    }
    const { results: allResults, errors: sourceErrors } = await collectResearchSources(
      queries,
      searchConfig,
      pp,
      { webSearch, anyTxtSearch },
      { anyTxtQueries },
    )

    const webResults = allResults
    store.updateTask(taskId, { webResults })

    if (webResults.length === 0) {
      store.updateTask(taskId, {
        status: "done",
        synthesis: sourceErrors.length > 0 ? sourceErrors.join("\n") : "No research sources found.",
      })
      onTaskFinished(pp, llmConfig, searchConfig)
      return
    }

    // Step 2: LLM synthesis
    store.updateTask(taskId, { status: "synthesizing" })

    const searchContext = webResults
      .map((r, i) => `[${i + 1}] **${r.title}** (${r.source})\n${r.snippet}`)
      .join("\n\n")

    // Read existing wiki index to enable cross-referencing
    let wikiIndex = ""
    try {
      wikiIndex = await readFile(`${pp}/wiki/index.md`)
    } catch {
      // no index yet
    }

    const systemPrompt = [
      "You are a research assistant. Synthesize the collected research sources into a comprehensive wiki page.",
      "",
      buildLanguageDirective(topic),
      "",
      "## Cross-referencing (IMPORTANT)",
      "- The wiki already has existing pages listed in the Wiki Index below.",
      "- When your synthesis mentions an entity or concept that exists in the wiki, ALWAYS use [[wikilink]] syntax to link to it.",
      "- For example, if the wiki has an entity 'anthropic', write [[anthropic]] when mentioning it.",
      "- This is critical for connecting new research to existing knowledge in the graph.",
      "",
      "## Writing Rules",
      "- Organize into clear sections with headings",
      "- Cite sources using [N] notation",
      "- Note contradictions or gaps",
      "- Suggest additional sources worth finding",
      "- Neutral, encyclopedic tone",
      "",
      wikiIndex ? `## Existing Wiki Index (link to these pages with [[wikilink]])\n${wikiIndex}` : "",
    ].filter(Boolean).join("\n")

    let accumulated = ""

    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Research topic: **${topic}**\n\n## Research Sources\n\n${searchContext}\n\nSynthesize into a wiki page.` },
      ],
      {
        onToken: (token) => {
          accumulated += token
          // Update synthesis progressively so UI shows real-time text
          useResearchStore.getState().updateTask(taskId, { synthesis: accumulated })
        },
        onDone: () => {},
        onError: (err) => {
          useResearchStore.getState().updateTask(taskId, {
            status: "error",
            error: err.message,
          })
        },
      },
    )

    // Check if errored during streaming
    if (useResearchStore.getState().tasks.find((t) => t.id === taskId)?.status === "error") {
      onTaskFinished(pp, llmConfig, searchConfig)
      return
    }

    // Step 3: Save to wiki
    store.updateTask(taskId, { status: "saving", synthesis: accumulated })

    const date = new Date().toISOString().slice(0, 10)
    const slug = topic.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 50)
    const fileName = `research-${slug}-${date}.md`
    const filePath = `${pp}/wiki/queries/${fileName}`

    const references = webResults
      .map((r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.source}`)
      .join("\n")

    // Strip <think>/<thinking> blocks before saving
    const cleanedSynthesis = accumulated
      .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "") // unclosed thinking block
      .trimStart()

    const pageContent = [
      "---",
      `type: query`,
      `title: "Research: ${topic.replace(/"/g, '\\"')}"`,
      `created: ${date}`,
      `origin: deep-research`,
      `tags: [research]`,
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

    await writeFile(filePath, pageContent)
    const savedPath = `wiki/queries/${fileName}`

    useResearchStore.getState().updateTask(taskId, {
      status: "done",
      savedPath,
    })

    // Refresh tree
    try {
      const tree = await listDirectory(pp)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }

    // Auto-ingest the research result to generate entities, concepts, cross-references
    autoIngest(pp, `${pp}/${savedPath}`, llmConfig).catch((err) => {
      console.error("Failed to auto-ingest research result:", err)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    useResearchStore.getState().updateTask(taskId, {
      status: "error",
      error: message,
    })
  }

  onTaskFinished(pp, llmConfig, searchConfig)
}

function onTaskFinished(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  // Process next queued task
  setTimeout(() => processQueue(projectPath, llmConfig, searchConfig), 100)
}
