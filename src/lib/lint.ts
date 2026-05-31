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
}

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
  type PageData = { path: string; slug: string; content: string; outlinks: string[] }
  const pages: PageData[] = []

  for (const f of contentFiles) {
    try {
      const content = await readFile(f.path)
      const slug = relativeToSlug(getRelativePath(f.path, wikiRoot))
      const outlinks = extractWikilinks(content)
      pages.push({ path: f.path, slug, content, outlinks })
    } catch {
      // skip unreadable files
    }
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
    const shortName = getRelativePath(p.path, wikiRoot)

    // Orphan: no inbound links (lowercased slug for case-insensitive match)
    const inbound = inboundCounts.get(p.slug.toLowerCase()) ?? 0
    if (inbound === 0) {
      results.push({
        type: "orphan",
        severity: "info",
        page: shortName,
        detail: "No other pages link to this page.",
      })
    }

    // No outbound links
    if (p.outlinks.length === 0) {
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: shortName,
        detail: "This page has no [[wikilink]] references to other pages.",
      })
    }

    // Broken links — case-insensitive matching.
    for (const link of p.outlinks) {
      const lookup = link.toLowerCase()
      const basename = getFileName(link).replace(/\.md$/, "").toLowerCase()
      const exists = slugMap.has(lookup) || slugMap.has(basename)
      if (!exists) {
        results.push({
          type: "broken-link",
          severity: "warning",
          page: shortName,
          detail: `Broken link: [[${link}]] — target page not found.`,
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

// ── Lint Report (Phase 3.65-B) ──────────────────────────────────────────────

/** Structured lint report with health score, auto-fix/human split, and repair log. */
export interface LintReport {
  healthScore: number
  stats: {
    totalPages: number
    totalIssues: number
    orphanCount: number
    brokenLinkCount: number
    noOutlinksCount: number
    semanticCount: number
  }
  autoFixItems: LintResult[]
  humanItems: LintResult[]
  /** Appended by the fixer after auto-fix runs. */
  repairLog?: {
    fixed: string[]
    failed: string[]
    skipped: string[]
  }
}

/** Categorize lint result as auto-fixable or human-only.
 *  Matches the logic in lint-fixer.ts isFixable() plus severity filter. */
function classifyFixability(result: LintResult): "auto" | "human" {
  if (result.type === "semantic") {
    const detail = result.detail.toLowerCase()
    if (detail.startsWith("[suggestion]")) return "human"
  }
  // All structural issues and semantic non-suggestions are auto-fixable
  return "auto"
}

/** Compute health score from lint results (100-based, deduct per issue). */
function computeHealthScore(results: LintResult[]): number {
  let score = 100
  for (const r of results) {
    if (r.type === "orphan") score -= 5
    else if (r.type === "broken-link") score -= 3
    else if (r.type === "no-outlinks") score -= 2
    else if (r.type === "semantic") {
      const detail = r.detail.toLowerCase()
      if (detail.startsWith("[contradiction]") || detail.startsWith("[stale]")) score -= 10
      else score -= 3
    }
  }
  return Math.max(0, score)
}

/** Generate a structured lint report from raw lint results. */
export function generateLintReport(
  results: LintResult[],
  totalPages: number,
): LintReport {
  const stats = {
    totalPages,
    totalIssues: results.length,
    orphanCount: results.filter((r) => r.type === "orphan").length,
    brokenLinkCount: results.filter((r) => r.type === "broken-link").length,
    noOutlinksCount: results.filter((r) => r.type === "no-outlinks").length,
    semanticCount: results.filter((r) => r.type === "semantic").length,
  }

  const autoFixItems: LintResult[] = []
  const humanItems: LintResult[] = []

  for (const r of results) {
    if (classifyFixability(r) === "auto") {
      autoFixItems.push(r)
    } else {
      humanItems.push(r)
    }
  }

  return {
    healthScore: computeHealthScore(results),
    stats,
    autoFixItems,
    humanItems,
  }
}

/** Serialize a LintReport to a markdown page body for saving into the wiki. */
export function lintReportToMarkdown(report: LintReport, runId: string): string {
  const hc = report.healthScore
  const icon = hc >= 80 ? "🟢" : hc >= 50 ? "🟡" : "🔴"

  let md = `---
type: lint-report
date: ${new Date().toISOString().slice(0, 10)}
healthScore: ${report.healthScore}
runId: ${runId}
---

# Lint Report ${icon}

**Health Score**: ${report.healthScore}/100
**Run**: ${runId}
**Pages scanned**: ${report.stats.totalPages}
**Issues found**: ${report.stats.totalIssues}

## Statistics

| Category | Count |
|----------|-------|
| Orphan pages | ${report.stats.orphanCount} |
| Broken links | ${report.stats.brokenLinkCount} |
| No outbound links | ${report.stats.noOutlinksCount} |
| Semantic issues | ${report.stats.semanticCount} |

---

## 🤖 Auto-Fix Items (${report.autoFixItems.length})

`

  if (report.autoFixItems.length === 0) {
    md += `No auto-fix items.\n\n`
  } else {
    for (const item of report.autoFixItems) {
      md += `### ${item.severity === "warning" ? "⚠️" : "ℹ️"} [${item.type}] ${item.page}\n`
      md += `${item.detail}\n`
      if (item.affectedPages && item.affectedPages.length > 0) {
        md += `- Affected: ${item.affectedPages.join(", ")}\n`
      }
      md += `\n`
    }
  }

  md += `---\n\n## 👤 Human Intervention Items (${report.humanItems.length})\n\n`

  if (report.humanItems.length === 0) {
    md += `No items requiring human attention.\n\n`
  } else {
    for (const item of report.humanItems) {
      md += `### ${item.severity === "warning" ? "⚠️" : "ℹ️"} [${item.type}] ${item.page}\n`
      md += `${item.detail}\n`
      if (item.affectedPages && item.affectedPages.length > 0) {
        md += `- Affected: ${item.affectedPages.join(", ")}\n`
      }
      md += `\n`
    }
  }

  md += `---\n\n## 🔧 Repair Log\n\n_(appended by fixer after auto-fix runs)_\n`

  if (report.repairLog) {
    if (report.repairLog.fixed.length > 0) {
      md += `### ✅ Fixed (${report.repairLog.fixed.length})\n`
      for (const f of report.repairLog.fixed) {
        md += `- ${f}\n`
      }
      md += `\n`
    }
    if (report.repairLog.failed.length > 0) {
      md += `### ❌ Failed (${report.repairLog.failed.length})\n`
      for (const f of report.repairLog.failed) {
        md += `- ${f}\n`
      }
      md += `\n`
    }
    if (report.repairLog.skipped.length > 0) {
      md += `### ⏭️ Skipped (${report.repairLog.skipped.length})\n`
      for (const s of report.repairLog.skipped) {
        md += `- ${s}\n`
      }
      md += `\n`
    }
  }

  return md
}
