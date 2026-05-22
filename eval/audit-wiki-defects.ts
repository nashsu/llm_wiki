/**
 * Scan a wiki project against eval/wiki-defect-patterns.jsonl detectors.
 *
 * Usage:
 *   npx vite-node eval/audit-wiki-defects.ts <project-path>
 *
 * Example:
 *   npx vite-node eval/audit-wiki-defects.ts ~/wiki/ddia
 */

import { readFile, readdir } from "fs/promises"
import path from "path"
import { parseFrontmatter } from "@/lib/frontmatter"
import { dedupKey, pageId } from "@/lib/page-id"
import { parseFrontmatterArray } from "@/lib/sources-merge"
import { resolveWikiSlugId, unwrapWikilink } from "@/lib/wiki-page-resolver"

const STUB_MARKER = "_Stub page — batched ingest did not emit this file"
const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g

interface PatternRecord {
  id: string
  category: string
  pattern: string
  severity: string
  occurrences: number
}

interface PageRecord {
  rel: string
  slug: string
  dir: "concepts" | "entities"
  content: string
  title: string | null
}

interface Finding {
  id: string
  detail: string
}

export interface AuditReport {
  projectPath: string
  wikiRoot: string
  pageCount: number
  findings: Record<string, Finding[]>
  summary: Array<{
    id: string
    category: string
    severity: string
    baseline: number
    now: number
    status: "ok" | "warn" | "fail"
  }>
}

async function loadPatterns(): Promise<PatternRecord[]> {
  const p = path.join(import.meta.dirname, "wiki-defect-patterns.jsonl")
  const raw = await readFile(p, "utf-8")
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PatternRecord)
}

async function walkWikiMd(wikiRoot: string): Promise<PageRecord[]> {
  const pages: PageRecord[] = []
  for (const dir of ["concepts", "entities"] as const) {
    const folder = path.join(wikiRoot, dir)
    let entries: string[]
    try {
      entries = await readdir(folder)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue
      const abs = path.join(folder, name)
      const content = await readFile(abs, "utf-8")
      const { frontmatter } = parseFrontmatter(content)
      pages.push({
        rel: `${dir}/${name}`,
        slug: name.replace(/\.md$/i, ""),
        dir,
        content,
        title: typeof frontmatter?.title === "string" ? frontmatter.title : null,
      })
    }
  }
  return pages
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const item of items) {
    const k = keyFn(item)
    const arr = m.get(k) ?? []
    arr.push(item)
    m.set(k, arr)
  }
  return m
}

function isKebabSlug(s: string): boolean {
  const { slug } = unwrapWikilink(s.trim())
  return KEBAB_SLUG_RE.test(slug)
}

function collectWikilinks(body: string): Array<{ target: string; display: string | null }> {
  const out: Array<{ target: string; display: string | null }> = []
  for (const m of body.matchAll(WIKILINK_RE)) {
    out.push({ target: m[1].trim(), display: m[2]?.trim() ?? null })
  }
  return out
}

function slugifyTitle(title: string): string {
  return pageId(title)
}

/** Accept project root (`…/project/wiki/…`) or wiki root (`…/wiki/concepts`). */
async function resolveWikiRoot(inputPath: string): Promise<string> {
  const pp = path.resolve(inputPath)
  try {
    await readdir(path.join(pp, "concepts"))
    return pp
  } catch {
    /* not a wiki root */
  }
  const nested = path.join(pp, "wiki")
  try {
    await readdir(path.join(nested, "concepts"))
    return nested
  } catch {
    return nested
  }
}

export async function auditWikiProject(projectPath: string): Promise<AuditReport> {
  const pp = path.resolve(projectPath)
  const wikiRoot = await resolveWikiRoot(pp)
  const patterns = await loadPatterns()
  const pages = await walkWikiMd(wikiRoot)
  const knownIds = pages.map((p) => p.slug)
  const knownSet = new Set(knownIds)
  const findings: Record<string, Finding[]> = Object.fromEntries(
    patterns.map((p) => [p.id, []]),
  )

  // ── Duplicate slug clusters (dedupKey / case / truncation) ─────
  const byDedupKey = groupBy(pages, (p) => dedupKey(p.slug))
  for (const [key, group] of byDedupKey) {
    const distinctSlugs = [...new Set(group.map((p) => p.slug))]
    if (distinctSlugs.length < 2) continue
    const slugs = distinctSlugs.sort()
    const hasVersionDigits = /\d/.test(key)
    const hasCaseOnly =
      new Set(group.map((p) => p.slug.toLowerCase())).size === 1 &&
      new Set(group.map((p) => p.slug)).size > 1
    const hasTruncation = group.some((a) =>
      group.some(
        (b) =>
          a.slug !== b.slug &&
          b.slug.startsWith(a.slug) &&
          a.slug.length < b.slug.length,
      ),
    )

    const detail = `${distinctSlugs.length} slugs share dedupKey "${key}": ${slugs.join(", ")}`
    findings["WIKI-DUP-SLUG-PUNCTUATION"].push({ id: "WIKI-DUP-SLUG-PUNCTUATION", detail })
    if (hasVersionDigits) {
      findings["WIKI-DUP-SLUG-VERSION-NUMBER"].push({
        id: "WIKI-DUP-SLUG-VERSION-NUMBER",
        detail,
      })
    }
    if (hasCaseOnly) {
      findings["WIKI-DUP-SLUG-CASE"].push({ id: "WIKI-DUP-SLUG-CASE", detail })
    }
    if (hasTruncation) {
      findings["WIKI-DUP-SLUG-TRUNCATION"].push({ id: "WIKI-DUP-SLUG-TRUNCATION", detail })
    }
  }

  // ── Per-page checks ───────────────────────────────────────────
  for (const page of pages) {
    const { body } = parseFrontmatter(page.content)
    const bodyTrim = body.trim()

    if (page.content.includes(STUB_MARKER)) {
      findings["WIKI-STUB-UNFILLED"].push({
        id: "WIKI-STUB-UNFILLED",
        detail: page.rel,
      })
    }

    if (bodyTrim.length === 0) {
      findings["WIKI-PAGE-EMPTY"].push({ id: "WIKI-PAGE-EMPTY", detail: page.rel })
    }

    const firstLine = page.content.split(/\r?\n/)[0] ?? ""
    if (firstLine !== "---" && firstLine.trim() === "---") {
      findings["WIKI-FRONTMATTER-DELIMITER-WHITESPACE"].push({
        id: "WIKI-FRONTMATTER-DELIMITER-WHITESPACE",
        detail: `${page.rel} opening="${firstLine}"`,
      })
    }

    if (page.slug.startsWith("missing-page-")) {
      findings["WIKI-MISSING-PAGE-PLACEHOLDER"].push({
        id: "WIKI-MISSING-PAGE-PLACEHOLDER",
        detail: page.rel,
      })
    }

    if (page.title) {
      const fromTitle = slugifyTitle(page.title)
      if (fromTitle && fromTitle !== page.slug) {
        const titleTokens = new Set(fromTitle.split("-"))
        const slugTokens = page.slug.split("-")
        const extra = slugTokens.filter((t) => !titleTokens.has(t))
        if (extra.length > 0) {
          findings["WIKI-TITLE-SLUG-MISMATCH"].push({
            id: "WIKI-TITLE-SLUG-MISMATCH",
            detail: `${page.rel} title="${page.title}" slug="${page.slug}" extra=[${extra.join(",")}]`,
          })
        }
      }
    }

    for (const raw of parseFrontmatterArray(page.content, "related")) {
      if (!isKebabSlug(raw)) {
        findings["WIKI-FRONTMATTER-INCONSISTENT-LIST"].push({
          id: "WIKI-FRONTMATTER-INCONSISTENT-LIST",
          detail: `${page.rel} related=${JSON.stringify(raw)}`,
        })
      }
    }

    for (const { target } of collectWikilinks(body)) {
      const norm = target.toLowerCase().replace(/\s+/g, "-")
      const resolved = resolveWikiSlugId(target, knownIds)

      if (target === page.slug || norm === page.slug) {
        findings["WIKI-LINK-SELF-REFERENCE"].push({
          id: "WIKI-LINK-SELF-REFERENCE",
          detail: `${page.rel} → [[${target}]]`,
        })
      }

      if (/[\[\(]/.test(target) && !/^\[\[/.test(target)) {
        findings["WIKI-LINK-MALFORMED-TEXT"].push({
          id: "WIKI-LINK-MALFORMED-TEXT",
          detail: `${page.rel} → [[${target}]]`,
        })
      }

      if (resolved === null) {
        if (knownSet.has(norm)) {
          findings["WIKI-LINK-CASE-MISMATCH"].push({
            id: "WIKI-LINK-CASE-MISMATCH",
            detail: `${page.rel} → [[${target}]] (ci match: ${norm})`,
          })
        } else if (/[A-Z\s]/.test(target) || target.includes("(")) {
          findings["WIKI-LINK-TITLE-FORM"].push({
            id: "WIKI-LINK-TITLE-FORM",
            detail: `${page.rel} → [[${target}]]`,
          })
        } else {
          findings["WIKI-LINK-BROKEN-NONEXISTENT"].push({
            id: "WIKI-LINK-BROKEN-NONEXISTENT",
            detail: `${page.rel} → [[${target}]]`,
          })
        }
      }
    }
  }

  // ── Cross-type slug collision ─────────────────────────────────
  const conceptSlugs = new Set(pages.filter((p) => p.dir === "concepts").map((p) => p.slug))
  for (const slug of pages.filter((p) => p.dir === "entities").map((p) => p.slug)) {
    if (conceptSlugs.has(slug)) {
      findings["WIKI-TYPE-COLLISION"].push({
        id: "WIKI-TYPE-COLLISION",
        detail: slug,
      })
    }
  }

  // ── Index / log ───────────────────────────────────────────────
  try {
    const indexPath = path.join(wikiRoot, "index.md")
    const index = await readFile(indexPath, "utf-8")
    const indexLines = index.split(/\r?\n/).length
    const conceptLines = (index.match(/^-\s+\[\[/gm) ?? []).length
    if (pages.length > 50 && conceptLines < pages.length * 0.5) {
      findings["WIKI-INDEX-STALE"].push({
        id: "WIKI-INDEX-STALE",
        detail: `index.md ${indexLines} lines, ${conceptLines} listed pages, ${pages.length} on disk`,
      })
    }
  } catch {
    findings["WIKI-INDEX-STALE"].push({
      id: "WIKI-INDEX-STALE",
      detail: "wiki/index.md missing",
    })
  }

  try {
    const logPath = path.join(wikiRoot, "log.md")
    const log = await readFile(logPath, "utf-8")
    const lines = log.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const seen = new Map<string, number>()
    for (const line of lines) {
      seen.set(line, (seen.get(line) ?? 0) + 1)
    }
    for (const [line, count] of seen) {
      if (count > 1) {
        findings["WIKI-LOG-DUPLICATE-ENTRY"].push({
          id: "WIKI-LOG-DUPLICATE-ENTRY",
          detail: `${count}x ${line.slice(0, 80)}`,
        })
      }
    }
  } catch {
    // log optional
  }

  // ── created date spread ───────────────────────────────────────
  const createdCounts = new Map<string, number>()
  for (const page of pages) {
    const { frontmatter } = parseFrontmatter(page.content)
    const created =
      typeof frontmatter?.created === "string" ? frontmatter.created : "(missing)"
    createdCounts.set(created, (createdCounts.get(created) ?? 0) + 1)
  }
  const distinctCreated = [...createdCounts.entries()]
    .filter(([d]) => d !== "(missing)")
    .sort((a, b) => b[1] - a[1])
  if (distinctCreated.length > 3) {
    findings["WIKI-METADATA-INCONSISTENT-DATES"].push({
      id: "WIKI-METADATA-INCONSISTENT-DATES",
      detail: distinctCreated
        .slice(0, 8)
        .map(([d, n]) => `${d}:${n}`)
        .join(", "),
    })
  }

  // Patterns without automated detectors in this pass
  for (const id of [
    "WIKI-DUP-TYPO",
    "WIKI-DUP-SEMANTIC",
    "WIKI-CONTENT-HALLUCINATION",
  ]) {
    if (!findings[id]) findings[id] = []
  }

  const summary = patterns.map((p) => {
    const now = findings[p.id]?.length ?? 0
    const baseline = p.occurrences
    let status: "ok" | "warn" | "fail" = "ok"
    if (now > 0 && now >= baseline * 0.5) status = "fail"
    else if (now > 0) status = "warn"
    return {
      id: p.id,
      category: p.category,
      severity: p.severity,
      baseline,
      now,
      status,
    }
  })

  return { projectPath: pp, wikiRoot, pageCount: pages.length, findings, summary }
}

function printReport(report: AuditReport & { wikiRoot?: string }): void {
  console.log(`\nWiki defect audit — ${report.projectPath}`)
  if (report.wikiRoot && report.wikiRoot !== report.projectPath) {
    console.log(`Wiki root: ${report.wikiRoot}`)
  }
  console.log(`Pages scanned: ${report.pageCount}\n`)
  console.log(
    `${"ID".padEnd(42)} ${"baseline".padStart(8)} ${"now".padStart(6)}  status`,
  )
  console.log("-".repeat(70))
  for (const row of report.summary) {
    const icon = row.status === "ok" ? "✓" : row.status === "warn" ? "~" : "✗"
    console.log(
      `${row.id.padEnd(42)} ${String(row.baseline).padStart(8)} ${String(row.now).padStart(6)}  ${icon} ${row.status}`,
    )
  }

  const failing = report.summary.filter((r) => r.now > 0)
  if (failing.length === 0) {
    console.log("\nNo automated findings.")
    return
  }

  console.log("\nSamples (first 3 per pattern):\n")
  for (const row of failing) {
    const samples = report.findings[row.id]?.slice(0, 3) ?? []
    if (samples.length === 0) continue
    console.log(`## ${row.id} (${row.now})`)
    for (const s of samples) console.log(`  - ${s.detail}`)
    if (row.now > 3) console.log(`  … +${row.now - 3} more`)
    console.log()
  }
}

const projectArg = process.argv[2]
if (projectArg) {
  const report = await auditWikiProject(projectArg)
  printReport(report)
  const anyFail = report.summary.some((r) => r.now > 0)
  process.exit(anyFail ? 1 : 0)
}
