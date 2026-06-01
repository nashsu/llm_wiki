/**
 * QA Hook Agent (Phase 3.65-E — Issue #34, refined by #37)
 *
 * Automatically extracts key insights from agent conversations and saves
 * them as QA pages in the wiki.
 *
 * Trigger mechanism (Issue #37 — dirty flag + delayed flush):
 *   1. onDone → markConversationDirty(convId) — just marks, no LLM call
 *   2. activeConversationId changes → flush old conversation QA
 *   3. beforeunload → persist pending set to localStorage
 *   4. App startup → loadPendingQa() + flush stale entries
 *
 * Data flow per conversation:
 *   mark dirty → flush → shouldExtractQa → dedup → LLM → validate → writeFile
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

// ── Pending Queue (dirty flag) ───────────────────────────────────────────────

const pendingQa = new Set<string>()
const STORAGE_KEY = "llm-wiki:pendingQa"

/** Mark a conversation as needing QA extraction (called on each onDone). */
export function markConversationDirty(convId: string): void {
  pendingQa.add(convId)
  persistPendingQa()
}

/** Remove a conversation from the pending queue (e.g. when deleted). */
export function unmarkConversation(convId: string): void {
  pendingQa.delete(convId)
  persistPendingQa()
}

/** Check if a conversation has pending QA. */
export function isConversationPending(convId: string): boolean {
  return pendingQa.has(convId)
}

/** Get all pending conversation IDs (for testing). */
export function getPendingQaIds(): string[] {
  return [...pendingQa]
}

/** Persist pending set to localStorage. */
function persistPendingQa(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...pendingQa]))
  } catch {
    // localStorage unavailable (SSR, private browsing edge case)
  }
}

/**
 * Load pending QA set from localStorage on app startup.
 * Returns the loaded conversation IDs for the caller to decide what to do.
 */
export function loadPendingQa(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const ids = JSON.parse(raw) as string[]
    for (const id of ids) {
      pendingQa.add(id)
    }
    return ids
  } catch {
    return []
  }
}

/** Clear localStorage after all pending QAs are flushed. */
function clearPersistedPendingQa(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

// ── Flush (actual QA extraction) ─────────────────────────────────────────────

/**
 * Flush a single conversation: run QA extraction and remove from pending.
 * Designed to be called fire-and-forget.
 */
export async function flushQaForConversation(
  convId: string,
  messages: DisplayMessage[],
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
): Promise<QaHookResult> {
  // Only process if actually pending
  if (!pendingQa.has(convId)) {
    return { ok: true, skipped: true, skipReason: "not-pending" }
  }

  // Get messages for this specific conversation
  const convMessages = messages.filter((m) => m.conversationId === convId)
  if (convMessages.length === 0) {
    pendingQa.delete(convId)
    persistPendingQa()
    return { ok: true, skipped: true, skipReason: "no-messages" }
  }

  try {
    const result = await runQaExtraction(projectPath, llmConfig, searchConfig, convMessages)
    return result
  } finally {
    pendingQa.delete(convId)
    persistPendingQa()
    if (pendingQa.size === 0) {
      clearPersistedPendingQa()
    }
  }
}

/**
 * Flush all pending conversations. Called on app startup for stale entries.
 * Returns results for each flushed conversation.
 */
export async function flushAllPendingQa(
  messages: DisplayMessage[],
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
): Promise<QaHookResult[]> {
  const results: QaHookResult[] = []
  const ids = [...pendingQa]
  for (const convId of ids) {
    try {
      const r = await flushQaForConversation(convId, messages, projectPath, llmConfig, searchConfig)
      results.push(r)
    } catch (err) {
      // Capture per-conversation errors so one failure doesn't block others
      results.push({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
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

// ── Core Extraction ──────────────────────────────────────────────────────────

/**
 * Run the QA extraction on a set of messages.
 * This is the internal implementation — callers should use flushQaForConversation.
 */
async function runQaExtraction(
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

  // Step 2b: Quick title pre-check — skip LLM if last user question already exists
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")
  if (lastUserMsg && isDuplicateQa(lastUserMsg.content.trim().slice(0, 120), existingQa)) {
    return { ok: true, skipped: true, skipReason: "duplicate" }
  }

  // Step 3: External search (supplementary, non-blocking)
  let externalResults: WebSearchResult[] = []
  try {
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
  // Limit to last 20 messages to keep prompt size manageable
  const trimmedMessages = messages.slice(-20)
  const languageHint = buildLanguageDirective(trimmedMessages.map((m) => m.content).join("\n"))
  const prompt = buildQaExtractionPrompt(trimmedMessages, wikiContext, externalResults, languageHint)

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
