import { anyTxtSearchSmart, hasConfiguredAnyTxt } from "./anytxt-search"
import { hasConfiguredSearchProvider, resolveSearchConfig, webSearch } from "./web-search"
import { streamChat } from "./llm-client"
import { currentWikiDate } from "./ingest"
import { writeFile, readFile } from "@/commands/fs"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { makeQueryFileName } from "@/lib/wiki-filename"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

const MAX_RESEARCH_SOURCES = 20

interface ResearchSourceDeps {
  webSearch: typeof webSearch
  anyTxtSearch: typeof anyTxtSearchSmart
}

interface CollectResearchSourceOptions {
  llmConfig?: LlmConfig
}

interface ResearchSourceCollection {
  results: import("./web-search").WebSearchResult[]
  errors: string[]
}

export function noResearchSourcesTaskPatch(sourceErrors: string[]): {
  status: "done" | "error"
  synthesis: string
  error: string | null
} {
  // If every selected source produced zero usable results and at least
  // one source failed, surface the failure state explicitly. Otherwise
  // the UI shows "completed" for a task that could not actually search.
  if (sourceErrors.length > 0) {
    return {
      status: "error",
      synthesis: "",
      error: sourceErrors.join("\n"),
    }
  }
  return {
    status: "done",
    synthesis: "No research sources found.",
    error: null,
  }
}

export function makeDeepResearchFileName(topic: string, now: Date = new Date()): {
  fileName: string
  date: string
} {
  const { fileName } = makeQueryFileName(`research-${topic}`, now)
  return { fileName, date: currentWikiDate(now) }
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
  deps: ResearchSourceDeps = { webSearch, anyTxtSearch: anyTxtSearchSmart },
  options: CollectResearchSourceOptions = {},
): Promise<ResearchSourceCollection> {
  const resolvedSearchConfig = resolveSearchConfig(searchConfig)
  const sourceMode = resolvedSearchConfig.deepResearchSource ?? "web"
  const useWeb = sourceMode === "web" || sourceMode === "both"
  const useAnyTxt = hasAnyTxtSource(resolvedSearchConfig) && hasConfiguredAnyTxt(resolvedSearchConfig.anyTxt)
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
  const calls: Array<Promise<{ results: import("./web-search").WebSearchResult[] }>> = []

  for (const webQuery of webQueries) {
    if (useWeb && webConfigured && webQuery) {
      calls.push(deps.webSearch(webQuery, resolvedSearchConfig, 5).then((results) => ({ results })))
    }
  }
  if (useAnyTxt) {
    calls.push(deps.anyTxtSearch(queries, resolvedSearchConfig.anyTxt, options.llmConfig, 15, projectPath).then((results) => ({ results })))
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

  return { results: allResults, errors }
}

function hasAnyTxtSource(searchConfig: SearchApiConfig): boolean {
  const sourceMode = searchConfig.deepResearchSource ?? "web"
  return sourceMode === "anytxt" || sourceMode === "both"
}

function isActiveProjectPath(projectPath: string): boolean {
  const activePath = useWikiStore.getState().project?.path
  return Boolean(activePath && normalizePath(activePath) === normalizePath(projectPath))
}

function updateTaskIfActive(
  projectPath: string,
  taskId: string,
  patch: Parameters<ReturnType<typeof useResearchStore.getState>["updateTask"]>[1],
): boolean {
  if (!isActiveProjectPath(projectPath)) return false
  useResearchStore.getState().updateTask(taskId, patch)
  return true
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

  try {
    if (!isActiveProjectPath(pp)) return
    // Step 1: gather research sources — use multiple queries if available,
    // merge Web Search and local AnyTXT results, then deduplicate.
    if (!updateTaskIfActive(pp, taskId, { status: "searching" })) return

    const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
    const queries = task?.searchQueries && task.searchQueries.length > 0
      ? task.searchQueries
      : [topic]
    const { results: allResults, errors: sourceErrors } = await collectResearchSources(
      queries,
      searchConfig,
      pp,
      { webSearch, anyTxtSearch: anyTxtSearchSmart },
      { llmConfig },
    )
    if (!isActiveProjectPath(pp)) return

    const webResults = allResults
    if (!updateTaskIfActive(pp, taskId, { webResults })) return

    if (webResults.length === 0) {
      if (!updateTaskIfActive(pp, taskId, noResearchSourcesTaskPatch(sourceErrors))) return
      if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
      return
    }

    // Step 2: LLM synthesis
    if (!updateTaskIfActive(pp, taskId, { status: "synthesizing" })) return

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
          if (!isActiveProjectPath(pp)) return
          accumulated += token
          // Update synthesis progressively so UI shows real-time text
          useResearchStore.getState().updateTask(taskId, { synthesis: accumulated })
        },
        onDone: () => {},
        onError: (err) => {
          if (!isActiveProjectPath(pp)) return
          useResearchStore.getState().updateTask(taskId, {
            status: "error",
            error: err.message,
          })
        },
      },
    )

    // Check if errored during streaming
    if (useResearchStore.getState().tasks.find((t) => t.id === taskId)?.status === "error") {
      if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
      return
    }
    if (!isActiveProjectPath(pp)) return

    // Step 3: Save to wiki
    if (!updateTaskIfActive(pp, taskId, { status: "saving", synthesis: accumulated })) return

    const { fileName, date } = makeDeepResearchFileName(topic)
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

    if (!updateTaskIfActive(pp, taskId, {
      status: "done",
      savedPath,
    })) return

    try {
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
    } catch {
      // ignore
    }

    // The query page no longer goes through source ingest, so index it here
    // directly. This keeps freshly generated research available to hybrid
    // search without recreating the review-amplifying ingest loop.
    const embeddingConfig = useWikiStore.getState().embeddingConfig
    if (embeddingConfig.enabled && embeddingConfig.model) {
      try {
        const { embedPage } = await import("@/lib/embedding")
        await embedPage(pp, fileName.replace(/\.md$/i, ""), `Research: ${topic}`, pageContent, embeddingConfig)
      } catch (err) {
        console.warn("[DeepResearch] failed to index generated query page:", err)
      }
    }

    // A research result is already a generated wiki page. Feeding it back
    // through source ingest creates a second summary page and recursively
    // produces low-value review suggestions from its own gaps/references.
    // Keep it directly searchable as the query page instead.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateTaskIfActive(pp, taskId, {
      status: "error",
      error: message,
    })
  }

  if (isActiveProjectPath(pp)) onTaskFinished(pp, llmConfig, searchConfig)
}

function onTaskFinished(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  // Process next queued task
  setTimeout(() => processQueue(projectPath, llmConfig, searchConfig), 100)
}
