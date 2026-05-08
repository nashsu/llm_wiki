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

export function appendLogContent(existing: string | null | undefined, incoming: string): string {
  const entry = normalizeLogAppendContent(incoming)
  const base = (existing ?? "").trimEnd()

  if (!entry) return base
  if (!base) return entry.endsWith("\n") ? entry : `${entry}\n`
  return `${base}\n\n${entry}\n`
}
