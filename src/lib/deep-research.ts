import { webSearch } from "./web-search"
import { streamChat } from "./llm-client"
import { autoIngest } from "./ingest"
import { collectWebAccessSources } from "./web-access"
import { writeFile, readFile, listDirectory } from "@/commands/fs"
import { useWikiStore, type LlmConfig, type SearchApiConfig } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"

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
      store.updateTask(taskId, { status: "done", synthesis: "未找到网页结果。" })
      onTaskFinished(pp, llmConfig, searchConfig)
      return
    }

    // Optional Step 1.5: use WebAccess as a read-only browser extraction layer.
    // Search providers still do URL discovery; WebAccess only opens already-discovered
    // pages, saves Markdown source artifacts, and returns local citation anchors.
    const webAccessConfig = useWikiStore.getState().webAccessConfig
    const webAccessCollection =
      webAccessConfig.enabled && webAccessConfig.allowReadOnlyBrowser && !webAccessConfig.requirePerTaskConsent && webAccessConfig.saveSourceMarkdown
        ? await collectWebAccessSources(pp, taskId, topic, webResults, webAccessConfig)
        : null

    if (webAccessCollection?.evidence.length) {
      for (const evidence of webAccessCollection.evidence) {
        autoIngest(pp, `${pp}/${evidence.artifactPath}`, llmConfig).catch((err) => {
          console.error("Failed to auto-ingest WebAccess source:", err)
        })
      }
      try {
        const tree = await listDirectory(pp)
        useWikiStore.getState().setFileTree(tree)
        useWikiStore.getState().bumpDataVersion()
      } catch {
        // ignore
      }
    }

    // Step 2: LLM synthesis
    store.updateTask(taskId, { status: "synthesizing" })

    const searchContext = webResults
      .map((r, i) => `[${i + 1}] **${r.title}** (${r.source})\n${r.snippet}`)
      .join("\n\n")

    const browserContext = webAccessCollection?.evidence.length
      ? webAccessCollection.evidence
        .map((e) => `[${e.id}] **${e.title}** (WebAccess)\nURL: ${e.finalUrl}\n本地来源: ${e.artifactPath}\n摘录:\n${e.quote}`)
        .join("\n\n")
      : ""

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
      "- Cite search snippets using [N] notation",
      "- Cite browser-extracted WebAccess sources using [B1], [B2] notation when available",
      "- Do not cite a WebAccess source unless it appears in the WebAccess Extracted Sources section",
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
        {
          role: "user",
          content: [
            `Research topic: **${topic}**`,
            "",
            "## Web Search Results",
            "",
            searchContext,
            browserContext ? "\n## WebAccess Extracted Sources\n" : "",
            browserContext,
            "",
            "Synthesize into a wiki page.",
          ].filter(Boolean).join("\n"),
        },
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

    const searchReferences = webResults
      .map((r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.source}`)
      .join("\n")
    const webAccessReferences = webAccessCollection?.evidence.length
      ? webAccessCollection.evidence
        .map((e) => `${e.id}. [${e.title}](${e.finalUrl}) — WebAccess，本地来源：\`${e.artifactPath}\``)
        .join("\n")
      : ""
    const references = [searchReferences, webAccessReferences].filter(Boolean).join("\n")

    // Strip <think>/<thinking> blocks before saving
    const cleanedSynthesis = accumulated
      .replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, "")
      .replace(/<think(?:ing)?>\s*[\s\S]*$/gi, "") // unclosed thinking block
      .trimStart()

    const pageContent = [
      "---",
      `type: query`,
      `title: "研究：${topic.replace(/"/g, '\\"')}"`,
      `created: ${date}`,
      `origin: deep-research`,
      `tags: [research]`,
      "---",
      "",
      `# 研究：${topic}`,
      "",
      cleanedSynthesis,
      "",
      "## 引用",
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
