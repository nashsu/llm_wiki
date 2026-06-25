/**
 * Chunk an index.md string into fixed-size chunks by entry count.
 * Each chunk preserves the ## Category headers for context.
 * Entries are numbered sequentially with [N] prefix across all chunks.
 */

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
