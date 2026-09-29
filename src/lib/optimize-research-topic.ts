import { streamChat } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { buildLanguageDirective } from "./output-language"
import {
  groundBareResearchQueries,
  groundedFallbackResearchQuery,
  PROJECT_LOCAL_TERM_QUERY_RULES,
} from "./research-query-grounding"

export interface OptimizedTopic {
  topic: string
  searchQueries: string[]
}

/**
 * Use LLM to generate a context-aware research topic and search queries
 * based on the knowledge gap and the wiki's purpose/overview.
 */
export async function optimizeResearchTopic(
  llmConfig: LlmConfig,
  gapTitle: string,
  gapDescription: string,
  gapType: string,
  overview: string,
  purpose: string,
): Promise<OptimizedTopic> {
  const prompt = [
    "You are a research assistant. Given a knowledge gap found in a personal wiki, generate a precise research topic and search queries.",
    "",
    buildLanguageDirective(`${gapTitle} ${gapDescription} ${purpose} ${overview}`),
    "",
    "## Wiki Context",
    purpose ? `### Purpose\n${purpose}` : "",
    overview ? `### Current Overview\n${overview}` : "",
    "",
    "## Knowledge Gap",
    `Type: ${gapType}`,
    `Title: ${gapTitle}`,
    `Description: ${gapDescription}`,
    "",
    "## Task",
    "Generate a research topic and search queries that are specific to this wiki's domain and purpose.",
    ...PROJECT_LOCAL_TERM_QUERY_RULES,
    "Use the local description as the authoritative meaning of the term.",
    "The topic should precisely describe what information would fill this knowledge gap.",
    "The search queries should be concise and specific while retaining the exact original-language project term.",
    "",
    "## Output Format (STRICT — follow exactly, no other text)",
    "Respond with EXACTLY 4 lines, no more:",
    "TOPIC: <one sentence — MUST be in the mandatory output language declared above>",
    "QUERY: <query 1 — may use English keywords if they better match search engines>",
    "QUERY: <query 2>",
    "QUERY: <query 3>",
  ].filter(Boolean).join("\n")

  let result = ""

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { result += token },
      onDone: () => {},
      onError: () => {},
    },
  )

  // Parse response
  const topicMatch = result.match(/^TOPIC:\s*(.+)$/m)
  const queryMatches = [...result.matchAll(/^QUERY:\s*(.+)$/gm)]

  const topic = topicMatch?.[1]?.trim() || gapTitle
  // Deterministic fallbacks go directly to a third-party search provider.
  // Keep them to the explicit gap description; purpose/overview remain prompt
  // context for the configured LLM but are not copied verbatim into web queries.
  const queryContext = gapDescription
  const parsedQueries = queryMatches
    .slice(0, 3)
    .map((m) => m[1].trim())
    .filter((q) => q.length > 0)
  const searchQueries = groundBareResearchQueries(
    parsedQueries.length > 0 ? parsedQueries : [topic],
    gapTitle,
    queryContext,
    [topic],
  )

  return {
    topic,
    searchQueries: searchQueries.length > 0
      ? searchQueries
      : [groundedFallbackResearchQuery(gapTitle, queryContext)],
  }
}
