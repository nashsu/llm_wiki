import { webSearch } from "./web-search"
import { streamChat } from "./llm-client"
import { autoIngest } from "./ingest"
import { writeFile, readFile, listDirectory, createDirectory } from "@/commands/fs"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { crawlUrls } from "@/lib/web-crawler"
import { getHttpFetch } from "@/lib/tauri-fetch"
import { enqueueSourceIngest } from "@/lib/source-lifecycle"

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

    // Step 1.5: Crawl all result URLs (runs in parallel with LLM synthesis)
    const httpFetch = await getHttpFetch()
    const crawlPromise = crawlUrls(
      webResults.map((r) => r.url),
      httpFetch,
      {
        concurrency: 4,
        onProgress: (done, total) => {
          useResearchStore.getState().updateCrawlProgress(taskId, done, total)
        },
      },
    ).then((pages) => {
      useResearchStore.getState().setCrawledPages(taskId, pages)
    })

    // Step 2: LLM synthesis (runs in parallel with crawl)
    store.updateTask(taskId, { status: "synthesizing", crawlProgress: { done: 0, total: webResults.length } })

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
      "## Cross-referencing (IMPORTANT)",
      "- The wiki already has existing pages listed in the Wiki Index below.",
      "- When your synthesis mentions an entity or concept that exists in the wiki, ALWAYS use [[wikilink]] syntax to link to it.",
      "- For example, if the wiki has an entity 'anthropic', write [[anthropic]] when mentioning it.",
      "- This is critical for connecting new research to existing knowledge in the graph.",
      "",
      "## Writing Rules",
      "- Organize into clear sections with headings",
      "- Cite web sources using [N] notation",
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

    // Wait for crawl to finish before saving
    await crawlPromise

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

    // Strip <think/<thinking> blocks before saving
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

/**
 * Import user-selected crawled pages as source files for ingest.
 */
export async function importSelectedSources(
  projectPath: string,
  taskId: string,
  llmConfig: LlmConfig,
): Promise<string[]> {
  const task = useResearchStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return []

  const project = useWikiStore.getState().project
  if (!project) return []

  const pp = normalizePath(projectPath)
  const selected = task.selectedUrls
  if (selected.size === 0) return []

  const pagesToImport = task.crawledPages.filter(
    (p) => p.status === "success" && selected.has(p.url),
  )
  if (pagesToImport.length === 0) return []

  const topicSlug = task.topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50)
  const sourcesDir = `${pp}/raw/sources/deep-research-${topicSlug}`

  await createDirectory(sourcesDir)

  const importedPaths: string[] = []

  for (const page of pagesToImport) {
    const urlSlug = page.url
      .replace(/^https?:\/\//, "")
      .replace(/[/?#:]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80)
      .toLowerCase()

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="title" content="${escapeAttr(page.title)}">
<meta name="source-url" content="${escapeAttr(page.url)}">
<meta name="origin" content="deep-research">
</head>
<body>
${page.content}
</body></html>`

    const filePath = `${sourcesDir}/${urlSlug}.html`
    await writeFile(filePath, html)
    importedPaths.push(filePath)
  }

  if (importedPaths.length > 0) {
    await enqueueSourceIngest(
      project,
      importedPaths,
      llmConfig,
      { sourceRoot: sourcesDir, rootContext: `deep-research-${topicSlug}` },
    )
  }

  // Clear selection after import
  useResearchStore.getState().clearSelection(taskId)

  return importedPaths
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function onTaskFinished(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
) {
  // Process next queued task
  setTimeout(() => processQueue(projectPath, llmConfig, searchConfig), 100)
}
