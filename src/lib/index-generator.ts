/**
 * Deterministic wiki/index.md and wiki/log.md generation.
 *
 * Why this exists: ingest used to ask the LLM to emit an updated
 * index.md (full file) and a log.md entry on every wave. Because the
 * Claude/Codex CLI transports are stateless and the HTTP providers see
 * only a snapshot of the current index, the model routinely dropped
 * existing index entries, re-referenced deleted pages, or echoed the
 * entire log (which the append-only writer then duplicated). The index
 * is fully derivable from each page's frontmatter, so we generate it
 * from disk instead — the LLM never writes it. The log is append-only
 * and its single new line is composed here from the ingest date + the
 * source title rather than trusted to the model.
 *
 * These functions are pure (string in, string out); the caller in
 * ingest.ts is responsible for reading every page off disk and writing
 * the result back inside the project lock.
 */

import { parseFrontmatter } from "@/lib/frontmatter"
import { inferWikiTypeFromPath, wikiTypeLabel } from "@/lib/wiki-page-types"
import { normalizePath, getFileName } from "@/lib/path-utils"

export interface IndexInputPage {
  /** Wiki-root-relative path, e.g. "wiki/entities/foo.md". */
  relativePath: string
  content: string
}

/** Display order for known page types; unknown/custom types follow,
 * sorted alphabetically. Mirrors WIKI_TYPE_DIRS ordering in
 * wiki-page-types.ts so the rendered index is stable run-to-run. */
const TYPE_DISPLAY_ORDER = [
  "entity",
  "concept",
  "source",
  "query",
  "comparison",
  "synthesis",
  "finding",
  "thesis",
  "methodology",
]

// Aggregate / structural files that are never themselves index entries.
// schema.md and purpose.md are project-scaffolding pages (some projects
// place them under wiki/); excluding them by basename keeps stray
// `[[schema]]` / `[[purpose]]` entries out of the index.
const EXCLUDED_BASENAMES = new Set([
  "index.md",
  "log.md",
  "overview.md",
  "schema.md",
  "purpose.md",
])

interface IndexEntry {
  slug: string
  type: string
  description: string
}

/**
 * Build the complete wiki/index.md content deterministically from the
 * frontmatter + first body sentence of every content page.
 *
 * Pages are grouped by type (entity, concept, …) in a stable order;
 * each entry is `- [[slug]] — description`. The slug is the page's
 * filename without extension so it resolves as an Obsidian wikilink.
 */
export function generateIndexMd(
  pages: IndexInputPage[],
  opts: { date: string },
): string {
  const entries: IndexEntry[] = []
  for (const page of pages) {
    const rel = normalizePath(page.relativePath)
    const baseName = getFileName(rel).toLowerCase()
    if (EXCLUDED_BASENAMES.has(baseName)) continue
    if (!rel.endsWith(".md")) continue
    // Source summary pages live under wiki/sources/ and ARE indexed
    // (type "source"); only the three aggregate files above are skipped.

    const { frontmatter, body } = parseFrontmatter(page.content)
    const slug = getFileName(rel).replace(/\.md$/i, "")
    if (!slug) continue

    const fmType =
      typeof frontmatter?.type === "string" ? frontmatter.type.trim() : ""
    const type = fmType || inferWikiTypeFromPath(rel) || "other"
    // overview-typed stray pages (other than overview.md, already
    // excluded) shouldn't appear as index entries either.
    if (type === "overview") continue

    const title =
      typeof frontmatter?.title === "string" ? frontmatter.title.trim() : ""
    const description = extractIndexDescription(body, title, slug)
    entries.push({ slug, type, description })
  }

  // Group by type.
  const byType = new Map<string, IndexEntry[]>()
  for (const entry of entries) {
    const bucket = byType.get(entry.type) ?? []
    bucket.push(entry)
    byType.set(entry.type, bucket)
  }

  const orderedTypes = [...byType.keys()].sort(compareTypes)

  const sections: string[] = []
  for (const type of orderedTypes) {
    const bucket = byType.get(type)
    if (!bucket || bucket.length === 0) continue
    bucket.sort((a, b) => a.slug.localeCompare(b.slug))
    const heading = pluralizeTypeLabel(type)
    const lines = bucket.map((entry) =>
      entry.description
        ? `- [[${entry.slug}]] — ${entry.description}`
        : `- [[${entry.slug}]]`,
    )
    sections.push(`## ${heading}\n\n${lines.join("\n")}`)
  }

  const frontmatter = [
    "---",
    "type: overview",
    "title: Wiki Index",
    "tags: []",
    "related: []",
    `created: ${opts.date}`,
    `updated: ${opts.date}`,
    "---",
  ].join("\n")

  const body =
    sections.length > 0
      ? sections.join("\n\n")
      : "_No pages yet._"

  return `${frontmatter}\n\n# Wiki Index\n\n${body}\n`
}

/** Order known types by TYPE_DISPLAY_ORDER, then unknown types A→Z. */
function compareTypes(a: string, b: string): number {
  const ia = TYPE_DISPLAY_ORDER.indexOf(a)
  const ib = TYPE_DISPLAY_ORDER.indexOf(b)
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return a.localeCompare(b)
}

/** Section heading for a type: known labels pluralized, custom types
 * title-cased via wikiTypeLabel. */
function pluralizeTypeLabel(type: string): string {
  switch (type) {
    case "entity":
      return "Entities"
    case "concept":
      return "Concepts"
    case "source":
      return "Sources"
    case "query":
      return "Queries"
    case "comparison":
      return "Comparisons"
    case "synthesis":
      return "Synthesis"
    case "finding":
      return "Findings"
    case "thesis":
      return "Theses"
    case "methodology":
      return "Methodologies"
    case "other":
      return "Other"
    default:
      return wikiTypeLabel(type)
  }
}

const MAX_DESCRIPTION_CHARS = 200

/**
 * Derive a one-line description for an index entry: the first sentence
 * of the page body, falling back to the title, then the slug. Markdown
 * decoration (wikilinks, links, emphasis, inline code) is flattened to
 * plain text so the index line stays readable.
 */
export function extractIndexDescription(
  body: string,
  title: string,
  slug: string,
): string {
  const firstSentence = firstBodySentence(body)
  const chosen = firstSentence || title || slug.replace(/[-_]+/g, " ")
  return truncate(flattenInlineMarkdown(chosen), MAX_DESCRIPTION_CHARS)
}

/** Pull the first prose sentence from a markdown body, skipping the H1
 * heading, blank lines, HTML comments, and block markup. */
function firstBodySentence(body: string): string {
  const lines = body.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("#")) continue // headings (incl. the H1)
    if (line.startsWith("<!--")) continue // HTML comments
    if (line.startsWith("---")) continue // stray fences / hrules
    if (line.startsWith("```")) continue // code fences
    if (line.startsWith(">")) continue // blockquote placeholders
    if (/^[-*+]\s/.test(line)) continue // list items (rarely a good summary)
    if (/^\|/.test(line)) continue // table rows
    // Found a prose line. Take up to the first sentence terminator.
    const sentence = line.match(/^(.+?[.!?])(?:\s|$)/)
    return sentence ? sentence[1] : line
  }
  return ""
}

/** Strip inline markdown so a description renders as clean text. */
function flattenInlineMarkdown(text: string): string {
  return text
    // [[target|alias]] → alias ; [[target]] → target
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    // [label](url) → label
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // **bold** / *italic* / _italic_ / `code`
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * Build the single log.md line for an ingest. Append-only: the caller
 * concatenates this onto the existing log, never rewriting prior
 * entries. Format matches the historical LLM-emitted shape so existing
 * logs stay consistent: `## [YYYY-MM-DD] ingest | Title`.
 */
export function buildLogEntry(date: string, title: string): string {
  const clean = title.trim().replace(/\s+/g, " ") || "(untitled source)"
  return `## [${date}] ingest | ${clean}`
}
