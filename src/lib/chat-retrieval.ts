import { readFile } from "@/commands/fs"
import type { WikiProject } from "@/types/wiki"
import type { ChatMessage as LLMMessage } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { searchWiki, tokenizeQuery, type SearchResult } from "@/lib/search"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { normalizePath, getFileName, getRelativePath } from "@/lib/path-utils"
import {
  getOutputLanguage,
  buildLanguageDirectiveFromLanguage,
  buildLanguageReminderFromLanguage,
} from "@/lib/output-language"
import { isGreeting } from "@/lib/greeting-detector"
import { computeContextBudget } from "@/lib/context-budget"

export interface RetrievedPage {
  title: string
  path: string
  content: string
  priority: number
}

export interface GraphExpansion {
  title: string
  path: string
  relevance: number
}

export interface ChatRetrievalResult {
  systemMessages: LLMMessage[]
  references: Array<{ title: string; path: string }>
  relevantPages: RetrievedPage[]
  searchResults: SearchResult[]
  graphExpansions: GraphExpansion[]
  budget: ReturnType<typeof computeContextBudget>
  langReminder?: string
  outputLanguage: string
  greetingOnly: boolean
}

export interface BuildChatRetrievalInput {
  project: Pick<WikiProject, "name" | "path">
  query: string
  llmConfig: Pick<LlmConfig, "maxContextSize">
  dataVersion: number
  searchLimit?: number
  pageLimit?: number
}

export async function buildChatRetrievalContext({
  project,
  query,
  llmConfig,
  dataVersion,
  searchLimit = 10,
  pageLimit,
}: BuildChatRetrievalInput): Promise<ChatRetrievalResult> {
  const systemMessages: LLMMessage[] = []
  const budget = computeContextBudget(llmConfig.maxContextSize)
  const outputLanguage = getOutputLanguage(query)
  const greetingOnly = isGreeting(query)

  if (greetingOnly) {
    const greetingDirective = buildLanguageDirectiveFromLanguage(outputLanguage)
    systemMessages.push({
      role: "system",
      content: [
        `You are a wiki assistant for the project "${project.name}".`,
        "The user sent a casual greeting -- reply briefly and naturally, in one or two sentences.",
        "Do NOT invent wiki content or pretend to have retrieved pages. Invite the user to ask a concrete question if they want information from the wiki.",
        "",
        greetingDirective,
      ].join("\n"),
    })

    return {
      systemMessages,
      references: [],
      relevantPages: [],
      searchResults: [],
      graphExpansions: [],
      budget,
      outputLanguage,
      greetingOnly,
    }
  }

  const pp = normalizePath(project.path)
  const [rawIndex, purpose] = await Promise.all([
    readFile(`${pp}/wiki/index.md`).catch(() => ""),
    readFile(`${pp}/purpose.md`).catch(() => ""),
  ])

  const searchResults = await searchWiki(pp, query)
  const topSearchResults = searchResults.slice(0, Math.max(1, searchLimit))

  let index = rawIndex
  if (rawIndex.length > budget.indexBudget) {
    const tokens = tokenizeQuery(query)
    const lines = rawIndex.split("\n")
    const keptLines: string[] = []
    let keptSize = 0

    for (const line of lines) {
      const isHeader = line.startsWith("##")
      const lower = line.toLowerCase()
      const isRelevant = tokens.some((t) => lower.includes(t))

      if (isHeader || isRelevant) {
        if (keptSize + line.length + 1 <= budget.indexBudget) {
          keptLines.push(line)
          keptSize += line.length + 1
        }
      }
    }
    index = keptLines.join("\n")
    if (index.length < rawIndex.length) {
      index += "\n\n[...index trimmed to relevant entries...]"
    }
  }

  const graph = await buildRetrievalGraph(pp, dataVersion)
  const expandedIds = new Set<string>()
  const searchHitPaths = new Set(topSearchResults.map((r) => r.path))
  const graphExpansions: GraphExpansion[] = []

  for (const result of topSearchResults) {
    const fileName = getFileName(result.path)
    const nodeId = fileName.replace(/\.md$/, "")
    const related = getRelatedNodes(nodeId, graph, 3)
    for (const { node, relevance } of related) {
      if (relevance < 2.0) continue
      if (searchHitPaths.has(node.path)) continue
      if (expandedIds.has(node.id)) continue
      expandedIds.add(node.id)
      graphExpansions.push({ title: node.title, path: node.path, relevance })
    }
  }
  graphExpansions.sort((a, b) => b.relevance - a.relevance)

  let usedChars = 0
  const relevantPages: RetrievedPage[] = []
  const maxPages = pageLimit && pageLimit > 0 ? pageLimit : Number.POSITIVE_INFINITY

  const tryAddPage = async (
    title: string,
    filePath: string,
    priority: number,
  ): Promise<boolean> => {
    if (usedChars >= budget.pageBudget || relevantPages.length >= maxPages) return false
    try {
      const raw = await readFile(filePath)
      const relativePath = getRelativePath(filePath, pp)
      const truncated = raw.length > budget.maxPageSize
        ? raw.slice(0, budget.maxPageSize) + "\n\n[...truncated...]"
        : raw
      if (usedChars + truncated.length > budget.pageBudget) return false
      usedChars += truncated.length
      relevantPages.push({ title, path: relativePath, content: truncated, priority })
      return true
    } catch {
      return false
    }
  }

  for (const r of topSearchResults.filter((r) => r.titleMatch)) {
    await tryAddPage(r.title, r.path, 0)
  }
  for (const r of topSearchResults.filter((r) => !r.titleMatch)) {
    await tryAddPage(r.title, r.path, 1)
  }
  for (const exp of graphExpansions) {
    await tryAddPage(exp.title, exp.path, 2)
  }
  if (relevantPages.length === 0) {
    await tryAddPage("Overview", `${pp}/wiki/overview.md`, 3)
  }

  const pagesContext = relevantPages.length > 0
    ? relevantPages.map((p, i) =>
        `### [${i + 1}] ${p.title}\nPath: ${p.path}\n\n${p.content}`
      ).join("\n\n---\n\n")
    : "(No wiki pages found)"

  const pageList = relevantPages.map((p, i) =>
    `[${i + 1}] ${p.title} (${p.path})`
  ).join("\n")

  systemMessages.push({
    role: "system",
    content: [
      "You are a knowledgeable wiki assistant. Answer questions based on the wiki content provided below.",
      "",
      "## Rules",
      "- Answer based ONLY on the numbered wiki pages provided below.",
      "- If the provided pages don't contain enough information, say so honestly.",
      "- Use [[wikilink]] syntax to reference wiki pages.",
      "- When citing information, use the page number in brackets, e.g. [1], [2].",
      "- At the VERY END of your response, add a hidden comment listing which page numbers you used:",
      "  <!-- cited: 1, 3, 5 -->",
      "",
      "Use markdown formatting for clarity.",
      "",
      purpose ? `## Wiki Purpose\n${purpose}` : "",
      index ? `## Wiki Index\n${index}` : "",
      relevantPages.length > 0 ? `## Page List\n${pageList}` : "",
      `## Wiki Pages\n\n${pagesContext}`,
      "",
      "---",
      "",
      buildLanguageDirectiveFromLanguage(outputLanguage),
    ].filter(Boolean).join("\n"),
  })

  return {
    systemMessages,
    references: relevantPages.map((p) => ({ title: p.title, path: p.path })),
    relevantPages,
    searchResults,
    graphExpansions,
    budget,
    langReminder: buildLanguageReminderFromLanguage(outputLanguage),
    outputLanguage,
    greetingOnly,
  }
}
