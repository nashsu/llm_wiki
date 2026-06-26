/**
 * Overview section chunking — symmetric to index-chunker.ts but for prose overview.md.
 *
 * Splits an overview into `##` sections, numbers each with an [N] prefix for
 * prematch reference, and groups sections into chunks that stay under
 * maxChunkChars. Later tasks add prematch, OVERVIEW block parsing and
 * incremental append on top of this file.
 */

import { streamChat } from "@/lib/llm-client"
import { currentWikiDate } from "@/lib/ingest"
import type { LlmConfig } from "@/stores/wiki-store"

interface OverviewSection {
  heading: string | null
  content: string
}

function parseOverviewSections(overview: string): OverviewSection[] {
  const lines = overview.split("\n")
  const sections: OverviewSection[] = []
  let currentLines: string[] = []

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (currentLines.length > 0) {
        sections.push({ heading: extractHeading(currentLines[0]), content: currentLines.join("\n") })
      }
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  if (currentLines.length > 0) {
    sections.push({ heading: extractHeading(currentLines[0]), content: currentLines.join("\n") })
  }

  return sections
}

function extractHeading(line: string): string | null {
  const match = line.match(/^##\s+(.+)$/)
  return match ? match[1].trim() : null
}

export function chunkOverviewBySections(overview: string, maxChunkChars: number): string[] {
  if (!overview.trim()) return []

  const sections = parseOverviewSections(overview)
  if (!sections.some((s) => s.heading !== null)) {
    return [overview]
  }
  const chunks: string[] = []
  let current = ""
  let sectionNum = 0

  for (const section of sections) {
    const prefix = section.heading
      ? `[${++sectionNum}] ## ${section.heading}`
      : `[${++sectionNum}] (preamble)`
    const numbered = prefix + "\n" + section.content.replace(/^##\s.*$/m, "").trim()

    if (current.length + numbered.length + 2 > maxChunkChars && current) {
      chunks.push(current)
      current = numbered
    } else {
      current = current ? `${current}\n\n${numbered}` : numbered
    }
  }

  if (current) chunks.push(current)
  return chunks
}

/**
 * Parse prematch LLM output into section names.
 * Tolerant: handles [操作系统, 进程管理], none, 无, surrounding text.
 * Returns deduplicated section names, or empty array if none.
 */
export function parseOverviewPrematchOutput(output: string): string[] {
  const trimmed = output.trim()
  if (!trimmed) return []

  const lower = trimmed.toLowerCase()
  if (lower === "none" || trimmed === "无") return []

  // Try to extract bracketed names first: [操作系统, 进程管理]
  const bracketMatch = trimmed.match(/\[([^\]]+)\]/)
  const source = bracketMatch ? bracketMatch[1] : trimmed

  return source
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Build the system prompt for an overview pre-match LLM call.
 * The LLM reads the source document and a chunk of overview sections,
 * then outputs matching section names.
 */
export function buildOverviewPrematchPrompt(sourceContent: string, chunk: string): string {
  return [
    "You are a relevance matcher. Read the source document and determine",
    "which overview sections are related to it.",
    "",
    "## Source Document",
    sourceContent,
    "",
    "## Overview Sections",
    "Below is a chunk of the wiki overview. Each section starts with [N] and a heading.",
    "For each section, determine whether it covers the same subject as any",
    "topic in the source document. A match means the section discusses the",
    "same entity, concept, method, or topic area.",
    "",
    chunk,
    "",
    "## Output Format (STRICT)",
    "",
    "Output ONLY matching section names in bracket format: [操作系统, 进程管理]",
    "Use the exact heading text (without the ## prefix).",
    "If no sections match, output exactly: none",
    "",
    "Do not output explanations, reasoning, or any other text.",
  ].join("\n")
}

/**
 * Assemble a reduced overview from the original overview.md and matched section names.
 * Only includes sections whose heading matches. Preserves original section content.
 */
export function assembleReducedOverview(overview: string, matchedSections: string[]): string {
  if (matchedSections.length === 0) return ""

  const matchSet = new Set(matchedSections.map((s) => s.trim()))
  const sections = parseOverviewSections(overview)
  const lines: string[] = []

  for (const section of sections) {
    if (section.heading && matchSet.has(section.heading)) {
      lines.push(section.content.trim())
      lines.push("")
    }
  }

  return lines.join("\n").trim()
}

const OVERVIEW_PREMATCH_CONCURRENCY = 8

/**
 * Run pre-match LLM calls in parallel across all overview chunks.
 * Returns the union of all matched section names.
 * Failed chunks are logged and skipped (treated as 0 matches).
 */
export async function runOverviewPrematchParallel(
  chunks: string[],
  sourceContent: string,
  llmConfig: LlmConfig,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (chunks.length === 0) return []

  const results: string[][] = []

  // Process in batches of OVERVIEW_PREMATCH_CONCURRENCY
  for (let i = 0; i < chunks.length; i += OVERVIEW_PREMATCH_CONCURRENCY) {
    if (signal?.aborted) break
    const batch = chunks.slice(i, i + OVERVIEW_PREMATCH_CONCURRENCY)

    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        let output = ""
        let hadError = false

        try {
          await streamChat(
            llmConfig,
            [
              { role: "system", content: buildOverviewPrematchPrompt(sourceContent, chunk) },
              { role: "user", content: "Output matching section names for the chunk above." },
            ],
            {
              onToken: (token: string) => { output += token },
              onDone: () => {},
              onError: (err: Error) => {
                hadError = true
                console.warn(`[overview-prematch] chunk failed: ${err.message}`)
              },
            },
            signal,
            { temperature: 0.1, reasoning: { mode: "off" } },
          )
        } catch (err) {
          hadError = true
          console.warn(`[overview-prematch] chunk threw: ${err instanceof Error ? err.message : String(err)}`)
        }

        if (hadError) return []
        return parseOverviewPrematchOutput(output)
      }),
    )

    results.push(...batchResults)
  }

  // Flatten and deduplicate
  return [...new Set(results.flat())]
}

export interface ParsedOverviewBlock {
  section: string
  content: string
}

const OVERVIEW_BLOCK_REGEX = /---OVERVIEW:\s*(.+?)\s*---\n([\s\S]*?)---END OVERVIEW---/g

/**
 * Parse ---OVERVIEW: SectionName--- blocks from LLM generation output.
 * Symmetric to parseIndexBlocks in index-chunker.ts.
 */
export function parseOverviewBlocks(text: string): ParsedOverviewBlock[] {
  const normalized = text.replace(/\r\n/g, "\n")
  const blocks: ParsedOverviewBlock[] = []
  for (const match of normalized.matchAll(OVERVIEW_BLOCK_REGEX)) {
    const section = match[1].trim()
    const content = match[2].trim()
    blocks.push({ section, content })
  }
  return blocks
}

/**
 * Programmatically append parsed OVERVIEW block content to existing overview.md.
 * - Appends to existing `## Section` (before the next ## or EOF)
 * - Creates a new `## Section` at the end if it does not exist
 * - Updates the `updated:` field in frontmatter to today's date (when present)
 * - Returns the original content unchanged when no blocks are provided
 * Symmetric to appendIndexEntries in index-chunker.ts.
 */
export function appendOverviewContent(
  overviewContent: string,
  blocks: ParsedOverviewBlock[],
): string {
  if (blocks.length === 0) return overviewContent

  const lines = overviewContent.split("\n")
  const result = [...lines]

  for (const block of blocks) {
    if (!block.content.trim()) continue
    const sectionHeader = `## ${block.section}`

    let sectionStartIdx = -1
    for (let i = 0; i < result.length; i++) {
      if (result[i].trim() === sectionHeader) {
        sectionStartIdx = i
        break
      }
    }

    if (sectionStartIdx >= 0) {
      let insertIdx = result.length
      for (let i = sectionStartIdx + 1; i < result.length; i++) {
        if (/^##\s/.test(result[i].trim())) {
          insertIdx = i
          break
        }
      }
      result.splice(insertIdx, 0, "", block.content)
    } else {
      result.push("", sectionHeader, block.content)
    }
  }

  // Update frontmatter `updated:` date if present
  if (result[0]?.trim() === "---") {
    for (let i = 1; i < result.length; i++) {
      if (result[i].trim() === "---") break
      if (/^updated:/.test(result[i])) {
        result[i] = `updated: ${currentWikiDate()}`
        break
      }
    }
  }

  return result.join("\n")
}

/**
 * Create the initial overview.md with frontmatter for the first ingest.
 * Symmetric to the index.md bootstrap, but for prose overview sections.
 */
export function createInitialOverview(
  blocks: ParsedOverviewBlock[],
  date?: string,
): string {
  const d = date ?? currentWikiDate()
  const lines: string[] = [
    "---",
    "type: overview",
    'title: "Overview"',
    `created: ${d}`,
    `updated: ${d}`,
    "tags: []",
    "related: []",
    "---",
    "",
    "# Overview",
  ]

  for (const block of blocks) {
    lines.push("")
    lines.push(`## ${block.section}`)
    lines.push(block.content)
  }

  return lines.join("\n")
}
