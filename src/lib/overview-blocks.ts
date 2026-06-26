/**
 * Overview section chunking — symmetric to index-chunker.ts but for prose overview.md.
 *
 * Splits an overview into `##` sections, numbers each with an [N] prefix for
 * prematch reference, and groups sections into chunks that stay under
 * maxChunkChars. Later tasks add prematch, OVERVIEW block parsing and
 * incremental append on top of this file.
 */

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
