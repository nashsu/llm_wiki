import { webSearch } from "./web-search"
import { streamChat } from "./llm-client"
import { autoIngest } from "./ingest"
import { writeFile, readFile, listDirectory, createDirectory } from "@/commands/fs"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import {
  RESEARCH_REQUIRED_DIRS,
  buildPrimaryResearchPage,
  buildResearchRecordPage,
  buildResearchSavePlan,
  cleanResearchSynthesis,
} from "@/lib/research-artifacts"
import { wikiTitleLanguagePolicy } from "@/lib/wiki-title"

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
    // Step 1: Web search — use multiple queries if available, merge and deduplicate
    store.updateTask(taskId, { status: "searching" })

    const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
    const queries = task?.searchQueries && task.searchQueries.length > 0
      ? task.searchQueries
      : [topic]

    const allResults: import("./web-search").WebSearchResult[] = []
    const seenUrls = new Set<string>()

    for (const query of queries) {
      try {
        const results = await webSearch(query, searchConfig, 5)
        for (const r of results) {
          if (!seenUrls.has(r.url)) {
            seenUrls.add(r.url)
            allResults.push(r)
          }
        }
      } catch {
        // continue with other queries
      }
    }

    const webResults = allResults
    store.updateTask(taskId, { webResults })

    if (webResults.length === 0) {
      store.updateTask(taskId, { status: "done", synthesis: "No web results found." })
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
      "You are a research assistant. Synthesize the web search results into a comprehensive wiki page.",
      "",
      buildLanguageDirective(topic),
      "",
      wikiTitleLanguagePolicy(),
      "",
      "## Cross-referencing (IMPORTANT)",
      "- The wiki already has existing pages listed in the Wiki Index below.",
      "- When your synthesis mentions an entity or concept that exists in the wiki, ALWAYS use [[wikilink]] syntax to link to it.",
      "- For example, if the wiki has an entity 'anthropic', write [[anthropic]] when mentioning it.",
      "- This is critical for connecting new research to existing knowledge in the graph.",
      "",
      "## Writing Rules",
      "- Start with one concise H1 that names the reusable research subject, not the original command",
      "- Do not prefix the title with Research, Research Log, Source, or Deep Research",
      "- Do not include instruction words like 조사해줘, 정리해줘, 확인하고, or 최신자료 기준 in the title",
      "- Organize into clear sections with headings",
      "- Do not list search results one by one; synthesize them into reusable wiki knowledge",
      "- Cite web sources using [N] notation",
      "- Note contradictions or gaps",
      "- Suggest additional sources worth finding",
      "- Separate source-grounded claims from claims that still need primary-source verification",
      "- Include freshness/currentness limits for product status, pricing, APIs, releases, benchmarks, or fast-changing facts",
      "- Explain what the result changes for the user's AI Native Solo Business OS when relevant",
      "- If the answer should become durable knowledge, state whether it should be promoted to concept, entity, comparison, or synthesis",
      "- Neutral, encyclopedic tone",
      "",
      wikiIndex ? `## Existing Wiki Index (link to these pages with [[wikilink]])\n${wikiIndex}` : "",
    ].filter(Boolean).join("\n")

    let accumulated = ""

    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Research topic: **${topic}**\n\n## Web Search Results\n\n${searchContext}\n\nSynthesize into a wiki page.` },
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

    const references = webResults
      .map((r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.source}`)
      .join("\n")

    const cleanedSynthesis = cleanResearchSynthesis(accumulated)
    const savePlan = buildResearchSavePlan({
      topic,
      synthesis: accumulated,
      webResults,
    })

    await ensureResearchWikiDirs(pp)

    const queryRecordContent = buildResearchRecordPage({
      topic,
      title: savePlan.title,
      date: savePlan.date,
      content: cleanedSynthesis,
      references,
    })
    await writeFile(`${pp}/${savePlan.queryRecordPath}`, queryRecordContent)

    let savedPath = savePlan.queryRecordPath
    if (savePlan.primaryType !== "query") {
      const primaryContent = buildPrimaryResearchPage({
        type: savePlan.primaryType,
        title: savePlan.title,
        date: savePlan.date,
        content: cleanedSynthesis,
        queryRecordFileName: savePlan.queryRecordFileName,
        references,
        related: savePlan.related,
      })
      await writeFile(`${pp}/${savePlan.primaryPath}`, primaryContent)
      savedPath = savePlan.primaryPath
    }

    useResearchStore.getState().updateTask(taskId, {
      status: "done",
      savedPath,
      queryRecordPath: savePlan.queryRecordPath,
      savedArtifactType: savePlan.primaryType,
    })

    // Refresh tree
    try {
      const tree = await listDirectory(pp)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }

    // Auto-ingest the immutable research record to generate entities
    // and concepts without treating a curated synthesis/comparison
    // page as raw input. When a primary artifact was already written,
    // do not duplicate the same research record into wiki/sources.
    autoIngest(pp, `${pp}/${savePlan.queryRecordPath}`, llmConfig, undefined, undefined, {
      skipSourceSummary: savePlan.primaryType !== "query",
      sourceSummaryTitle: savePlan.title,
    }).catch((err) => {
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

async function ensureResearchWikiDirs(projectPath: string): Promise<void> {
  await Promise.all(
    RESEARCH_REQUIRED_DIRS.map((dir) => createDirectory(`${projectPath}/${dir}`)),
  )
}

function onTaskFinished(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  // Process next queued task
  setTimeout(() => processQueue(projectPath, llmConfig, searchConfig), 100)
}
