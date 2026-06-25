import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
  brokenTarget?: string
  suggestedTarget?: string
  suggestedSource?: string
}

const BROKEN_LINK_SUGGESTION_MIN_SCORE = 0.74
const RELATED_PAGE_SUGGESTION_MIN_SCORE = 0.08
const SAME_FOLDER_SCORE_BONUS = 0.08
const SINGLE_CJK_TOKEN_WEIGHT = 0.35
const SUGGESTION_TOKEN_WINDOW = 4000
const SAME_BASENAME_SCORE = 0.96
const CONTAINS_TARGET_SCORE = 0.82

// ── helpers ───────────────────────────────────────────────────────────────────

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

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function relativeToSlug(relativePath: string): string {
  // relativePath relative to wiki/ dir, e.g. "entities/foo-bar" or "queries/my-page-2024-01-01"
  return relativePath.replace(/\.md$/, "")
}

function normalizeLinkTarget(target: string): string {
  return normalizePath(target)
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase()
}

function extractTitle(content: string, fallbackPath: string): string {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (frontmatter) {
    const title = frontmatter[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (title?.[1]?.trim()) return title[1].trim()
  }
  const heading = content.match(/^#\s+(.+)$/m)
  if (heading?.[1]?.trim()) return heading[1].trim()
  return getFileName(fallbackPath)
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
}

function tokenizeForSuggestion(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.normalize("NFKC").toLowerCase()
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0]
    if (token.length >= 2) tokens.add(token)
    if (/[\u3400-\u9fff]/u.test(token)) {
      for (const char of Array.from(token)) tokens.add(char)
    }
  }
  return tokens
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  const current = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      )
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]
  }
  return previous[b.length]
}

function stringSimilarity(a: string, b: string): number {
  const left = normalizeLinkTarget(a)
  const right = normalizeLinkTarget(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const leftBase = getFileName(left)
  const rightBase = getFileName(right)
  if (leftBase === rightBase) return SAME_BASENAME_SCORE
  if (right.includes(left) || left.includes(right)) return CONTAINS_TARGET_SCORE
  if (leftBase.length < 5 || rightBase.length < 5) return 0
  const maxLen = Math.max(leftBase.length, rightBase.length)
  if (maxLen === 0) return 0
  return 1 - levenshtein(leftBase, rightBase) / maxLen
}

/**
 * Build a slug → absolute path map from wiki files. Keys are lowercased
 * so [[Transformer]] matches transformer.md — wikilink matching should
 * be case-insensitive (matching typical wiki conventions). Callers must
 * also lowercase their lookup keys.
 */
function buildSlugMap(
  wikiFiles: FileNode[],
  wikiRoot: string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const f of wikiFiles) {
    // e.g. /path/to/project/wiki/entities/foo.md → entities/foo
    const rel = getRelativePath(f.path, wikiRoot).replace(/\.md$/, "")
    map.set(rel.toLowerCase(), f.path)
    // also index by basename without extension
    map.set(f.name.replace(/\.md$/, "").toLowerCase(), f.path)
  }
  return map
}

// ── Structural lint ───────────────────────────────────────────────────────────

export async function runStructuralLint(projectPath: string): Promise<LintResult[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const wikiFiles = flattenMdFiles(tree)
  // Exclude index.md and log.md from orphan checks
  const contentFiles = wikiFiles.filter(
    (f) => f.name !== "index.md" && f.name !== "log.md"
  )

  const slugMap = buildSlugMap(contentFiles, wikiRoot)

  // Read all content files
  type PageData = {
    path: string
    shortName: string
    slug: string
    title: string
    content: string
    outlinks: string[]
    tokens: Set<string>
  }
  const pages: PageData[] = []

  for (const f of contentFiles) {
    try {
      const content = await readFile(f.path)
      const shortName = getRelativePath(f.path, wikiRoot)
      const slug = relativeToSlug(shortName)
      const title = extractTitle(content, shortName)
      const outlinks = extractWikilinks(content)
      const slugName = getFileName(slug)
      const tokens = tokenizeForSuggestion(`${title}\n${slugName}\n${content.slice(0, SUGGESTION_TOKEN_WINDOW)}`)
      pages.push({ path: f.path, shortName, slug, title, content, outlinks, tokens })
    } catch {
      // skip unreadable files
    }
  }

  function suggestBrokenTarget(target: string): PageData | undefined {
    let best: { page: PageData; score: number } | undefined
    for (const candidate of pages) {
      const score = Math.max(
        stringSimilarity(target, candidate.slug),
        stringSimilarity(target, candidate.shortName),
        stringSimilarity(target, candidate.title),
      )
      if (score > (best?.score ?? 0)) best = { page: candidate, score }
    }
    return best && best.score >= BROKEN_LINK_SUGGESTION_MIN_SCORE ? best.page : undefined
  }

  function suggestRelatedPage(page: PageData, direction: "source" | "target"): PageData | undefined {
    const existingOutlinks = new Set(page.outlinks.map(normalizeLinkTarget))
    let best: { page: PageData; score: number } | undefined
    for (const candidate of pages) {
      if (candidate.shortName === page.shortName) continue
      if (direction === "target") {
        const candidateKeys = [
          normalizeLinkTarget(candidate.slug),
          normalizeLinkTarget(candidate.shortName),
          normalizeLinkTarget(getFileName(candidate.shortName).replace(/\.md$/i, "")),
        ]
        if (candidateKeys.some((key) => existingOutlinks.has(key))) continue
      }
      let overlap = 0
      for (const token of page.tokens) {
        if (candidate.tokens.has(token)) overlap += token.length > 1 ? 1 : SINGLE_CJK_TOKEN_WEIGHT
      }
      if (overlap === 0) continue
      const folderBonus =
        page.shortName.split("/")[0] === candidate.shortName.split("/")[0] ? SAME_FOLDER_SCORE_BONUS : 0
      const score =
        overlap / Math.sqrt(Math.max(1, page.tokens.size) * Math.max(1, candidate.tokens.size)) +
        folderBonus
      if (score > (best?.score ?? 0)) best = { page: candidate, score }
    }
    return best && best.score >= RELATED_PAGE_SUGGESTION_MIN_SCORE ? best.page : undefined
  }

  // Build inbound link count. Lookups are case-insensitive — [[Transformer]]
  // should match transformer.md (slug "transformer").
  const inboundCounts = new Map<string, number>()
  for (const p of pages) {
    for (const link of p.outlinks) {
      const lookup = link.toLowerCase()
      const target = slugMap.has(lookup)
        ? relativeToSlug(getRelativePath(slugMap.get(lookup)!, wikiRoot)).toLowerCase()
        : lookup
      inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1)
    }
  }

  const results: LintResult[] = []

  for (const p of pages) {
    const shortName = p.shortName

    // Orphan: no inbound links (lowercased slug for case-insensitive match)
    const inbound = inboundCounts.get(p.slug.toLowerCase()) ?? 0
    if (inbound === 0) {
      const suggestedSource = suggestRelatedPage(p, "source")
      results.push({
        type: "orphan",
        severity: "info",
        page: shortName,
        detail: "No other pages link to this page.",
        suggestedSource: suggestedSource?.shortName,
      })
    }

    // No outbound links
    if (p.outlinks.length === 0) {
      const suggestedTarget = suggestRelatedPage(p, "target")
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: shortName,
        detail: "This page has no [[wikilink]] references to other pages.",
        suggestedTarget: suggestedTarget?.shortName,
      })
    }

    // Broken links — case-insensitive matching.
    for (const link of p.outlinks) {
      const lookup = link.toLowerCase()
      const basename = getFileName(link).replace(/\.md$/, "").toLowerCase()
      const exists = slugMap.has(lookup) || slugMap.has(basename)
      if (!exists) {
        const suggestedTarget = suggestBrokenTarget(link)
        results.push({
          type: "broken-link",
          severity: "warning",
          page: shortName,
          detail: `Broken link: [[${link}]] — target page not found.`,
          brokenTarget: link,
          suggestedTarget: suggestedTarget?.shortName,
        })
      }
    }
  }

  return results
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

export async function runSemanticLint(
  projectPath: string,
  llmConfig: LlmConfig,
): Promise<LintResult[]> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Semantic wiki lint",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    activity.updateItem(activityId, { status: "error", detail: "Failed to read wiki directory." })
    return []
  }

  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md"
  )

  // Build a compact summary of each page (frontmatter + first 500 chars)
  const summaries: string[] = []
  for (const f of wikiFiles) {
    try {
      const content = await readFile(f.path)
      const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "")
      const shortPath = getRelativePath(f.path, wikiRoot)
      summaries.push(`### ${shortPath}\n${preview}`)
    } catch {
      // skip
    }
  }

  if (summaries.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No wiki pages to lint." })
    return []
  }

  activity.updateItem(activityId, { detail: "Running LLM semantic analysis..." })

  // For auto-mode language detection, sample the concatenated summaries
  // so non-English wikis get a matching language directive.
  const summarySample = summaries.join("\n").slice(0, 2000)

  const prompt = [
    "You are a wiki quality analyst. Review the following wiki page summaries and identify issues.",
    "",
    buildLanguageDirective(summarySample),
    "",
    "For each issue, output exactly this format:",
    "",
    "---LINT: type | severity | Short title---",
    "Description of the issue.",
    "PAGES: page1.md, page2.md",
    "---END LINT---",
    "",
    "Types:",
    "- contradiction: two or more pages make conflicting claims",
    "- stale: information that appears outdated or superseded",
    "- missing-page: an important concept is heavily referenced but has no dedicated page",
    "- suggestion: a question or source worth adding to the wiki",
    "",
    "Severities:",
    "- warning: should be addressed",
    "- info: nice to have",
    "",
    "Only report genuine issues. Do not invent problems. Output ONLY the ---LINT--- blocks, no other text.",
    "",
    "## Wiki Pages",
    "",
    summaries.join("\n\n"),
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        activity.updateItem(activityId, {
          status: "error",
          detail: `LLM error: ${err.message}`,
        })
      },
    },
  )

  if (hadError) return []

  const results: LintResult[] = []
  const matches = raw.matchAll(LINT_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    // semantic results always use type "semantic"
    void rawType

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, "").trim()

    results.push({
      type: "semantic",
      severity: (severity === "warning" ? "warning" : "info") as LintResult["severity"],
      page: title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `Found ${results.length} semantic issue(s).`,
  })

  return results
}
