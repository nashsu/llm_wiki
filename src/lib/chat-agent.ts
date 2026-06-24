import { listDirectory, readFile } from "@/commands/fs"
import { anyTxtSearchSmart } from "@/lib/anytxt-search"
import { computeContextBudget } from "@/lib/context-budget"
import { isGreeting } from "@/lib/greeting-detector"
import { buildRetrievalGraph, getRelatedNodes } from "@/lib/graph-relevance"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { buildLanguageDirective, buildLanguageReminder } from "@/lib/output-language"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { searchWiki, type SearchResult } from "@/lib/search"
import { resolveSearchConfig, webSearch, type WebSearchResult } from "@/lib/web-search"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import type { MessageReference } from "@/stores/chat-store"
import type { FileNode } from "@/types/wiki"

export type ChatAgentAction =
  | "answer"
  | "project_files"
  | "project_file_read"
  | "wiki_search"
  | "graph_search"
  | "external_search"
  | "multi_search"
  | "finish"

export interface ChatAgentDecision {
  action: ChatAgentAction
  queries: string[]
  answer?: string
  reason?: string
}

export type ChatAgentIntent =
  | "chitchat"
  | "follow_up"
  | "rewrite"
  | "kb_search"
  | "graph"
  | "external"
  | "mixed"

export interface ChatQueryUnderstanding {
  intent: ChatAgentIntent
  rewrittenQuery: string
  wikiQueries: string[]
  graphQueries: string[]
  externalQueries: string[]
  needsWiki: boolean
  needsGraph: boolean
  needsExternal: boolean
  isFollowUp: boolean
  reason?: string
}

export interface ChatAgentProject {
  name: string
  path: string
}

export interface ChatAgentOptions {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  mode?: ChatAgentMode
}

export interface ChatAgentDeps {
  searchWiki?: typeof searchWiki
  webSearch?: typeof webSearch
  anyTxtSearchSmart?: typeof anyTxtSearchSmart
  streamChat?: typeof streamChat
}

export type ChatAgentEventStage =
  | "understanding"
  | "routing"
  | "tool_call"
  | "tool_result"
  | "searching_wiki"
  | "searching_graph"
  | "searching_web"
  | "searching_anytxt"
  | "reading_context"
  | "writing"

export interface ChatAgentEvent {
  stage: ChatAgentEventStage
  query?: string
  tool?: ChatAgentToolName
  message?: string
  count?: number
  status?: "running" | "success" | "error" | "skipped"
}

export interface ChatAgentInput {
  project: ChatAgentProject | null
  llmConfig: LlmConfig
  searchApiConfig: SearchApiConfig
  text: string
  historyMessages: LLMMessage[]
  retrievalHistory?: MessageReference[]
  dataVersion: number
  options: ChatAgentOptions
  signal?: AbortSignal
  onEvent?: (event: ChatAgentEvent) => void
  deps?: ChatAgentDeps
}

export interface ChatAgentResult {
  messages: LLMMessage[]
  references: MessageReference[]
  queryPages: { title: string; path: string }[]
  plan: ChatAgentDecision[]
  steps: ChatAgentStep[]
}

interface ToolObservation {
  tool: "project_files" | "project_file_read" | "wiki_search" | "graph_search" | "external_search"
  query: string
  content: string
  references: MessageReference[]
  pages: { title: string; path: string }[]
  items: RetrievedItem[]
  errorCount?: number
}

export type ChatAgentMode = "fast" | "standard" | "deep" | "local_first"

export type ChatAgentToolName =
  | "project_files"
  | "project_file_read"
  | "wiki_search"
  | "graph_search"
  | "web_search"
  | "anytxt_search"

export interface ChatAgentToolDefinition {
  name: ChatAgentToolName
  action: Extract<ChatAgentAction, "project_files" | "project_file_read" | "wiki_search" | "graph_search" | "external_search">
  stage: Extract<ChatAgentEventStage, "searching_wiki" | "searching_graph" | "searching_web" | "searching_anytxt">
  label: string
  description: string
  requiresProject?: boolean
}

export interface ChatAgentStep {
  id: string
  type: "understanding" | "routing" | "tool_call" | "tool_result" | "final"
  tool?: ChatAgentToolName
  query?: string
  message?: string
  count?: number
  status?: "running" | "success" | "error" | "skipped"
}

type PageEntry = { title: string; path: string; content: string; priority: number }
type ProjectPromptContext = { purpose: string; index: string; overview: string }
type RetrievedItemKind = "wiki" | "graph" | "external" | "history"

interface RetrievedItem {
  id: string
  kind: RetrievedItemKind
  source: string
  title: string
  path: string
  url?: string
  snippet: string
  content: string
  score: number
  query: string
  reference: MessageReference
  page?: { title: string; path: string }
}

interface RetrievedContext {
  contextText: string
  references: MessageReference[]
  pages: { title: string; path: string }[]
  itemCount: number
}

const MAX_AGENT_ROUNDS = 3
const MAX_DEEP_AGENT_ROUNDS = 5
const MAX_TOOL_CONTEXT_CHARS = 48_000

const CHAT_AGENT_TOOL_REGISTRY: ChatAgentToolDefinition[] = [
  {
    name: "project_files",
    action: "project_files",
    stage: "searching_wiki",
    label: "Project Files",
    description: "List project and wiki files through the same project-bound file access used by the local API/MCP tools.",
    requiresProject: true,
  },
  {
    name: "project_file_read",
    action: "project_file_read",
    stage: "searching_wiki",
    label: "Project File Read",
    description: "Read a specific project text file by relative path when the user names a file or asks to inspect one.",
    requiresProject: true,
  },
  {
    name: "wiki_search",
    action: "wiki_search",
    stage: "searching_wiki",
    label: "Wiki Search",
    description: "Search local wiki pages and retrieve relevant page content.",
    requiresProject: true,
  },
  {
    name: "graph_search",
    action: "graph_search",
    stage: "searching_graph",
    label: "Graph Search",
    description: "Inspect relationships between wiki entities, concepts, and pages.",
    requiresProject: true,
  },
  {
    name: "web_search",
    action: "external_search",
    stage: "searching_web",
    label: "Web Search",
    description: "Search enabled web providers for current or external information.",
  },
  {
    name: "anytxt_search",
    action: "external_search",
    stage: "searching_anytxt",
    label: "AnyTXT Search",
    description: "Search external local files indexed by AnyTXT.",
  },
]

export function getChatAgentTools(args: {
  hasProject: boolean
  webSearchEnabled: boolean
  anyTxtSearchEnabled: boolean
  mode?: ChatAgentMode
}): ChatAgentToolDefinition[] {
  return CHAT_AGENT_TOOL_REGISTRY.filter((tool) => {
    if (tool.requiresProject && !args.hasProject) return false
    if (tool.name === "web_search") return args.webSearchEnabled && args.mode !== "local_first"
    if (tool.name === "anytxt_search") return args.anyTxtSearchEnabled
    if (tool.name === "project_file_read") return args.mode !== "fast"
    return true
  })
}

export function shouldBypassAgentPlanner(text: string): ChatAgentDecision | null {
  const q = text.trim()
  const lower = q.toLowerCase()
  if (!q) return { action: "answer", queries: [], reason: "empty" }

  if (isGreeting(q)) {
    return { action: "answer", queries: [], reason: "greeting" }
  }

  if (/^(继续|接着说|展开|展开一下|详细说说|换个说法|重新说|总结一下|总结上面|翻译|翻译成英文|翻译成中文|这是什么意思|什么意思)[\s\S]{0,30}$/i.test(q)) {
    return { action: "answer", queries: [], reason: "short follow-up" }
  }

  if (
    /^(continue|go on|expand|summari[sz]e|translate|rewrite|rephrase|what do you mean)\b/i.test(lower) &&
    q.length < 120
  ) {
    return { action: "answer", queries: [], reason: "short follow-up" }
  }

  return null
}

export async function buildChatAgentMessages(input: ChatAgentInput): Promise<ChatAgentResult> {
  throwIfAborted(input.signal)
  const deps = {
    searchWiki,
    webSearch,
    anyTxtSearchSmart,
    streamChat,
    ...input.deps,
  }
  const projectPath = input.project ? normalizePath(input.project.path) : ""
  const searchConfig = resolveSearchConfig(input.searchApiConfig)
  const observations: ToolObservation[] = []
  const historicalObservations = await buildHistoricalObservations({
    projectPath,
    references: input.retrievalHistory ?? [],
    llmConfig: input.llmConfig,
  })
  const plan: ChatAgentDecision[] = []
  const steps: ChatAgentStep[] = []
  const executedToolKeys = new Set<string>()
  const enabledTools = getChatAgentTools({
    hasProject: Boolean(input.project),
    webSearchEnabled: input.options.useWebSearch,
    anyTxtSearchEnabled: input.options.useAnyTxtSearch,
    mode: input.options.mode ?? "standard",
  })
  const projectRoutingContext = input.project
    ? await readProjectRoutingContext(projectPath, input.text, input.llmConfig)
    : undefined

  const direct = shouldBypassAgentPlanner(input.text)
  if (direct) {
    plan.push(direct)
    steps.push({
      id: makeStepId(steps),
      type: "understanding",
      message: direct.reason ?? "Direct answer",
      status: "success",
    })
  } else {
    input.onEvent?.({ stage: "understanding", status: "running" })
    const understanding = await understandUserQuery({
      llmConfig: input.llmConfig,
      text: input.text,
      historyMessages: input.historyMessages,
      hasProject: Boolean(input.project),
      projectContext: projectRoutingContext,
      webSearchEnabled: input.options.useWebSearch,
      anyTxtSearchEnabled: input.options.useAnyTxtSearch,
      mode: input.options.mode ?? "standard",
      tools: enabledTools,
      signal: input.signal,
      streamChatImpl: deps.streamChat,
    })
    steps.push({
      id: makeStepId(steps),
      type: "understanding",
      query: understanding.rewrittenQuery,
      message: understanding.reason ?? understanding.intent,
      status: "success",
    })
    input.onEvent?.({
      stage: "understanding",
      query: understanding.rewrittenQuery,
      message: understanding.reason ?? understanding.intent,
      status: "success",
    })

    const understandingDecision = decisionFromUnderstanding(understanding, input.text)
    if (understandingDecision.action === "answer") {
      plan.push(understandingDecision)
    }

    const maxRounds = input.options.mode === "deep" ? MAX_DEEP_AGENT_ROUNDS : MAX_AGENT_ROUNDS
    for (let round = 0; round < maxRounds; round++) {
      if (plan[plan.length - 1]?.action === "answer") break
      throwIfAborted(input.signal)
      const observationsBefore = observations.length
      input.onEvent?.({ stage: "routing", status: "running" })
      const decision = await decideNextAction({
        llmConfig: input.llmConfig,
        text: input.text,
        understanding,
        tools: enabledTools,
        historyMessages: input.historyMessages,
        observations,
        historicalObservations,
        projectName: input.project?.name,
        hasProject: Boolean(input.project),
        projectContext: projectRoutingContext,
        webSearchEnabled: input.options.useWebSearch,
        anyTxtSearchEnabled: input.options.useAnyTxtSearch,
        mode: input.options.mode ?? "standard",
        signal: input.signal,
        streamChatImpl: deps.streamChat,
      })
      throwIfAborted(input.signal)
      plan.push(decision)
      steps.push({
        id: makeStepId(steps),
        type: "routing",
        query: decision.queries.join(" | "),
        message: decision.reason ?? decision.action,
        status: "success",
      })
      input.onEvent?.({
        stage: "routing",
        query: decision.queries.join(" | "),
        message: decision.reason ?? decision.action,
        status: "success",
      })
      if (decision.action === "answer" || decision.action === "finish") break

      const queries = normalizeDecisionQueries(decision, input.text)
      if (queries.length === 0) break
      const toolKey = `${decision.action}:${queries.map((query) => query.toLowerCase()).join("|")}`
      if (executedToolKeys.has(toolKey)) break
      executedToolKeys.add(toolKey)

      if ((decision.action === "project_files" || decision.action === "multi_search") && input.project) {
        throwIfAborted(input.signal)
        const tool = enabledTools.find((item) => item.name === "project_files")
        if (tool) {
          emitToolCall({ tool, queries, steps, onEvent: input.onEvent })
          const observation = await runProjectFilesTool({
            projectPath,
            queries,
            llmConfig: input.llmConfig,
          })
          observations.push(observation)
          emitToolResult({ tool, observation, steps, onEvent: input.onEvent })
        }
      }

      if ((decision.action === "project_file_read" || decision.action === "multi_search") && input.project) {
        throwIfAborted(input.signal)
        const tool = enabledTools.find((item) => item.name === "project_file_read")
        if (tool) {
          emitToolCall({ tool, queries, steps, onEvent: input.onEvent })
          const observation = await runProjectFileReadTool({
            projectPath,
            queries,
            llmConfig: input.llmConfig,
          })
          observations.push(observation)
          emitToolResult({ tool, observation, steps, onEvent: input.onEvent })
        }
      }

      if ((decision.action === "wiki_search" || decision.action === "multi_search") && input.project) {
        throwIfAborted(input.signal)
        const tool = enabledTools.find((item) => item.name === "wiki_search")
        if (tool) {
          emitToolCall({ tool, queries, steps, onEvent: input.onEvent })
          const observation = await runWikiSearchTool({
            projectPath,
            queries,
            llmConfig: input.llmConfig,
            searchWikiImpl: deps.searchWiki,
          })
          observations.push(observation)
          emitToolResult({ tool, observation, steps, onEvent: input.onEvent })
        }
      }

      if ((decision.action === "graph_search" || decision.action === "multi_search") && input.project) {
        throwIfAborted(input.signal)
        const tool = enabledTools.find((item) => item.name === "graph_search")
        if (tool) {
          emitToolCall({ tool, queries, steps, onEvent: input.onEvent })
          const observation = await runGraphSearchTool({
            projectPath,
            dataVersion: input.dataVersion,
            queries,
            llmConfig: input.llmConfig,
            searchWikiImpl: deps.searchWiki,
          })
          observations.push(observation)
          emitToolResult({ tool, observation, steps, onEvent: input.onEvent })
        }
      }

      if ((decision.action === "external_search" || decision.action === "multi_search") && input.options.useWebSearch) {
        throwIfAborted(input.signal)
        const tool = enabledTools.find((item) => item.name === "web_search")
        if (tool) {
          emitToolCall({ tool, queries, steps, onEvent: input.onEvent })
          const observation = await runExternalSearchTool({
            queries,
            searchConfig,
            webSearchImpl: deps.webSearch,
            source: "web",
          })
          observations.push(observation)
          emitToolResult({ tool, observation, steps, onEvent: input.onEvent })
        }
      }

      if ((decision.action === "external_search" || decision.action === "multi_search") && input.options.useAnyTxtSearch) {
        throwIfAborted(input.signal)
        const tool = enabledTools.find((item) => item.name === "anytxt_search")
        if (tool) {
          emitToolCall({ tool, queries, steps, onEvent: input.onEvent })
          const observation = await runExternalSearchTool({
            queries,
            searchConfig,
            llmConfig: input.llmConfig,
            projectPath,
            anyTxtSearchSmartImpl: deps.anyTxtSearchSmart,
            source: "anytxt",
          })
          observations.push(observation)
          emitToolResult({ tool, observation, steps, onEvent: input.onEvent })
        }
      }

      if (observations.length === observationsBefore) break
    }
  }

  throwIfAborted(input.signal)
  const lastDecision = plan[plan.length - 1]
  const observationsForAnswer = observations.length > 0
    ? observations
    : lastDecision?.action === "finish"
      ? historicalObservations
      : []
  if (observations.length > 0) input.onEvent?.({ stage: "reading_context" })
  const projectContext = input.project && observationsForAnswer.some((obs) =>
    obs.tool === "project_files"
    || obs.tool === "project_file_read"
    || obs.tool === "wiki_search"
    || obs.tool === "graph_search")
    ? await readProjectPromptContext(projectPath, input.text, input.llmConfig)
    : undefined
  const retrievedContext = buildRetrievedContext(observationsForAnswer, input.text, input.llmConfig)
  throwIfAborted(input.signal)
  input.onEvent?.({ stage: "writing" })
  steps.push({
    id: makeStepId(steps),
    type: "final",
    message: retrievedContext.itemCount > 0 ? "Answer with retrieved context" : "Direct answer",
    count: retrievedContext.references.length,
    status: "success",
  })
  return {
    messages: buildFinalMessages({
      project: input.project,
      text: input.text,
      historyMessages: input.historyMessages,
      observations: observationsForAnswer,
      retrievedContext,
      directAnswerHint: plan.find((item) => item.answer)?.answer,
      projectContext,
    }),
    references: retrievedContext.references,
    queryPages: retrievedContext.pages,
    plan,
    steps,
  }
}

async function decideNextAction(args: {
  llmConfig: LlmConfig
  text: string
  understanding: ChatQueryUnderstanding
  tools: ChatAgentToolDefinition[]
  historyMessages: LLMMessage[]
  observations: ToolObservation[]
  historicalObservations: ToolObservation[]
  projectName?: string
  hasProject: boolean
  projectContext?: ProjectPromptContext
  webSearchEnabled: boolean
  anyTxtSearchEnabled: boolean
  mode: ChatAgentMode
  signal?: AbortSignal
  streamChatImpl: typeof streamChat
}): Promise<ChatAgentDecision> {
  const externalEnabled = args.webSearchEnabled || args.anyTxtSearchEnabled
  const toolDescriptions = args.tools.length > 0
    ? args.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
    : "- none"
  const system = [
    "You are a routing controller for a local knowledge assistant.",
    "Return JSON only. Do not answer in prose.",
    "",
    "Available actions:",
    "- answer: answer from conversation history or general reasoning without retrieval.",
    "- project_files: list project/wiki files when the user asks what exists, asks for project structure, or names files/pages imprecisely.",
    "- project_file_read: read a specific project text file when the user names a path or asks to inspect a known file.",
    "- wiki_search: search the local wiki when the user asks about project/wiki/docs/knowledge.",
    "- graph_search: inspect relationships between entities/concepts/pages.",
    "- external_search: search enabled external information sources.",
    "- multi_search: use more than one retrieval source.",
    "- finish: enough tool observations are available; final answer can be produced.",
    "",
    "Enabled tools:",
    toolDescriptions,
    "",
    "Return shape:",
    "{\"action\":\"answer|project_files|project_file_read|wiki_search|graph_search|external_search|multi_search|finish\",\"queries\":[\"short query or relative file path\"],\"answer\":\"optional direct draft\",\"reason\":\"short reason\"}",
    "",
    "Rules:",
    "- Do not retrieve for greetings, casual chat, translation/rewrite/summarize/follow-up requests about prior assistant messages.",
    "- Use wiki_search for questions about the local wiki, project materials, documents, notes, or remembered knowledge.",
    "- Use the project overview/purpose/index below to judge whether the local wiki is likely to contain the answer.",
    "- If the project overview says the current topic is in scope, prefer wiki_search or multi_search before relying only on external_search.",
    "- Use project_files before project_file_read when the user gives a fuzzy file/page name and you need to locate likely paths.",
    "- Use graph_search for relationships, dependencies, links, entities, concepts, clusters, or graph questions.",
    "- If the user enabled Web Search for this turn, treat that as a strong preference to use external_search or multi_search for current facts, web pages, public docs, product/API details, news, versions, pricing, or anything likely outside the local wiki.",
    "- If the user enabled AnyTXT Search for this turn, treat that as a strong preference to use external_search or multi_search when the answer may depend on external local files outside the wiki.",
    "- Do not repeat external_search for simple follow-ups, summaries, rewrites, translations, or questions that can be answered from already available observations/history, unless the user explicitly asks to search again or asks for newer information.",
    "- Never choose external_search if no external source is enabled.",
    "- In local_first mode, prefer project_files, project_file_read, wiki_search, or graph_search; use external_search only when the user explicitly asks for external information.",
    "- In fast mode, avoid multi-step file inspection; prefer answer or a single wiki_search when retrieval is clearly needed.",
    "- In deep mode, you may use multiple tools when the question requires broader evidence.",
    "- If tool observations are already enough, choose finish.",
    "- Keep queries concise and keyword-rich.",
  ].join("\n")

  const recentHistory = args.historyMessages.slice(-6).map((msg) => {
    const content = typeof msg.content === "string"
      ? msg.content
      : msg.content.map((block) => block.type === "text" ? block.text : "[image]").join("\n")
    return `${msg.role}: ${content.slice(0, 1200)}`
  }).join("\n\n")

  const observations = args.observations.map((obs, index) => [
    `Observation ${index + 1}: ${obs.tool}`,
    `Query: ${obs.query}`,
    obs.content.slice(0, 5000),
  ].join("\n")).join("\n\n---\n\n")

  const historyObservations = args.historicalObservations.map((obs, index) => [
    `Historical observation ${index + 1}: ${obs.tool}`,
    `Query: ${obs.query}`,
    obs.content.slice(0, 3000),
  ].join("\n")).join("\n\n---\n\n")

  const user = [
    `Project: ${args.projectName ?? "none"}`,
    `Local wiki available: ${args.hasProject ? "yes" : "no"}`,
    `External search enabled: ${externalEnabled ? "yes" : "no"}`,
    `Agent mode: ${args.mode}`,
    `User enabled Web Search for this turn: ${args.webSearchEnabled ? "yes" : "no"}`,
    `User enabled AnyTXT Search for this turn: ${args.anyTxtSearchEnabled ? "yes" : "no"}`,
    `Query understanding: ${JSON.stringify(args.understanding)}`,
    "",
    formatProjectContextForRouting(args.projectContext),
    "",
    recentHistory ? `Recent conversation:\n${recentHistory}` : "Recent conversation: none",
    "",
    observations ? `Tool observations:\n${observations}` : "Tool observations: none",
    "",
    historyObservations
      ? [
          "Recent retrieval history:",
          historyObservations,
          "Use this only when the current message is a follow-up to the earlier retrieved sources. If it already answers the current follow-up, choose finish instead of repeating the same search.",
        ].join("\n")
      : "Recent retrieval history: none",
    "",
    `Current user message:\n${args.text}`,
  ].join("\n")

  const raw = await collectChatText(args.llmConfig, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], args.streamChatImpl, args.signal, { temperature: 0, max_tokens: 300 })

  return parseDecision(raw, args.text)
}

async function understandUserQuery(args: {
  llmConfig: LlmConfig
  text: string
  historyMessages: LLMMessage[]
  hasProject: boolean
  projectContext?: ProjectPromptContext
  webSearchEnabled: boolean
  anyTxtSearchEnabled: boolean
  mode: ChatAgentMode
  tools: ChatAgentToolDefinition[]
  signal?: AbortSignal
  streamChatImpl: typeof streamChat
}): Promise<ChatQueryUnderstanding> {
  const toolDescriptions = args.tools.length > 0
    ? args.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")
    : "- none"
  const system = [
    "You are the query understanding stage for a local knowledge assistant.",
    "Return JSON only. Do not answer the user.",
    "",
    "Classify the current message and produce search-ready queries.",
    "Return shape:",
    "{\"intent\":\"chitchat|follow_up|rewrite|kb_search|graph|external|mixed\",\"rewrittenQuery\":\"short normalized query\",\"wikiQueries\":[\"...\"],\"graphQueries\":[\"...\"],\"externalQueries\":[\"...\"],\"needsWiki\":true,\"needsGraph\":false,\"needsExternal\":false,\"isFollowUp\":false,\"reason\":\"short reason\"}",
    "",
    "Rules:",
    "- chitchat/follow_up/rewrite should not require retrieval unless the user explicitly asks to search.",
    "- Use kb_search for local wiki/project/document questions.",
    "- Use the project overview/purpose/index below to judge whether the local wiki is likely to contain the answer.",
    "- If the project overview says the current topic is in scope, set needsWiki=true. If current external facts are also useful, use mixed instead of external-only.",
    "- Use graph for relationship/entity/connection questions.",
    "- Use external for current facts, public docs, web pages, product/API details, versions, pricing, or local files outside the wiki when the matching external source is enabled.",
    "- Use mixed when local wiki plus external sources are both useful.",
    "- In local_first mode, set needsWiki=true for any topic plausibly covered by the project.",
    "- In fast mode, be conservative about extra tools.",
    "- In deep mode, prefer mixed when both local and external evidence could help.",
    "- Keep each query concise and keyword-rich.",
    "",
    "Enabled tools:",
    toolDescriptions,
  ].join("\n")

  const recentHistory = args.historyMessages.slice(-6).map((msg) => {
    const content = typeof msg.content === "string"
      ? msg.content
      : msg.content.map((block) => block.type === "text" ? block.text : "[image]").join("\n")
    return `${msg.role}: ${content.slice(0, 1000)}`
  }).join("\n\n")

  const user = [
    `Local wiki available: ${args.hasProject ? "yes" : "no"}`,
    `Web Search enabled: ${args.webSearchEnabled ? "yes" : "no"}`,
    `AnyTXT Search enabled: ${args.anyTxtSearchEnabled ? "yes" : "no"}`,
    `Agent mode: ${args.mode}`,
    `User enabled Web Search for this turn: ${args.webSearchEnabled ? "yes" : "no"}`,
    `User enabled AnyTXT Search for this turn: ${args.anyTxtSearchEnabled ? "yes" : "no"}`,
    "",
    formatProjectContextForRouting(args.projectContext),
    "",
    recentHistory ? `Recent conversation:\n${recentHistory}` : "Recent conversation: none",
    "",
    `Current user message:\n${args.text}`,
  ].join("\n")

  const raw = await collectChatText(args.llmConfig, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], args.streamChatImpl, args.signal, { temperature: 0, max_tokens: 450 })

  return parseUnderstanding(raw, args.text, {
    hasProject: args.hasProject,
    webSearchEnabled: args.webSearchEnabled,
    anyTxtSearchEnabled: args.anyTxtSearchEnabled,
  })
}

export function parseUnderstanding(
  raw: string,
  fallbackQuery: string,
  availability: { hasProject: boolean; webSearchEnabled: boolean; anyTxtSearchEnabled: boolean },
): ChatQueryUnderstanding {
  const fallback = fallbackUnderstanding(fallbackQuery, availability)
  const text = raw.trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  const json = start >= 0 && end > start ? text.slice(start, end + 1) : text
  try {
    const parsed = JSON.parse(json) as Partial<ChatQueryUnderstanding & ChatAgentDecision>
    const intent = normalizeIntent(parsed.intent)
    const rewrittenQuery = typeof parsed.rewrittenQuery === "string" && parsed.rewrittenQuery.trim()
      ? parsed.rewrittenQuery.trim()
      : fallback.rewrittenQuery
    const wikiQueries = normalizeQueryList(parsed.wikiQueries, rewrittenQuery)
    const graphQueries = normalizeQueryList(parsed.graphQueries, rewrittenQuery)
    const externalQueries = normalizeQueryList(parsed.externalQueries, rewrittenQuery)
    return {
      intent,
      rewrittenQuery,
      wikiQueries,
      graphQueries,
      externalQueries,
      needsWiki: typeof parsed.needsWiki === "boolean" ? parsed.needsWiki : fallback.needsWiki,
      needsGraph: typeof parsed.needsGraph === "boolean" ? parsed.needsGraph : fallback.needsGraph,
      needsExternal: typeof parsed.needsExternal === "boolean" ? parsed.needsExternal : fallback.needsExternal,
      isFollowUp: typeof parsed.isFollowUp === "boolean" ? parsed.isFollowUp : intent === "follow_up",
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : fallback.reason,
    }
  } catch {
    return fallback
  }
}

function fallbackUnderstanding(
  query: string,
  availability: { hasProject: boolean; webSearchEnabled: boolean; anyTxtSearchEnabled: boolean },
): ChatQueryUnderstanding {
  const lower = query.toLowerCase()
  const needsGraph = /(关系|关联|连接|图谱|依赖|relationship|related|graph|connection|linked)/i.test(query)
  const needsExternal = availability.webSearchEnabled && /(latest|current|today|news|price|version|docs|api|最新|现在|今天|新闻|价格|版本|官方文档)/i.test(lower)
  const needsWiki = availability.hasProject && (!needsExternal || availability.anyTxtSearchEnabled)
  const intent: ChatAgentIntent = needsGraph
    ? "graph"
    : needsExternal && needsWiki
      ? "mixed"
      : needsExternal
        ? "external"
        : needsWiki
          ? "kb_search"
          : "chitchat"
  return {
    intent,
    rewrittenQuery: query.trim(),
    wikiQueries: needsWiki ? [query.trim()] : [],
    graphQueries: needsGraph ? [query.trim()] : [],
    externalQueries: needsExternal || availability.anyTxtSearchEnabled ? [query.trim()] : [],
    needsWiki,
    needsGraph,
    needsExternal: needsExternal || availability.anyTxtSearchEnabled,
    isFollowUp: false,
    reason: "fallback understanding",
  }
}

function normalizeIntent(intent: unknown): ChatAgentIntent {
  switch (intent) {
    case "chitchat":
    case "follow_up":
    case "rewrite":
    case "kb_search":
    case "graph":
    case "external":
    case "mixed":
      return intent
    default:
      return "kb_search"
  }
}

function normalizeQueryList(value: unknown, fallback: string): string[] {
  if (!Array.isArray(value)) return fallback ? [fallback] : []
  const queries = value.map((item) => String(item).trim()).filter(Boolean)
  return (queries.length > 0 ? queries : fallback ? [fallback] : []).slice(0, 5)
}

function decisionFromUnderstanding(understanding: ChatQueryUnderstanding, fallback: string): ChatAgentDecision {
  if (understanding.intent === "chitchat" || understanding.intent === "rewrite") {
    return {
      action: "answer",
      queries: [],
      reason: understanding.reason ?? understanding.intent,
    }
  }
  if (understanding.intent === "follow_up") {
    return {
      action: "finish",
      queries: [],
      reason: understanding.reason ?? understanding.intent,
    }
  }
  if (understanding.needsWiki && understanding.needsGraph || understanding.needsWiki && understanding.needsExternal) {
    return { action: "multi_search", queries: preferredQueries(understanding, fallback), reason: understanding.reason }
  }
  if (understanding.needsGraph) {
    return { action: "graph_search", queries: nonEmptyQueries(understanding.graphQueries, fallback), reason: understanding.reason }
  }
  if (understanding.needsExternal) {
    return { action: "external_search", queries: nonEmptyQueries(understanding.externalQueries, fallback), reason: understanding.reason }
  }
  if (understanding.needsWiki) {
    return { action: "wiki_search", queries: nonEmptyQueries(understanding.wikiQueries, fallback), reason: understanding.reason }
  }
  return { action: "answer", queries: [], reason: understanding.reason }
}

function preferredQueries(understanding: ChatQueryUnderstanding, fallback: string): string[] {
  return nonEmptyQueries([
    ...understanding.wikiQueries,
    ...understanding.graphQueries,
    ...understanding.externalQueries,
  ], fallback)
}

function nonEmptyQueries(queries: string[], fallback: string): string[] {
  const normalized = queries.map((q) => q.trim()).filter(Boolean)
  return (normalized.length > 0 ? normalized : [fallback]).slice(0, 5)
}

export function parseDecision(raw: string, fallbackQuery: string): ChatAgentDecision {
  const text = raw.trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  const json = start >= 0 && end > start ? text.slice(start, end + 1) : text
  try {
    const parsed = JSON.parse(json) as Partial<ChatAgentDecision>
    const action = normalizeAction(parsed.action)
    return {
      action,
      queries: Array.isArray(parsed.queries)
        ? parsed.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 5)
        : [fallbackQuery],
      answer: typeof parsed.answer === "string" ? parsed.answer.trim() : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : undefined,
    }
  } catch {
    return { action: "wiki_search", queries: [fallbackQuery], reason: "router fallback" }
  }
}

function normalizeAction(action: unknown): ChatAgentAction {
  switch (action) {
    case "answer":
    case "project_files":
    case "project_file_read":
    case "wiki_search":
    case "graph_search":
    case "external_search":
    case "multi_search":
    case "finish":
      return action
    default:
      return "wiki_search"
  }
}

function normalizeDecisionQueries(decision: ChatAgentDecision, fallback: string): string[] {
  const queries = decision.queries.map((q) => q.trim()).filter(Boolean)
  return (queries.length > 0 ? queries : [fallback]).slice(0, 5)
}

async function runProjectFilesTool(args: {
  projectPath: string
  queries: string[]
  llmConfig: LlmConfig
}): Promise<ToolObservation> {
  const maxEntries = args.llmConfig.maxContextSize > 180_000 ? 160 : 80
  const [wikiTree, rawTree] = await Promise.all([
    listDirectory(`${args.projectPath}/wiki`).catch(() => [] as FileNode[]),
    listDirectory(`${args.projectPath}/raw/sources`).catch(() => [] as FileNode[]),
  ])
  const wikiEntries = flattenFileTree(wikiTree, "wiki").slice(0, maxEntries)
  const rawEntries = flattenFileTree(rawTree, "raw/sources").slice(0, Math.floor(maxEntries / 2))
  const content = [
    "# Project file listing",
    `Query: ${args.queries.join(" | ")}`,
    "",
    "## Wiki files",
    wikiEntries.length > 0 ? wikiEntries.map((entry) => `- ${entry}`).join("\n") : "(none)",
    wikiEntries.length >= maxEntries ? "\n[...wiki listing truncated...]" : "",
    "",
    "## Source files",
    rawEntries.length > 0 ? rawEntries.map((entry) => `- ${entry}`).join("\n") : "(none)",
    rawEntries.length >= Math.floor(maxEntries / 2) ? "\n[...source listing truncated...]" : "",
  ].filter(Boolean).join("\n")
  const reference: MessageReference = {
    title: "Project file listing",
    path: `${args.projectPath}/wiki/index.md`,
    kind: "wiki",
    snippet: wikiEntries.slice(0, 10).join("\n"),
  }
  return {
    tool: "project_files",
    query: args.queries.join(" | "),
    content,
    references: [reference],
    pages: [],
    items: [{
      id: "project-files",
      kind: "wiki",
      source: "project_files",
      title: "Project file listing",
      path: `${args.projectPath}/wiki/index.md`,
      snippet: wikiEntries.slice(0, 10).join("\n"),
      content,
      score: 0.8,
      query: args.queries.join(" | "),
      reference,
    }],
    errorCount: 0,
  }
}

async function runProjectFileReadTool(args: {
  projectPath: string
  queries: string[]
  llmConfig: LlmConfig
}): Promise<ToolObservation> {
  const { maxPageSize } = computeContextBudget(args.llmConfig.maxContextSize)
  const pages: PageEntry[] = []
  const errors: string[] = []
  for (const query of args.queries.slice(0, 5)) {
    const rel = normalizeProjectRelativePath(query)
    if (!rel || !isReadableProjectTextPath(rel)) {
      errors.push(`Skipped unsafe or unsupported path: ${query}`)
      continue
    }
    try {
      const raw = await readFile(`${args.projectPath}/${rel}`)
      const content = raw.length > maxPageSize
        ? `${raw.slice(0, maxPageSize)}\n\n[...truncated...]`
        : raw
      pages.push({
        title: getFileName(rel),
        path: rel,
        content,
        priority: pages.length,
      })
    } catch (err) {
      errors.push(`Failed to read ${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    tool: "project_file_read",
    query: args.queries.join(" | "),
    content: [
      formatWikiObservation("Project file contents", pages, []),
      errors.length > 0 ? `Errors:\n${errors.map((err) => `- ${err}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
    references: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}`, kind: "wiki" as const })),
    pages: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}` })),
    items: pages.map((page) => pageToRetrievedItem({
      projectPath: args.projectPath,
      page,
      query: args.queries.join(" | "),
      kind: "wiki",
      source: "project_file_read",
      score: 0.95,
    })),
    errorCount: errors.length,
  }
}

async function readProjectRoutingContext(
  projectPath: string,
  query: string,
  llmConfig: LlmConfig,
): Promise<ProjectPromptContext> {
  const { indexBudget } = computeContextBudget(llmConfig.maxContextSize)
  const [purpose, overview, rawIndex] = await Promise.all([
    readFile(`${projectPath}/purpose.md`).catch(() => ""),
    readFile(`${projectPath}/wiki/overview.md`).catch(() => ""),
    readFile(`${projectPath}/wiki/index.md`).catch(() => ""),
  ])
  return {
    purpose: trimForBudget(purpose, 2500),
    overview: trimForBudget(overview, Math.min(7000, Math.max(2500, Math.floor(indexBudget * 0.4)))),
    index: trimRelevantIndex(rawIndex, query, Math.min(5000, Math.max(1800, Math.floor(indexBudget * 0.35)))),
  }
}

function formatProjectContextForRouting(context?: ProjectPromptContext): string {
  if (!context || (!context.purpose.trim() && !context.overview.trim() && !context.index.trim())) {
    return "Project context: none"
  }
  return [
    "Project context for routing:",
    context.purpose.trim() ? `## Project Purpose\n${context.purpose.trim()}` : "",
    context.overview.trim() ? `## Current Wiki Overview\n${context.overview.trim()}` : "",
    context.index.trim() ? `## Wiki Index Signals\n${context.index.trim()}` : "",
  ].filter(Boolean).join("\n\n")
}

function trimRelevantIndex(rawIndex: string, query: string, maxChars: number): string {
  if (!rawIndex.trim()) return ""
  if (rawIndex.length <= maxChars) return rawIndex
  const tokens = tokenizeIndexQuery(query)
  const lines = rawIndex.split("\n")
  const keptLines: string[] = []
  let keptSize = 0
  for (const line of lines) {
    const isHeader = line.startsWith("#")
    const lower = line.toLowerCase()
    const isRelevant = tokens.length === 0 || tokens.some((token) => lower.includes(token))
    if (!isHeader && !isRelevant) continue
    if (keptSize + line.length + 1 > maxChars) continue
    keptLines.push(line)
    keptSize += line.length + 1
  }
  return keptLines.length > 0
    ? `${keptLines.join("\n")}\n\n[...index trimmed to routing-relevant entries...]`
    : rawIndex.slice(0, Math.max(0, maxChars - 40)).trimEnd() + "\n[...index truncated...]"
}

function flattenFileTree(nodes: FileNode[], prefix: string): string[] {
  const out: string[] = []
  const walk = (items: FileNode[], base: string) => {
    for (const node of items) {
      const rel = `${base}/${node.name}`.replace(/\/+/g, "/")
      if (node.is_dir) {
        if (node.children) walk(node.children, rel)
      } else {
        out.push(rel)
      }
    }
  }
  walk(nodes, prefix)
  return out.sort((a, b) => a.localeCompare(b))
}

function normalizeProjectRelativePath(input: string): string {
  const stripped = input
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\.\//, "")
  const normalized = normalizePath(stripped)
    .replace(/^\/+/, "")
    .replace(/^.*?\/(wiki|raw\/sources)\//, "$1/")
  if (!normalized || normalized.includes("\0")) return ""
  if (normalized.split("/").some((part) => part === ".." || part.startsWith("."))) return ""
  return normalized
}

function isReadableProjectTextPath(rel: string): boolean {
  const lower = rel.toLowerCase()
  if (!lower.startsWith("wiki/") && !lower.startsWith("raw/sources/") && lower !== "purpose.md" && lower !== "schema.md") {
    return false
  }
  return /\.(md|mdx|txt|json|yaml|yml|csv|tsv|log)$/i.test(lower)
    || lower === "purpose.md"
    || lower === "schema.md"
}

function makeStepId(steps: ChatAgentStep[]): string {
  return `step-${steps.length + 1}`
}

function emitToolCall(args: {
  tool: ChatAgentToolDefinition
  queries: string[]
  steps: ChatAgentStep[]
  onEvent?: (event: ChatAgentEvent) => void
}): void {
  const query = args.queries.join(" | ")
  args.steps.push({
    id: makeStepId(args.steps),
    type: "tool_call",
    tool: args.tool.name,
    query,
    message: args.tool.label,
    status: "running",
  })
  args.onEvent?.({
    stage: "tool_call",
    tool: args.tool.name,
    query,
    message: args.tool.label,
    status: "running",
  })
  args.onEvent?.({
    stage: args.tool.stage,
    tool: args.tool.name,
    query,
    message: args.tool.label,
    status: "running",
  })
}

function emitToolResult(args: {
  tool: ChatAgentToolDefinition
  observation: ToolObservation
  steps: ChatAgentStep[]
  onEvent?: (event: ChatAgentEvent) => void
}): void {
  const count = args.observation.references.length
  const status = args.observation.errorCount && count === 0 ? "error" : "success"
  const message = count > 0
    ? `${args.tool.label}: ${count} result${count === 1 ? "" : "s"}`
    : args.observation.errorCount
      ? `${args.tool.label}: failed`
      : `${args.tool.label}: no results`
  args.steps.push({
    id: makeStepId(args.steps),
    type: "tool_result",
    tool: args.tool.name,
    query: args.observation.query,
    message,
    count,
    status,
  })
  args.onEvent?.({
    stage: "tool_result",
    tool: args.tool.name,
    query: args.observation.query,
    message,
    count,
    status,
  })
}

async function runWikiSearchTool(args: {
  projectPath: string
  queries: string[]
  llmConfig: LlmConfig
  searchWikiImpl: typeof searchWiki
}): Promise<ToolObservation> {
  const { pageBudget, maxPageSize } = computeContextBudget(args.llmConfig.maxContextSize)
  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const query of args.queries.slice(0, 3)) {
    for (const result of await args.searchWikiImpl(args.projectPath, query)) {
      const key = normalizePath(result.path)
      if (seen.has(key)) continue
      seen.add(key)
      results.push(result)
      if (results.length >= 8) break
    }
    if (results.length >= 8) break
  }

  const pages = await materializePages(args.projectPath, results, Math.min(pageBudget, MAX_TOOL_CONTEXT_CHARS), maxPageSize)
  return {
    tool: "wiki_search",
    query: args.queries.join(" | "),
    content: formatWikiObservation("Wiki search results", pages, results),
    references: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}`, kind: "wiki" as const })),
    pages: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}` })),
    items: pages.map((page) => pageToRetrievedItem({
      projectPath: args.projectPath,
      page,
      query: args.queries.join(" | "),
      kind: "wiki",
      source: "wiki",
      score: searchScoreForPage(page, results),
    })),
    errorCount: 0,
  }
}

async function runGraphSearchTool(args: {
  projectPath: string
  dataVersion: number
  queries: string[]
  llmConfig: LlmConfig
  searchWikiImpl: typeof searchWiki
}): Promise<ToolObservation> {
  const base = await args.searchWikiImpl(args.projectPath, args.queries[0] ?? "")
  const graph = await buildRetrievalGraph(args.projectPath, args.dataVersion)
  const candidates = new Map<string, { title: string; path: string; relevance: number }>()
  const hitPaths = new Set(base.slice(0, 6).map((item) => normalizePath(item.path)))

  for (const result of base.slice(0, 6)) {
    const fileName = getFileName(result.path)
    const nodeId = fileName.replace(/\.md$/, "")
    for (const { node, relevance } of getRelatedNodes(nodeId, graph, 5)) {
      if (relevance < 1.5) continue
      if (hitPaths.has(normalizePath(node.path))) continue
      const nodePath = normalizePath(node.path)
      const absoluteNodePath = nodePath.startsWith(`${args.projectPath}/`)
        ? nodePath
        : `${args.projectPath}/${nodePath.replace(/^\/+/, "")}`
      const current = candidates.get(nodePath)
      if (!current || relevance > current.relevance) {
        candidates.set(nodePath, { title: node.title, path: absoluteNodePath, relevance })
      }
    }
  }

  const relatedResults: SearchResult[] = [...candidates.values()]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 8)
    .map((item) => ({
      path: item.path,
      title: item.title,
      snippet: `Graph relevance ${item.relevance.toFixed(2)}`,
      titleMatch: false,
      score: item.relevance,
      images: [],
    }))

  const pages = await materializePages(args.projectPath, relatedResults, Math.min(computeContextBudget(args.llmConfig.maxContextSize).pageBudget, 24_000), 6000)
  return {
    tool: "graph_search",
    query: args.queries.join(" | "),
    content: formatWikiObservation("Graph-related pages", pages, relatedResults),
    references: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}`, kind: "wiki" as const })),
    pages: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}` })),
    items: pages.map((page) => pageToRetrievedItem({
      projectPath: args.projectPath,
      page,
      query: args.queries.join(" | "),
      kind: "graph",
      source: "graph",
      score: searchScoreForPage(page, relatedResults),
    })),
    errorCount: 0,
  }
}

async function runExternalSearchTool(args: {
  queries: string[]
  searchConfig: SearchApiConfig
  source: "web" | "anytxt"
  llmConfig?: LlmConfig
  projectPath?: string
  webSearchImpl?: typeof webSearch
  anyTxtSearchSmartImpl?: typeof anyTxtSearchSmart
}): Promise<ToolObservation> {
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  const errors: string[] = []
  for (const query of args.queries.slice(0, 3)) {
    try {
      const batch = args.source === "web"
        ? await args.webSearchImpl?.(query, args.searchConfig, 5) ?? []
        : await args.anyTxtSearchSmartImpl?.(query, args.searchConfig.anyTxt, args.llmConfig, 5, args.projectPath) ?? []
      for (const result of batch) {
        const key = (result.url || `${result.source}:${result.title}:${result.snippet}`).toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        results.push(result)
        if (results.length >= 8) break
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
    if (results.length >= 8) break
  }

  return {
    tool: "external_search",
    query: args.queries.join(" | "),
    content: [
      formatExternalSearchContext(results),
      errors.length > 0 ? `Errors:\n${errors.map((err) => `- ${err}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
    references: results.map((result) => ({
      title: result.title,
      path: result.url,
      kind: "external" as const,
      source: result.source,
      url: result.url,
      snippet: result.snippet,
    })),
    pages: [],
    items: results.map((result, index) => externalResultToRetrievedItem(result, args.queries.join(" | "), index)),
    errorCount: errors.length,
  }
}

async function buildHistoricalObservations(args: {
  projectPath: string
  references: MessageReference[]
  llmConfig: LlmConfig
}): Promise<ToolObservation[]> {
  const refs = dedupeReferences(args.references).slice(0, 10)
  if (refs.length === 0) return []

  const wikiRefs = refs.filter((ref) => ref.kind !== "external" && ref.path)
  const externalRefs = refs.filter((ref) => ref.kind === "external")
  const observations: ToolObservation[] = []

  if (wikiRefs.length > 0 && args.projectPath) {
    const results: SearchResult[] = wikiRefs.slice(0, 5).map((ref, index) => ({
      path: normalizeReferencePath(args.projectPath, ref.path),
      title: ref.title,
      snippet: ref.snippet ?? "Previously cited local wiki page.",
      titleMatch: false,
      score: 1 / (index + 1),
      images: [],
    }))
    const pages = await materializePages(
      args.projectPath,
      results,
      Math.min(computeContextBudget(args.llmConfig.maxContextSize).pageBudget, 18_000),
      5000,
    )
    if (pages.length > 0) {
      observations.push({
        tool: "wiki_search",
        query: "recent local references",
        content: formatWikiObservation("Recent local retrieval history", pages, results),
        references: pages.map((page) => ({
          title: page.title,
          path: `${args.projectPath}/${page.path}`,
          kind: "wiki" as const,
        })),
        pages: pages.map((page) => ({ title: page.title, path: `${args.projectPath}/${page.path}` })),
        items: pages.map((page) => pageToRetrievedItem({
          projectPath: args.projectPath,
          page,
          query: "recent local references",
          kind: "history",
          source: "history",
          score: 0.75,
        })),
        errorCount: 0,
      })
    }
  }

  if (externalRefs.length > 0) {
    const results: WebSearchResult[] = externalRefs.slice(0, 8).map((ref) => ({
      title: ref.title,
      url: ref.url ?? ref.path,
      snippet: ref.snippet ?? "",
      source: ref.source ?? "external",
    }))
    observations.push({
      tool: "external_search",
      query: "recent external references",
      content: [
        "# Recent external retrieval history",
        formatExternalSearchContext(results),
      ].filter(Boolean).join("\n\n"),
      references: externalRefs,
      pages: [],
      items: results.map((result, index) => externalResultToRetrievedItem(result, "recent external references", index, "history")),
      errorCount: 0,
    })
  }

  return observations
}

function normalizeReferencePath(projectPath: string, path: string): string {
  const normalized = normalizePath(path)
  if (normalized.startsWith(`${projectPath}/`)) return normalized
  return `${projectPath}/${normalized.replace(/^\/+/, "")}`
}

async function materializePages(
  projectPath: string,
  results: SearchResult[],
  pageBudget: number,
  maxPageSize: number,
): Promise<PageEntry[]> {
  let usedChars = 0
  const pages: PageEntry[] = []
  for (const [index, result] of results.entries()) {
    if (usedChars >= pageBudget) break
    try {
      const raw = await readFile(result.path)
      const relativePath = getRelativePath(result.path, projectPath)
      const truncated = raw.length > maxPageSize
        ? raw.slice(0, maxPageSize) + "\n\n[...truncated...]"
        : raw
      if (usedChars + truncated.length > pageBudget) continue
      usedChars += truncated.length
      pages.push({
        title: result.title,
        path: relativePath,
        content: truncated,
        priority: index,
      })
    } catch {
      // Skip unreadable pages; search snippets remain in the observation.
    }
  }
  return pages
}

function buildFinalMessages(args: {
  project: ChatAgentProject | null
  text: string
  historyMessages: LLMMessage[]
  observations: ToolObservation[]
  retrievedContext: RetrievedContext
  directAnswerHint?: string
  projectContext?: ProjectPromptContext
}): LLMMessage[] {
  const hasTools = args.retrievedContext.itemCount > 0
  const hasExternalObservations = args.observations.some((obs) => obs.tool === "external_search")
  const localRefs = args.retrievedContext.references
    .filter((ref) => ref.kind !== "external")
  const pageList = localRefs.map((ref, index) => `[${index + 1}] ${ref.title} (${ref.path})`).join("\n")

  const system = hasTools
    ? [
        "You are a knowledgeable wiki assistant. Answer using the retrieved context below and conversation history.",
        "If the observations are insufficient, say what is missing instead of inventing facts.",
        "Keep subject boundaries strict: do not apply a claim, limitation, evaluation, benchmark result, or recommendation about one entity/model/product/method to another subject just because they share keywords.",
        "If retrieved context discusses multiple subjects, attribute each claim to the exact subject named in that context block; when uncertain, state the uncertainty instead of generalizing.",
        "Use [[wikilink]] syntax for local wiki pages when relevant.",
        "When a sentence or bullet uses retrieved context, include an inline citation immediately after that claim.",
        "Cite local context blocks with [1], [2]. Cite external context blocks with [E1], [E2].",
        "Do not rely on the separate References panel as a substitute for inline citations in the answer body.",
        hasExternalObservations
          ? [
              "External search is enabled for this conversation, and you can use external search results when they are relevant.",
              "For this answer, external search context blocks are available below; decide whether they are relevant to the user's request and use them when they help.",
              "If your answer uses any external search fact, include its [E#] citation in the same sentence or bullet.",
              "Do not apologize for lacking web access, do not say you cannot browse, and do not say you can only access the local wiki when external context blocks are present.",
              "If earlier conversation messages claimed external search was unavailable, ignore that stale claim for this turn and reason from the current available context.",
            ].join(" ")
          : "",
        "At the VERY END of your response, add a hidden comment listing which local page numbers you used:",
        "  <!-- cited: 1, 3 -->",
        "",
        args.project ? `Project: ${args.project.name}` : "",
        args.projectContext?.purpose ? `## Wiki Purpose\n${args.projectContext.purpose}` : "",
        args.projectContext?.overview ? `## Wiki Overview\n${args.projectContext.overview}` : "",
        args.projectContext?.index ? `## Wiki Index\n${args.projectContext.index}` : "",
        pageList ? `## Page List\n${pageList}` : "",
        "",
        args.retrievedContext.contextText,
        "",
        buildLanguageDirective(args.text),
      ].filter(Boolean).join("\n")
    : [
        args.project
          ? `You are a wiki assistant for the project "${args.project.name}".`
          : "You are a helpful assistant.",
        "Answer directly from the conversation. Do not claim that you searched the wiki or external sources.",
        args.directAnswerHint ? `Possible answer direction: ${args.directAnswerHint}` : "",
        buildLanguageReminder(args.text),
      ].filter(Boolean).join("\n")

  return addLanguageReminderToLastUser([
    { role: "system", content: system },
    ...args.historyMessages,
  ], args.text)
}

function buildRetrievedContext(observations: ToolObservation[], query: string, llmConfig: LlmConfig): RetrievedContext {
  const items = fuseRetrievedItems(observations.flatMap((obs) => obs.items), query)
  const { pageBudget } = computeContextBudget(llmConfig.maxContextSize)
  const budget = Math.max(8_000, Math.min(pageBudget, MAX_TOOL_CONTEXT_CHARS))
  const blocks: string[] = []
  const references: MessageReference[] = []
  const pages: { title: string; path: string }[] = []
  let used = 0
  let localIndex = 0
  let externalIndex = 0

  for (const item of items) {
    const isExternal = item.reference.kind === "external"
    const refId = isExternal ? `E${++externalIndex}` : `${++localIndex}`
    const maxItemChars = isExternal ? 1800 : 6500
    const content = trimForBudget(item.content || item.snippet, Math.min(maxItemChars, Math.max(800, budget - used)))
    if (!content.trim()) continue
    const block = [
      `<context id="${refId}" source="${escapeContextAttr(item.source)}" kind="${item.kind}" title="${escapeContextAttr(item.title)}" path="${escapeContextAttr(item.url ?? item.path)}">`,
      content,
      "</context>",
    ].join("\n")
    if (used + block.length > budget && blocks.length > 0) break
    used += block.length
    blocks.push(block)
    references.push(item.reference)
    if (item.page) pages.push(item.page)
    if (used >= budget) break
  }

  return {
    contextText: blocks.length > 0
      ? `## Retrieved Context\n${blocks.join("\n\n---\n\n")}`
      : buildEmptyRetrievalStatus(observations),
    references: dedupeReferences(references),
    pages,
    itemCount: blocks.length || observations.length,
  }
}

function buildEmptyRetrievalStatus(observations: ToolObservation[]): string {
  if (observations.length === 0) return ""
  return [
    "## Retrieved Context",
    observations.map((obs, index) => [
      `<context id="status-${index + 1}" source="${obs.tool}" kind="status" title="Retrieval status" path="">`,
      `Query: ${obs.query}`,
      obs.content || "(no results)",
      "</context>",
    ].join("\n")).join("\n\n---\n\n"),
  ].join("\n")
}

function fuseRetrievedItems(items: RetrievedItem[], query: string): RetrievedItem[] {
  const tokens = tokenizeIndexQuery(query)
  const merged = new Map<string, RetrievedItem>()
  for (const item of items) {
    const key = retrievedItemKey(item)
    const ranked = {
      ...item,
      score: rankRetrievedItem(item, tokens),
    }
    const existing = merged.get(key)
    if (!existing || ranked.score > existing.score || ranked.content.length > existing.content.length) {
      merged.set(key, ranked)
    }
  }
  return [...merged.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.title.localeCompare(b.title)
  })
}

function rankRetrievedItem(item: RetrievedItem, tokens: string[]): number {
  const sourceWeight = item.kind === "wiki"
    ? 1
    : item.kind === "graph"
      ? 0.88
      : item.kind === "external"
        ? 0.92
        : 0.78
  const text = `${item.title}\n${item.snippet}\n${item.path}`.toLowerCase()
  const overlap = tokens.reduce((score, token) => score + (text.includes(token) ? 0.12 : 0), 0)
  const boundedSourceScore = Math.max(0, Math.min(1, item.score))
  return sourceWeight + boundedSourceScore + overlap
}

function retrievedItemKey(item: RetrievedItem): string {
  const locator = item.url || item.path || item.id
  return `${item.reference.kind ?? "wiki"}:${locator}`.toLowerCase()
}

function pageToRetrievedItem(args: {
  projectPath: string
  page: PageEntry
  query: string
  kind: Extract<RetrievedItemKind, "wiki" | "graph" | "history">
  source: string
  score: number
}): RetrievedItem {
  const absolutePath = `${args.projectPath}/${args.page.path}`
  return {
    id: absolutePath,
    kind: args.kind,
    source: args.source,
    title: args.page.title,
    path: absolutePath,
    snippet: args.page.content.slice(0, 400),
    content: args.page.content,
    score: args.score,
    query: args.query,
    reference: { title: args.page.title, path: absolutePath, kind: "wiki" },
    page: { title: args.page.title, path: absolutePath },
  }
}

function externalResultToRetrievedItem(
  result: WebSearchResult,
  query: string,
  index: number,
  kind: Extract<RetrievedItemKind, "external" | "history"> = "external",
): RetrievedItem {
  return {
    id: result.url || `${result.source}:${result.title}:${index}`,
    kind,
    source: result.source,
    title: result.title,
    path: result.url,
    url: result.url,
    snippet: result.snippet,
    content: result.snippet,
    score: 1 / (index + 1),
    query,
    reference: {
      title: result.title,
      path: result.url,
      kind: "external",
      source: result.source,
      url: result.url,
      snippet: result.snippet,
    },
  }
}

function searchScoreForPage(page: PageEntry, results: SearchResult[]): number {
  const normalized = normalizePath(page.path)
  const found = results.find((result) => normalizePath(result.path).endsWith(normalized))
  return found?.score ?? 1 / (page.priority + 1)
}

function trimForBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return `${content.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[...truncated...]`
}

function escapeContextAttr(value: string): string {
  return value.replace(/[<>"&]/g, (char) => {
    switch (char) {
      case "<": return "&lt;"
      case ">": return "&gt;"
      case "\"": return "&quot;"
      case "&": return "&amp;"
      default: return char
    }
  })
}

async function readProjectPromptContext(
  projectPath: string,
  query: string,
  llmConfig: LlmConfig,
): Promise<ProjectPromptContext> {
  const { indexBudget } = computeContextBudget(llmConfig.maxContextSize)
  const [rawIndex, purpose, overview] = await Promise.all([
    readFile(`${projectPath}/wiki/index.md`).catch(() => ""),
    readFile(`${projectPath}/purpose.md`).catch(() => ""),
    readFile(`${projectPath}/wiki/overview.md`).catch(() => ""),
  ])
  if (rawIndex.length <= indexBudget) return { purpose, index: rawIndex, overview }

  const tokens = tokenizeIndexQuery(query)
  const lines = rawIndex.split("\n")
  const keptLines: string[] = []
  let keptSize = 0
  for (const line of lines) {
    const isHeader = line.startsWith("##")
    const lower = line.toLowerCase()
    const isRelevant = tokens.some((token) => lower.includes(token))
    if (!isHeader && !isRelevant) continue
    if (keptSize + line.length + 1 > indexBudget) continue
    keptLines.push(line)
    keptSize += line.length + 1
  }
  const index = keptLines.length > 0
    ? `${keptLines.join("\n")}\n\n[...index trimmed to relevant entries...]`
    : ""
  return { purpose, index, overview }
}

function tokenizeIndexQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
    .slice(0, 20)
}

function addLanguageReminderToLastUser(messages: LLMMessage[], text: string): LLMMessage[] {
  const reminder = buildLanguageReminder(text)
  if (!reminder) return messages
  const lastIdx = [...messages].reverse().findIndex((msg) => msg.role === "user")
  if (lastIdx < 0) return messages
  const idx = messages.length - 1 - lastIdx
  const target = messages[idx]
  if (!target || target.role !== "user") return messages
  const prefix = `[${reminder}]\n\n`
  const content = typeof target.content === "string"
    ? `${prefix}${target.content}`
    : addTextPrefix(target.content, prefix)
  return [
    ...messages.slice(0, idx),
    { ...target, content },
    ...messages.slice(idx + 1),
  ]
}

function addTextPrefix(content: Exclude<LLMMessage["content"], string>, prefix: string): LLMMessage["content"] {
  const blocks = [...content]
  const firstTextIdx = blocks.findIndex((block) => block.type === "text")
  if (firstTextIdx >= 0) {
    const block = blocks[firstTextIdx]
    if (block.type === "text") blocks[firstTextIdx] = { type: "text", text: `${prefix}${block.text}` }
    return blocks
  }
  return [{ type: "text", text: prefix }, ...blocks]
}

function formatWikiObservation(title: string, pages: PageEntry[], snippets: SearchResult[]): string {
  const pageText = pages.length > 0
    ? pages.map((page, index) => [
        `### [${index + 1}] ${page.title}`,
        `Path: ${page.path}`,
        "",
        page.content,
      ].join("\n")).join("\n\n---\n\n")
    : ""

  const snippetText = snippets.length > 0
    ? snippets.slice(0, 8).map((result, index) => [
        `- ${index + 1}. ${result.title}`,
        `  Path: ${result.path}`,
        `  Snippet: ${result.snippet}`,
      ].join("\n")).join("\n")
    : ""

  return [
    `# ${title}`,
    pageText,
    snippetText ? `## Search snippets\n${snippetText}` : "",
  ].filter(Boolean).join("\n\n")
}

function formatExternalSearchContext(results: WebSearchResult[]): string {
  if (results.length === 0) return ""
  return results.map((result, index) => [
    `### [E${index + 1}] ${result.title}`,
    `Source: ${result.source}`,
    `URL: ${result.url}`,
    "",
    result.snippet,
  ].join("\n")).join("\n\n---\n\n")
}

function dedupeReferences(refs: MessageReference[]): MessageReference[] {
  const seen = new Set<string>()
  const out: MessageReference[] = []
  for (const ref of refs) {
    const key = `${ref.kind ?? "wiki"}:${ref.url ?? ref.path}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

async function collectChatText(
  llmConfig: LlmConfig,
  messages: LLMMessage[],
  streamChatImpl: typeof streamChat,
  signal?: AbortSignal,
  overrides?: Parameters<typeof streamChat>[4],
): Promise<string> {
  let out = ""
  let error: Error | null = null
  const requestOverrides: Parameters<typeof streamChat>[4] = {
    ...overrides,
    reasoning: overrides?.reasoning ?? { mode: "off" },
  }
  await streamChatImpl(
    llmConfig,
    messages,
    {
      onToken: (token) => { out += token },
      onReasoningToken: () => {},
      onDone: () => {},
      onError: (err) => { error = err },
    },
    signal,
    requestOverrides,
  )
  if (error) throw error
  throwIfAborted(signal)
  return out
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error("Chat request aborted")
  err.name = "AbortError"
  throw err
}
