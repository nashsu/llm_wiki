import { sanitizeIngestedFileContent } from "@/lib/ingest-sanitize"

function stripLeadingFrontmatter(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "")
}

function stripLeadingLogTitle(content: string): string {
  return content.replace(/^\s*#\s+(?:Wiki Log|위키 로그)\s*(?:\r?\n|$)/i, "")
}

export function normalizeLogAppendContent(content: string): string {
  let cleaned = sanitizeIngestedFileContent(content).trim()
  let previous = ""

  while (cleaned && cleaned !== previous) {
    previous = cleaned
    cleaned = stripLeadingFrontmatter(cleaned).trim()
    cleaned = stripLeadingLogTitle(cleaned).trim()
  }

  return cleaned
}

function findLogInsertionPoint(content: string): number {
  let cursor = 0
  const frontmatter = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/)
  if (frontmatter) cursor = frontmatter[0].length

  const title = content
    .slice(cursor)
    .match(/^\s*#\s+(?:Wiki Log|위키 로그)\s*(?:\r?\n|$)/i)
  if (title) return cursor + title[0].length

  return cursor
}

export function appendLogContent(existing: string | null | undefined, incoming: string): string {
  const entry = normalizeLogAppendContent(incoming)
  const base = (existing ?? "").trimEnd()

  if (!entry) return base
  if (!base) return entry.endsWith("\n") ? entry : `${entry}\n`

  const insertionPoint = findLogInsertionPoint(base)
  const head = base.slice(0, insertionPoint).trimEnd()
  const tail = base.slice(insertionPoint).trim()

  if (!tail) return `${head}\n\n${entry}\n`
  if (!head) return `${entry}\n\n${tail}\n`
  return `${head}\n\n${entry}\n\n${tail}\n`
}
