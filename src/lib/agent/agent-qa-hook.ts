/**
 * QA Hook Agent (Phase 3.65-E — Issue #34)
 *
 * Automatically extracts key insights from agent conversations and saves
 * them as QA pages in the wiki. Triggered fire-and-forget from the
 * onDone callback after a conversation ends.
 *
 * Data flow:
 *   conversation ends → onDone → runQaHook()
 *     1. Read messages from useChatStore
 *     2. shouldExtractQa() — skip greetings / too short
 *     3. Scan wiki/qa/ for dedup
 *     4. webSearch for external context (optional)
 *     5. LLM extracts structured QA
 *     6. Validate frontmatter → writeFile
 */

import { readFile, listDirectory, writeFile, createDirectory } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { streamChat } from "@/lib/llm-client"
import { webSearch, type WebSearchResult } from "@/lib/web-search"
import { buildLanguageDirective } from "@/lib/output-language"
import { flattenMdFiles } from "@/lib/wiki-utils"
import { normalizePath } from "@/lib/path-utils"
import type { DisplayMessage } from "@/stores/chat-store"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

// ── Types ────────────────────────────────────────────────────────────────────

export interface QaHookResult {
  ok: boolean
  saved?: boolean
  qaPath?: string
  skipped?: boolean
  skipReason?: string
  error?: string
}

// ── Skip Logic ───────────────────────────────────────────────────────────────

const GREETING_RE = /^(hi|hello|hey|你好|您好|嗨|哈喽|yo|sup)\s*[!?.。！？]*$/i

/** Decide whether a conversation is worth extracting a QA from. */
export function shouldExtractQa(messages: DisplayMessage[]): { extract: boolean; reason?: string } {
  const userMsgs = messages.filter((m) => m.role === "user")
  const assistantMsgs = messages.filter((m) => m.role === "assistant")

  // Need at least one meaningful exchange
  if (userMsgs.length === 0 || assistantMsgs.length === 0) {
    return { extract: false, reason: "no-exchange" }
  }

  // Skip if all user messages are greetings
  const allGreetings = userMsgs.every((m) => GREETING_RE.test(m.content.trim()))
  if (allGreetings) {
    return { extract: false, reason: "greeting-only" }
  }

  // Skip if the last assistant message is too short
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1]
  if (lastAssistant.content.trim().length < 100) {
    return { extract: false, reason: "response-too-short" }
  }

  return { extract: true }
}

// ── Dedup ────────────────────────────────────────────────────────────────────

interface ExistingQa {
  title: string
  body: string
}

/** Scan wiki/qa/ directory for existing QA pages. */
async function scanExistingQa(projectPath: string): Promise<ExistingQa[]> {
  const pp = normalizePath(projectPath)
  const qaDir = `${pp}/wiki/qa`

  let tree: FileNode[]
  try {
    tree = await listDirectory(qaDir)
  } catch {
    return []
  }

  const files = flattenMdFiles(tree)
  const pages: ExistingQa[] = []

  for (const f of files) {
    try {
      const content = await readFile(f.path)
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter) continue
      const type = String(frontmatter.type || "").toLowerCase()
      if (type !== "qa") continue
      pages.push({ title: String(frontmatter.title || ""), body })
    } catch {
      // skip unreadable
    }
  }

  return pages
}

/** Check if a similar QA already exists (title match or body overlap). */
function isDuplicateQa(title: string, existing: ExistingQa[]): boolean {
  const normalizedTitle = title.toLowerCase().trim()
  for (const qa of existing) {
    const existingTitle = qa.title.toLowerCase().trim()
    // Exact title match
    if (normalizedTitle === existingTitle) return true
    // Fuzzy: if one title contains the other (and both > 10 chars)
    if (
      normalizedTitle.length > 10 &&
      existingTitle.length > 10 &&
      (normalizedTitle.includes(existingTitle) || existingTitle.includes(normalizedTitle))
    ) {
      return true
    }
  }
  return false
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildQaExtractionPrompt(
  messages: DisplayMessage[],
  wikiContext: string,
  externalResults: WebSearchResult[],
  languageHint: string,
): string {
  const conversation = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n")

  const externalSection = externalResults.length > 0
    ? `\n\n## External Research Sources\n\n${externalResults
        .slice(0, 3)
        .map((r) => `- **${r.title}**: ${r.snippet} (${r.url})`)
        .join("\n")}`
    : ""

  return `You are a knowledge extraction expert. Analyze the following conversation and extract the key question and its answer into a structured QA document.

${languageHint}

## Conversation

${conversation}
${externalSection}
${wikiContext ? `\n## Existing Wiki Context\n\n${wikiContext}\n` : ""}

## Your Task

Extract the most important question and answer from this conversation. Produce a QA wiki page with this format:

\`\`\`
---
type: qa
title: "the core question in one sentence"
tags: [qa, <relevant-tag-1>, <relevant-tag-2>]
created: ${new Date().toISOString().slice(0, 10)}
---

# Q: [the core question]

## A: [comprehensive answer synthesized from the conversation]

## Key Insights
- [insight 1]
- [insight 2]

## Source References
- [any wiki pages or external sources mentioned]
\`\`\`

Rules:
- Title must be a clear, specific question (not a generic topic)
- Answer should be self-contained — readable without the original conversation
- Include 2-5 key insights that capture the most valuable knowledge
- If the conversation is too shallow or operational (e.g., "fix this bug"), output ONLY: SKIP
- Tags should reflect the knowledge domain, not "qa" alone
- Output ONLY the wiki page content or "SKIP", nothing else.`
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the QA extraction hook on a finished conversation.
 * Designed to be called fire-and-forget from onDone.
 */
export async function runQaHook(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
  messages: DisplayMessage[],
): Promise<QaHookResult> {
  // Step 1: Check skip conditions
  const { extract, reason } = shouldExtractQa(messages)
  if (!extract) {
    return { ok: true, skipped: true, skipReason: reason }
  }

  const pp = normalizePath(projectPath)

  // Step 2: Scan existing QA for dedup
  const existingQa = await scanExistingQa(pp)

  // Step 3: External search (supplementary, non-blocking)
  let externalResults: WebSearchResult[] = []
  try {
    // Build search query from the last user message
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
    if (lastUserMsg) {
      const query = lastUserMsg.content.slice(0, 200)
      externalResults = await webSearch(query, searchConfig, 3)
    }
  } catch {
    // External search is optional
  }

  // Step 4: Build wiki context hint
  let wikiContext = ""
  try {
    wikiContext = await readFile(`${pp}/wiki/index.md`)
  } catch {
    // optional
  }

  // Step 5: Generate QA via LLM
  const languageHint = buildLanguageDirective(messages.map((m) => m.content).join("\n"))
  const prompt = buildQaExtractionPrompt(messages, wikiContext, externalResults, languageHint)

  let accumulated = ""
  let streamError: unknown
  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { accumulated += token },
      onDone: () => {},
      onError: (err) => { streamError = err },
    },
  )
  if (streamError) throw streamError

  const trimmed = accumulated.trim()
  if (!trimmed || trimmed === "SKIP") {
    return { ok: true, skipped: true, skipReason: "llm-skipped" }
  }

  // Step 6: Validate frontmatter
  const { frontmatter } = parseFrontmatter(trimmed)
  if (!frontmatter || String(frontmatter.type || "").toLowerCase() !== "qa") {
    return { ok: false, error: "LLM output missing valid qa frontmatter" }
  }

  const qaTitle = String(frontmatter.title || "")

  // Step 7: Dedup check
  if (isDuplicateQa(qaTitle, existingQa)) {
    return { ok: true, skipped: true, skipReason: "duplicate" }
  }

  // Step 8: Save QA page
  const tagSlug = qaTitle
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "untagged"

  const qaPath = `wiki/qa/${tagSlug}.md`
  const fullPath = `${pp}/${qaPath}`

  await createDirectory(`${pp}/wiki/qa`)
  await writeFile(fullPath, trimmed)

  return {
    ok: true,
    saved: true,
    qaPath,
  }
}
