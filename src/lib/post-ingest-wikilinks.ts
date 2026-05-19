import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { parseFrontmatterArray, writeFrontmatterArray } from "@/lib/sources-merge"
import { canonicalizePageIds } from "@/lib/wiki-page-resolver"
import type { FileNode } from "@/types/wiki"

const STRUCTURAL_PAGE_IDS = new Set(["index", "log", "overview", "purpose", "schema"])
const MAX_NEW_WIKILINKS_PER_PAGE = 15

interface LinkTarget {
  slug: string
  title?: string
}

interface LinkCandidate {
  target: string
  term: string
  normalizedTerm: string
  isCjk: boolean
}

interface ApplyResult {
  content: string
  added: number
}

export async function postLinkIngestedPages(
  projectPath: string,
  pagePaths: string[],
): Promise<{ updatedPaths: string[]; totalAdded: number }> {
  const pp = normalizePath(projectPath)
  const uniquePages = [...new Set(pagePaths)]
  if (uniquePages.length === 0) return { updatedPaths: [], totalAdded: 0 }

  const targets = await buildLinkTargetCatalog(pp)
  if (targets.length === 0) return { updatedPaths: [], totalAdded: 0 }

  const knownSlugs = targets.map((t) => t.slug)
  const updatedPaths: string[] = []
  let totalAdded = 0

  for (const relPath of uniquePages) {
    const absPath = `${pp}/${relPath}`
    let content = ""
    try {
      content = await readFile(absPath)
    } catch {
      continue
    }

    const selfSlug = relPath.replace(/^.*\//, "").replace(/\.md$/i, "")
    const { content: linked, added } = addDeterministicWikilinks(
      content,
      targets,
      selfSlug,
      MAX_NEW_WIKILINKS_PER_PAGE,
    )
    const withRelated = normalizePageReferencesOnWrite(linked, knownSlugs)
    if (added <= 0 && withRelated === content) continue

    await writeFile(absPath, withRelated)
    updatedPaths.push(relPath)
    totalAdded += added
  }

  return { updatedPaths, totalAdded }
}

/**
 * Write-time normalization for entity/concept pages: resolve shorthand
 * `related:` entries to canonical page ids and dedupe the array.
 */
export function normalizePageReferencesOnWrite(
  content: string,
  knownSlugs: readonly string[],
): string {
  return canonicalizeRelatedFrontmatter(content, knownSlugs)
}

/** Rewrite `related:` slugs to ids that exist on disk (e.g. `spark` → `apache-spark`). */
export function canonicalizeRelatedFrontmatter(
  content: string,
  knownSlugs: readonly string[],
): string {
  const related = parseFrontmatterArray(content, "related")
  if (related.length === 0) return content

  const canonical = canonicalizePageIds(related, knownSlugs)
  const unchanged =
    canonical.length === related.length &&
    canonical.every((id, i) => id === related[i])
  if (unchanged) return content
  return writeFrontmatterArray(content, "related", canonical)
}

export function addDeterministicWikilinks(
  content: string,
  targets: LinkTarget[],
  selfSlug: string,
  maxAdded: number = MAX_NEW_WIKILINKS_PER_PAGE,
): ApplyResult {
  if (!content || targets.length === 0 || maxAdded <= 0) return { content, added: 0 }

  const parsed = parseFrontmatter(content)
  const prefix = parsed.rawBlock
  const body = parsed.body
  if (!body.trim()) return { content, added: 0 }

  const candidates = buildCandidates(targets, selfSlug)
  if (candidates.length === 0) return { content, added: 0 }

  const linkedTargets = new Set<string>()
  let added = 0
  const segments = splitEditableSegments(body)

  const rewritten = segments.map((seg) => {
    if (!seg.editable || added >= maxAdded) return seg.text
    const result = linkSegment(seg.text, candidates, linkedTargets, maxAdded - added)
    added += result.added
    return result.text
  }).join("")

  if (added === 0) return { content, added: 0 }
  return { content: prefix + rewritten, added }
}

async function buildLinkTargetCatalog(projectPath: string): Promise<LinkTarget[]> {
  let tree: FileNode[] = []
  try {
    tree = await listDirectory(`${projectPath}/wiki`)
  } catch {
    return []
  }

  const files = flattenMdFiles(tree)
  const targets: LinkTarget[] = []

  for (const file of files) {
    const slug = file.name.replace(/\.md$/i, "")
    if (!slug || STRUCTURAL_PAGE_IDS.has(slug.toLowerCase())) continue

    let title: string | undefined
    try {
      const content = await readFile(file.path)
      const fm = parseFrontmatter(content).frontmatter
      const rawTitle = fm?.title
      if (typeof rawTitle === "string" && rawTitle.trim()) {
        title = rawTitle.trim()
      }
    } catch {
      // Title is optional; keep the slug target.
    }

    targets.push({ slug, title })
  }

  return targets
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) out.push(...flattenMdFiles(node.children))
    else if (!node.is_dir && node.name.endsWith(".md")) out.push(node)
  }
  return out
}

function buildCandidates(targets: LinkTarget[], selfSlug: string): LinkCandidate[] {
  const self = selfSlug.toLowerCase()
  const dedup = new Set<string>()
  const out: LinkCandidate[] = []

  for (const t of targets) {
    const target = t.slug.trim()
    if (!target) continue
    if (target.toLowerCase() === self) continue

    const terms = [target, t.title ?? ""]
    for (const rawTerm of terms) {
      const term = rawTerm.trim()
      if (!term) continue
      if (!isTermEligible(term)) continue
      const key = `${target.toLowerCase()}::${term.toLowerCase()}`
      if (dedup.has(key)) continue
      dedup.add(key)
      out.push({
        target,
        term,
        normalizedTerm: term.toLowerCase(),
        isCjk: hasCjk(term),
      })
    }
  }

  // Longest-match-first when several candidates can match same location.
  out.sort((a, b) => b.term.length - a.term.length)
  return out
}

function isTermEligible(term: string): boolean {
  const compactLen = term.replace(/\s+/g, "").length
  if (hasCjk(term)) return compactLen >= 2
  return compactLen >= 3
}

function splitEditableSegments(body: string): Array<{ text: string; editable: boolean }> {
  let segments: Array<{ text: string; editable: boolean }> = [{ text: body, editable: true }]
  segments = splitByRegex(segments, /(```[\s\S]*?```)/g)
  segments = splitByRegex(segments, /(`[^`\n]+`)/g)
  segments = splitByRegex(segments, /(\[\[[^\]\n]+(?:\|[^\]\n]*)?\]\])/g)
  return segments
}

function splitByRegex(
  segments: Array<{ text: string; editable: boolean }>,
  pattern: RegExp,
): Array<{ text: string; editable: boolean }> {
  const out: Array<{ text: string; editable: boolean }> = []
  for (const seg of segments) {
    if (!seg.editable) {
      out.push(seg)
      continue
    }
    const parts = seg.text.split(pattern)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!part) continue
      out.push({ text: part, editable: i % 2 === 0 })
    }
  }
  return out
}

function linkSegment(
  text: string,
  candidates: LinkCandidate[],
  linkedTargets: Set<string>,
  budget: number,
): { text: string; added: number } {
  if (budget <= 0 || !text) return { text, added: 0 }

  let cursor = 0
  let added = 0
  let output = text

  while (added < budget) {
    const match = findNextMatch(output, cursor, candidates, linkedTargets)
    if (!match) break

    const display = output.slice(match.start, match.end)
    const replacement = display === match.target
      ? `[[${match.target}]]`
      : `[[${match.target}|${display}]]`

    output = output.slice(0, match.start) + replacement + output.slice(match.end)
    cursor = match.start + replacement.length
    linkedTargets.add(match.target.toLowerCase())
    added++
  }

  return { text: output, added }
}

function findNextMatch(
  text: string,
  from: number,
  candidates: LinkCandidate[],
  linkedTargets: Set<string>,
): { start: number; end: number; target: string } | null {
  let best: { start: number; end: number; target: string; len: number } | null = null
  const lowerText = text.toLowerCase()

  for (const c of candidates) {
    if (linkedTargets.has(c.target.toLowerCase())) continue
    const idx = findTermIndex(lowerText, text, c, from)
    if (idx === -1) continue
    const len = c.term.length
    if (
      !best ||
      idx < best.start ||
      (idx === best.start && len > best.len)
    ) {
      best = { start: idx, end: idx + len, target: c.target, len }
    }
  }

  if (!best) return null
  return { start: best.start, end: best.end, target: best.target }
}

function findTermIndex(
  lowerText: string,
  rawText: string,
  candidate: LinkCandidate,
  from: number,
): number {
  let idx = lowerText.indexOf(candidate.normalizedTerm, from)
  while (idx !== -1) {
    const end = idx + candidate.term.length
    if (candidate.isCjk || hasWordBoundaries(rawText, idx, end)) return idx
    idx = lowerText.indexOf(candidate.normalizedTerm, idx + 1)
  }
  return -1
}

function hasWordBoundaries(text: string, start: number, end: number): boolean {
  const prev = start > 0 ? text[start - 1] : ""
  const next = end < text.length ? text[end] : ""
  return !isWordChar(prev) && !isWordChar(next)
}

function isWordChar(ch: string): boolean {
  if (!ch) return false
  return /[\p{L}\p{N}]/u.test(ch)
}

function hasCjk(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
}
