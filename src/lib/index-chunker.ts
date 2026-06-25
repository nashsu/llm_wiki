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
