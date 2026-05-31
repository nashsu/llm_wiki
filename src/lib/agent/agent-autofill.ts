/**
 * Property Autofill Agent (Phase 3.65-D)
 *
 * After ingest writes wiki pages, this module scans for concept/entity pages
 * and automatically fills missing Status and Tags frontmatter fields.
 *
 * Status rules:
 *   - Draft + created ≥7 days ago + content has Definition + Key Points + ≥1 wikilink → Under Review
 *   - Referenced by ≥2 source summary pages → Reviewed
 *
 * Tag rules:
 *   - concept/entity with empty tags → extract 1-3 keywords from title + body headings
 */

import { readFile, listDirectory, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

export interface AutofillResult {
  pagesScanned: number
  statusPromoted: number
  tagsAssigned: number
  details: Array<{ path: string; action: "status" | "tags"; from: string; to: string }>
}

// ── helpers ──────────────────────────────────────────────────────────────────

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

/** Extract wikilink targets from markdown body (case-insensitive). */
function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim().toLowerCase())
  }
  return links
}

/** Check if body has a Definition-like section. */
function hasDefinitionSection(body: string): boolean {
  return /^##?\s*(definition|definição|定义|什么是)/im.test(body)
}

/** Check if body has a Key Points / Core Features section. */
function hasKeyPointsSection(body: string): boolean {
  return /^##?\s*(key\s*points?|core\s*features?|highlights?|要点|核心|主要|关键|特征|特性)/im.test(body)
}

/** Check if body has at least N wikilinks. */
function hasWikilinks(body: string, min = 1): boolean {
  const links = extractWikilinks(body)
  return links.length >= min
}

/** Check if content is "complete" for status promotion. */
function isContentComplete(body: string): boolean {
  return hasDefinitionSection(body) && hasKeyPointsSection(body) && hasWikilinks(body, 1)
}

/** Days since a date string (YYYY-MM-DD). Returns Infinity if unparseable. */
function daysSince(dateStr: string): number {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return Infinity
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)
}

// ── tag extraction ───────────────────────────────────────────────────────────

/**
 * Extract 1-3 tags from page title and body headings.
 * Simple heuristic: uses title + h2 headings as tag candidates,
 * filters generic terms, returns up to 3 unique lowercase tags.
 */
function extractTagsFromContent(title: string, body: string): string[] {
  const candidates = new Set<string>()

  // Title is the strongest signal
  if (title) {
    // Split title on common separators, take meaningful words
    const titleWords = title
      .split(/[-–—:,/\s]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 2 && !GENERIC_TERMS.has(w))
    for (const w of titleWords) candidates.add(w)
  }

  // H2 headings as secondary signal
  const headingRegex = /^##\s+(.+)$/gm
  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(body)) !== null) {
    const heading = match[1].trim().toLowerCase()
    const words = heading
      .split(/[-–—:,/\s]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !GENERIC_TERMS.has(w))
    for (const w of words) candidates.add(w)
  }

  // Take up to 3, preferring shorter (more general) tags
  return [...candidates].sort((a, b) => a.length - b.length).slice(0, 3)
}

const GENERIC_TERMS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was",
  "not", "but", "can", "had", "has", "have", "will", "does", "did",
  "into", "over", "such", "than", "then", "they", "them", "their",
  "what", "when", "where", "which", "while", "who", "why", "how",
  "all", "any", "both", "each", "more", "most", "other", "some",
  "about", "after", "before", "between", "during", "through",
  "introduction", "overview", "conclusion", "summary", "background",
  "example", "examples", "notes", "note", "see", "also", "using",
  "based", "system", "method", "approach", "concept", "entity",
  "source", "sources", "related", "updated", "created",
  "definition", "key", "points", "features", "core", "main",
])

// ── core logic ───────────────────────────────────────────────────────────────

interface PageEntry {
  path: string
  slug: string
  frontmatter: Record<string, string | string[]>
  body: string
  type: string
}

/** Scan wiki directory and return concept/entity pages with parsed frontmatter. */
async function scanWikiPages(projectPath: string): Promise<PageEntry[]> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`

  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const allFiles = flattenMdFiles(tree)
  const entries: PageEntry[] = []

  for (const f of allFiles) {
    try {
      const content = await readFile(f.path)
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter) continue

      const type = String(frontmatter.type || "").toLowerCase()
      if (type !== "concept" && type !== "entity") continue

      const slug = getRelativePath(f.path, wikiRoot).replace(/\.md$/, "")

      entries.push({
        path: f.path,
        slug,
        frontmatter: frontmatter as Record<string, string | string[]>,
        body,
        type,
      })
    } catch {
      // skip unreadable files
    }
  }

  return entries
}

/** Count how many source summary pages reference each concept/entity slug. */
async function countSummaryReferences(
  projectPath: string,
  targetSlugs: Set<string>,
): Promise<Map<string, number>> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`

  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return new Map()
  }

  const allFiles = flattenMdFiles(tree)
  const counts = new Map<string, number>()
  for (const slug of targetSlugs) counts.set(slug, 0)

  for (const f of allFiles) {
    try {
      const content = await readFile(f.path)
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter) continue

      const type = String(frontmatter.type || "").toLowerCase()
      if (type !== "source") continue

      // Check wikilinks in body
      const links = extractWikilinks(body)
      for (const link of links) {
        if (counts.has(link)) {
          counts.set(link, (counts.get(link) ?? 0) + 1)
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return counts
}

// Note: countSummaryReferences re-scans the wiki directory independently from
// scanWikiPages. For small wikis this is negligible; if I/O becomes a concern,
// pass pre-scanned page entries to avoid re-reading files.

/** Update frontmatter field in a markdown file. */
async function updateFrontmatterField(
  filePath: string,
  field: string,
  value: string | string[],
): Promise<void> {
  const content = await readFile(filePath)
  const { frontmatter, body } = parseFrontmatter(content)
  if (!frontmatter) return

  // Rebuild frontmatter YAML
  const lines = ["---"]
  const fmEntries = Object.entries(frontmatter)
  let found = false
  for (const [key, val] of fmEntries) {
    if (key === field) {
      lines.push(`${key}: ${formatYamlValue(value)}`)
      found = true
    } else {
      lines.push(`${key}: ${formatYamlValue(val)}`)
    }
  }
  if (!found) {
    lines.push(`${field}: ${formatYamlValue(value)}`)
  }
  lines.push("---")

  // Reconstruct file: new frontmatter + original body
  const newContent = lines.join("\n") + "\n" + body
  await writeFile(filePath, newContent)
}

function formatYamlValue(val: string | string[]): string {
  if (Array.isArray(val)) {
    if (val.length === 0) return "[]"
    return `[${val.map((v) => `"${v}"`).join(", ")}]`
  }
  // Quote strings that contain special YAML chars
  if (typeof val === "string" && /[:#{}[\],&*?|>!%@`]/.test(val)) {
    return `"${val.replace(/"/g, '\\"')}"`
  }
  return String(val)
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Run property autofill on the wiki.
 *
 * 1. Scans all concept/entity pages
 * 2. Promotes status where criteria are met
 * 3. Assigns tags to pages with empty tags
 *
 * Returns a result summary. Does NOT call LLM — pure heuristic.
 */
export async function runAutofill(projectPath: string): Promise<AutofillResult> {
  const result: AutofillResult = {
    pagesScanned: 0,
    statusPromoted: 0,
    tagsAssigned: 0,
    details: [],
  }

  const pages = await scanWikiPages(projectPath)
  result.pagesScanned = pages.length

  if (pages.length === 0) return result

  // Phase 1: Count summary references for all concept/entity slugs
  const targetSlugs = new Set(pages.map((p) => p.slug.toLowerCase()))
  const refCounts = await countSummaryReferences(projectPath, targetSlugs)

  // Phase 2: Process each page
  for (const page of pages) {
    const status = String(page.frontmatter.status || "").toLowerCase()
    const created = String(page.frontmatter.created || "")
    const tags = page.frontmatter.tags
    const hasTags = Array.isArray(tags) ? tags.length > 0 : Boolean(tags)

    // ── Status promotion ──
    // Skip pages that already have a non-Draft/non-empty status
    if (!status || status === "draft") {
      const refCount = refCounts.get(page.slug.toLowerCase()) ?? 0

      // Rule 1: Referenced by ≥2 summaries → Reviewed (highest priority)
      if (refCount >= 2) {
        try {
          await updateFrontmatterField(page.path, "status", "Reviewed")
          result.statusPromoted++
          result.details.push({
            path: page.slug,
            action: "status",
            from: status || "(empty)",
            to: "Reviewed",
          })
        } catch (err) {
          console.warn(`[autofill] failed to promote status for ${page.slug}:`, err)
        }
        continue // page already reached highest status; tags can wait for next pass
      }

      // Rule 2: Draft ≥7 days + content complete → Under Review
      if (created && daysSince(created) >= 7 && isContentComplete(page.body)) {
        try {
          await updateFrontmatterField(page.path, "status", "Under Review")
          result.statusPromoted++
          result.details.push({
            path: page.slug,
            action: "status",
            from: status || "(empty)",
            to: "Under Review",
          })
        } catch (err) {
          console.warn(`[autofill] failed to promote status for ${page.slug}:`, err)
        }
      }
    }

    // ── Tag assignment ──
    if (!hasTags) {
      const title = String(page.frontmatter.title || page.slug.split("/").pop() || "")
      const extractedTags = extractTagsFromContent(title, page.body)
      if (extractedTags.length > 0) {
        try {
          await updateFrontmatterField(page.path, "tags", extractedTags)
          result.tagsAssigned++
          result.details.push({
            path: page.slug,
            action: "tags",
            from: "(empty)",
            to: extractedTags.join(", "),
          })
        } catch (err) {
          console.warn(`[autofill] failed to assign tags for ${page.slug}:`, err)
        }
      }
    }
  }

  return result
}
