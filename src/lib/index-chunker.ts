/**
 * Chunk an index.md string into fixed-size chunks by entry count.
 * Each chunk preserves the ## Category headers for context.
 * Entries are numbered sequentially with [N] prefix across all chunks.
 */

import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

interface IndexEntry {
  category: string
  text: string
}

/** Parse index.md into structured entries with their category context. */
function parseIndexEntries(index: string): {
  entries: IndexEntry[]
} {
  const lines = index.split("\n")
  const entries: IndexEntry[] = []
  let currentCategory = ""

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)/)
    if (headerMatch) {
      currentCategory = headerMatch[1].trim()
      continue
    }
    // Entry lines start with - [[ or * [[
    if (/^[-*]\s+\[\[/.test(line)) {
      entries.push({
        category: currentCategory,
        text: line,
      })
    }
  }

  return { entries }
}

export function chunkIndexByEntries(index: string, chunkSize: number): string[] {
  if (!index.trim()) return []

  const { entries } = parseIndexEntries(index)
  if (entries.length === 0) return []

  const chunks: string[] = []
  let entryIdx = 0
  let globalNum = 1

  while (entryIdx < entries.length) {
    const chunkLines: string[] = []
    let currentCat = ""
    const end = Math.min(entryIdx + chunkSize, entries.length)

    for (let i = entryIdx; i < end; i++) {
      const entry = entries[i]
      if (entry.category !== currentCat) {
        currentCat = entry.category
        chunkLines.push(`## ${currentCat}`)
      }
      chunkLines.push(`[${globalNum}] ${entry.text.replace(/^[-*]\s+/, "")}`)
      globalNum++
    }

    chunks.push(chunkLines.join("\n"))
    entryIdx = end
  }

  return chunks
}

/**
 * Parse the pre-match LLM output into an array of matching entry numbers.
 * Tolerant: handles [3, 12, 47], 3, 12, 47, none, 无, surrounding text.
 * Returns deduplicated numbers, or empty array if no valid numbers found.
 */
export function parsePrematchOutput(output: string): number[] {
  const trimmed = output.trim()
  if (!trimmed) return []

  const lower = trimmed.toLowerCase()
  if (lower === "none" || trimmed === "无") return []

  // Try to extract bracketed numbers first: [3, 12, 47]
  const bracketMatch = trimmed.match(/\[([\d,\s]+)\]/)
  const source = bracketMatch ? bracketMatch[1] : trimmed

  // Extract all integer tokens
  const tokens = source.match(/\d+/g)
  if (!tokens) return []

  const numbers = tokens
    .map((t) => parseInt(t, 10))
    .filter((n) => Number.isFinite(n) && n > 0)

  return [...new Set(numbers)]
}

/**
 * Assemble a reduced index from the original index.md and matched entry numbers.
 * Entry numbers are 1-based as assigned by chunkIndexByEntries.
 * Preserves original index order and deduplicates category headers.
 */
export function assembleReducedIndex(index: string, matchedNumbers: number[]): string {
  if (matchedNumbers.length === 0) return ""

  const { entries } = parseIndexEntries(index)
  const matchSet = new Set(matchedNumbers)
  const lines: string[] = []
  let currentCat = ""

  for (let i = 0; i < entries.length; i++) {
    const entryNum = i + 1
    if (!matchSet.has(entryNum)) continue

    if (entries[i].category !== currentCat) {
      currentCat = entries[i].category
      lines.push(`## ${currentCat}`)
    }
    lines.push(entries[i].text)
  }

  return lines.join("\n")
}

/**
 * Build the system prompt for a pre-match LLM call.
 * The LLM reads the source document and a chunk of index entries,
 * then outputs matching entry numbers.
 */
export function buildPrematchPrompt(sourceContent: string, chunk: string): string {
  return [
    "You are a relevance matcher. Read the source document and determine",
    "which wiki index entries are related to it.",
    "",
    "## Source Document",
    sourceContent,
    "",
    "## Index Chunk",
    "Below is a chunk of the wiki index. Each numbered item is a page entry.",
    "For each item, determine whether it covers the same subject as any",
    "entity or concept in the source document. A match means the page",
    "is about the same entity, concept, method, or topic.",
    "",
    chunk,
    "",
    "## Output Format (STRICT)",
    "",
    "Output ONLY matching item numbers in bracket format: [3, 12, 47]",
    "If no items match, output exactly: none",
    "",
    "Do not output explanations, reasoning, or any other text.",
  ].join("\n")
}

export interface ParsedIndexBlock {
  category: string
  entries: string[]
}

const INDEX_BLOCK_REGEX = /---INDEX:\s*(.+?)\s*---\n([\s\S]*?)---END INDEX---/g

/**
 * Parse ---INDEX: Category--- blocks from LLM generation output.
 * Pattern follows existing parseFileBlocks / parseReviewBlocks conventions.
 */
export function parseIndexBlocks(text: string): ParsedIndexBlock[] {
  const normalized = text.replace(/\r\n/g, "\n")
  const blocks: ParsedIndexBlock[] = []

  for (const match of normalized.matchAll(INDEX_BLOCK_REGEX)) {
    const category = match[1].trim()
    const body = match[2].trim()
    const entries = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    blocks.push({ category, entries })
  }

  return blocks
}

/**
 * Convert a raw entry line from an INDEX block into index.md format.
 * Input: "rope — Rotary Position Embedding" or "rope"
 * Output: "- [[rope]] — Rotary Position Embedding" or "- [[rope]]"
 */
function formatIndexEntry(rawEntry: string): string {
  const trimmed = rawEntry.trim()
  // Already has [[...]] format? Keep as-is (just ensure leading - [[)
  if (/^\[\[/.test(trimmed)) {
    return `- ${trimmed}`
  }
  // Split on em-dash or hyphen to separate slug from description
  const dashMatch = trimmed.match(/^(.+?)\s+[—–-]\s+(.+)$/)
  if (dashMatch) {
    const slug = dashMatch[1].trim()
    const desc = dashMatch[2].trim()
    return `- [[${slug}]] — ${desc}`
  }
  // No description — just the slug
  return `- [[${trimmed}]]`
}

/**
 * Programmatically append parsed INDEX block entries to existing index.md content.
 * - Appends to existing category sections
 * - Creates new category sections at the end if needed
 */
export function appendIndexEntries(indexContent: string, blocks: ParsedIndexBlock[]): string {
  if (blocks.length === 0) return indexContent

  const lines = indexContent.split("\n")
  const result = [...lines]

  for (const block of blocks) {
    if (block.entries.length === 0) continue

    const categoryHeader = `## ${block.category}`
    const formattedEntries = block.entries.map(formatIndexEntry)

    // Find the category section
    let catStartIdx = -1
    for (let i = 0; i < result.length; i++) {
      if (result[i].trim() === categoryHeader) {
        catStartIdx = i
        break
      }
    }

    if (catStartIdx >= 0) {
      // Category exists — find the last entry line in this section
      let insertIdx = catStartIdx + 1
      for (let i = catStartIdx + 1; i < result.length; i++) {
        const line = result[i].trim()
        if (/^##\s/.test(line)) break // Hit next category
        if (/^[-*]\s+\[\[/.test(line) || /^\(none yet\)/.test(line)) {
          insertIdx = i + 1
        }
      }
      // Remove "(none yet)" placeholder if present
      const placeholderIdx = result.indexOf("(none yet)", catStartIdx)
      if (placeholderIdx >= 0 && placeholderIdx < insertIdx) {
        result.splice(placeholderIdx, 1)
        insertIdx--
      }
      // Insert entries
      result.splice(insertIdx, 0, ...formattedEntries)
    } else {
      // Category doesn't exist — append at end
      result.push("")
      result.push(categoryHeader)
      result.push(...formattedEntries)
    }
  }

  return result.join("\n")
}

const PREMATCH_CONCURRENCY = 8

/**
 * Run pre-match LLM calls in parallel across all index chunks.
 * Returns the union of all matched entry numbers.
 * Failed chunks are logged and skipped (treated as 0 matches).
 */
export async function runPrematchParallel(
  chunks: string[],
  sourceContent: string,
  llmConfig: LlmConfig,
  signal: AbortSignal | undefined,
): Promise<number[]> {
  if (chunks.length === 0) return []

  const results: number[][] = []

  // Process in batches of PREMATCH_CONCURRENCY
  for (let i = 0; i < chunks.length; i += PREMATCH_CONCURRENCY) {
    if (signal?.aborted) break
    const batch = chunks.slice(i, i + PREMATCH_CONCURRENCY)

    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        let output = ""
        let hadError = false

        try {
          await streamChat(
            llmConfig,
            [
              { role: "system", content: buildPrematchPrompt(sourceContent, chunk) },
              { role: "user", content: "Output matching item numbers for the chunk above." },
            ],
            {
              onToken: (token: string) => { output += token },
              onDone: () => {},
              onError: (err: Error) => {
                hadError = true
                console.warn(`[prematch] chunk failed: ${err.message}`)
              },
            },
            signal,
            { temperature: 0.1, reasoning: { mode: "high" } },
          )
        } catch (err) {
          hadError = true
          console.warn(`[prematch] chunk threw: ${err instanceof Error ? err.message : String(err)}`)
        }

        if (hadError) return []
        return parsePrematchOutput(output)
      }),
    )

    results.push(...batchResults)
  }

  // Flatten and deduplicate
  return [...new Set(results.flat())]
}
