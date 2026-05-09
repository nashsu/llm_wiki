import { parseFrontmatter } from "@/lib/frontmatter"
import type { ReviewItem } from "@/stores/review-store"

export interface WikiPageSnapshot {
  /** Path relative to the wiki root, e.g. `concepts/foo.md` or `index.md`. */
  relativePath: string
  content: string
}

export interface MissingWikiReference {
  target: string
  pages: string[]
}

function stripMarkdownCode(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "")
}

function normalizeTarget(raw: string): string {
  return raw
    .split("|")[0]
    .split("#")[0]
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
}

function basenameTarget(target: string): string {
  const parts = target.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? target
}

function targetKeys(raw: string): string[] {
  const target = normalizeTarget(raw)
  if (!target) return []
  const base = basenameTarget(target)
  return Array.from(new Set([target.toLowerCase(), base.toLowerCase()]))
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const body = stripMarkdownCode(parseFrontmatter(content).body)
  const regex = /\[\[([^\]]+?)\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(body)) !== null) {
    const target = normalizeTarget(match[1])
    if (target) links.push(target)
  }
  return links
}

function extractRelatedTargets(content: string): string[] {
  const parsed = parseFrontmatter(content).frontmatter
  const related = parsed?.related
  if (!Array.isArray(related)) return []
  return related.map(normalizeTarget).filter((s) => s.length > 0)
}

function buildKnownTargetKeys(pages: WikiPageSnapshot[]): Set<string> {
  const known = new Set<string>()
  for (const page of pages) {
    const relativeNoExt = normalizeTarget(page.relativePath)
    for (const key of targetKeys(relativeNoExt)) known.add(key)

    const title = parseFrontmatter(page.content).frontmatter?.title
    if (typeof title === "string" && title.trim()) {
      known.add(title.trim().toLowerCase())
    }
  }
  return known
}

export function findMissingWikiReferences(
  pages: WikiPageSnapshot[],
  pathsToScan: string[],
): MissingWikiReference[] {
  const known = buildKnownTargetKeys(pages)
  const scanSet = new Set(pathsToScan.map((p) => normalizeTarget(p).toLowerCase()))
  const byTarget = new Map<string, Set<string>>()

  for (const page of pages) {
    const pageKey = normalizeTarget(page.relativePath).toLowerCase()
    if (!scanSet.has(pageKey)) continue

    const references = [
      ...extractWikilinks(page.content),
      ...extractRelatedTargets(page.content),
    ]

    for (const ref of references) {
      const keys = targetKeys(ref)
      if (keys.length === 0) continue
      if (keys.some((key) => known.has(key))) continue
      const display = normalizeTarget(ref)
      const pagesForTarget = byTarget.get(display) ?? new Set<string>()
      pagesForTarget.add(page.relativePath)
      byTarget.set(display, pagesForTarget)
    }
  }

  return Array.from(byTarget.entries())
    .map(([target, pageSet]) => ({
      target,
      pages: Array.from(pageSet).sort(),
    }))
    .sort((a, b) => a.target.localeCompare(b.target))
}

export function missingReferencesToReviewItems(
  missing: MissingWikiReference[],
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  return missing.map((item) => ({
    type: "missing-page",
    title: `Missing wiki page: ${item.target}`,
    description: [
      `Generated wiki content references [[${item.target}]], but no matching page exists yet.`,
      "Create the page, fix the link target, or skip if the reference should remain unresolved.",
    ].join("\n"),
    sourcePath,
    affectedPages: item.pages.map((p) => `wiki/${p}`),
    searchQueries: undefined,
    options: [
      { label: "Create Page", action: "Create Page" },
      { label: "Skip", action: "Skip" },
    ],
  }))
}

export function buildDeterministicIngestLogEntry(
  sourceFileName: string,
  writtenPaths: readonly string[],
  date = new Date().toISOString().slice(0, 10),
): string {
  const sourceTitle = sourceFileName.replace(/\.[^.]+$/, "")
  const contentPaths = Array.from(new Set(
    writtenPaths.filter((p) => p !== "wiki/log.md" && !p.endsWith("/log.md")),
  )).sort()

  const lines = [
    `## [${date}] ingest | ${sourceTitle}`,
    "",
    `- Source: \`${sourceFileName}\``,
    `- Files written: ${contentPaths.length}`,
  ]

  for (const p of contentPaths) {
    lines.push(`  - \`${p}\``)
  }

  return `${lines.join("\n")}\n`
}
