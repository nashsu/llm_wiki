/**
 * OKF v0.2 bundle export.
 *
 * Plans (pure) and runs (filesystem) an export of a project's `wiki/`
 * directory as an Open Knowledge Format v0.2 bundle:
 * https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
 *
 * The export is read-only against the project: it writes a transformed
 * copy to a user-chosen destination and never modifies the wiki.
 *
 * Conformance targets (spec §11):
 *  1. Every non-reserved .md file carries a parseable YAML frontmatter
 *     block with a non-empty `type`.
 *  2. Reserved `index.md` / `log.md` follow §8 / §9 structure.
 *  3. The bundle-root index.md declares `okf_version: "0.2"` (§12).
 *
 * Provenance accuracy: the exporter never synthesizes trust or
 * provenance fields. `generated`/`verified` are only copied through
 * when a page already carries them; llm_wiki's flat `created`/`updated`
 * dates are preserved as-is rather than re-labeled, because they do not
 * reliably record who produced the content (a page may be hand-edited).
 */

import yaml from "js-yaml"

import { parseFrontmatter } from "@/lib/frontmatter"

export const OKF_VERSION = "0.2"

const RESERVED_NAMES = new Set(["index.md", "log.md"])

export interface OkfSourcePage {
  /** Path relative to the wiki root, `/`-separated (e.g. "entities/foo.md"). */
  path: string
  content: string
}

export interface OkfBundleFile {
  /** Bundle-relative output path, `/`-separated. */
  path: string
  content: string
}

export interface OkfBundlePlan {
  files: OkfBundleFile[]
  conceptCount: number
  warnings: string[]
}

// ── path helpers ─────────────────────────────────────────────────────────────

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/")
}

function isUnsafeRelativePath(p: string): boolean {
  const n = normalizeSlashes(p)
  return (
    n.startsWith("/") ||
    /^[a-zA-Z]:\//.test(n) ||
    n.split("/").some((seg) => seg === "..")
  )
}

function baseName(p: string): string {
  const n = normalizeSlashes(p)
  return n.slice(n.lastIndexOf("/") + 1)
}

function dirName(p: string): string {
  const n = normalizeSlashes(p)
  const i = n.lastIndexOf("/")
  return i === -1 ? "" : n.slice(0, i)
}

function isReservedName(p: string): boolean {
  return RESERVED_NAMES.has(baseName(p).toLowerCase())
}

/**
 * Normalize a wikilink target the way llm_wiki resolves them: optional
 * `wiki/` prefix, optional `.md` suffix, case-insensitive.
 */
function normalizeLinkTarget(target: string): string {
  let t = normalizeSlashes(target.trim())
  if (t.startsWith("./")) t = t.slice(2)
  if (t.toLowerCase().startsWith("wiki/")) t = t.slice(5)
  if (t.startsWith("/")) t = t.slice(1)
  if (t.toLowerCase().endsWith(".md")) t = t.slice(0, -3)
  return t.toLowerCase()
}

function stripMdExtension(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p
}

/** Relative path from a directory ("" = bundle root) to a bundle path. */
function relativeLink(fromDir: string, toPath: string): string {
  const from = fromDir === "" ? [] : fromDir.split("/")
  const to = toPath.split("/")
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common++
  }
  const ups = from.length - common
  const parts = [...Array<string>(ups).fill(".."), ...to.slice(common)]
  return parts.join("/")
}

// ── wikilink rewriting ───────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g

export interface WikilinkRewrite {
  text: string
  /** Unique targets that could not be resolved to a page in the bundle. */
  unresolved: string[]
}

/**
 * Replace `[[target]]` / `[[target|alias]]` with standard markdown links.
 * Fenced code blocks and inline code spans are left untouched. Targets
 * that do not resolve to a page in the bundle degrade to plain text (the
 * alias, or the target) rather than emitting a guaranteed-broken link;
 * OKF consumers tolerate broken links, but a link we already know is
 * broken carries no value over text.
 */
export function rewriteWikilinks(
  text: string,
  linkFor: (target: string, label: string) => string | null,
): WikilinkRewrite {
  const unresolved = new Set<string>()
  const lines = text.split("\n")
  let inFence = false
  let fenceMarker = ""

  const out = lines.map((line) => {
    const fence = line.match(/^\s*(```+|~~~+)/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1][0]
      } else if (fence[1][0] === fenceMarker) {
        inFence = false
      }
      return line
    }
    if (inFence) return line

    // Split out inline code spans so `[[x]]` inside backticks survives.
    return line
      .split(/(`[^`]*`)/)
      .map((part, i) => {
        if (i % 2 === 1) return part // inline code span
        return part.replace(WIKILINK_RE, (_m, rawTarget: string, rawAlias?: string) => {
          const target = rawTarget.trim()
          const alias = rawAlias?.trim()
          const label = alias && alias.length > 0 ? alias : baseName(stripMdExtension(target))
          const link = linkFor(target, label)
          if (link === null) {
            unresolved.add(target)
            return label
          }
          return link
        })
      })
      .join("")
  })

  return { text: out.join("\n"), unresolved: [...unresolved] }
}

// ── link resolution ──────────────────────────────────────────────────────────

interface LinkResolver {
  /** Bundle-relative path (with .md) for a wikilink target, or null. */
  resolve(target: string): string | null
}

function buildLinkResolver(mdPaths: readonly string[]): LinkResolver {
  const byFull = new Map<string, string>()
  const byBase = new Map<string, string | null>() // null = ambiguous

  for (const p of mdPaths) {
    const full = normalizeLinkTarget(p)
    byFull.set(full, p)
    const base = normalizeLinkTarget(baseName(p))
    if (byBase.has(base)) {
      if (byBase.get(base) !== p) byBase.set(base, null)
    } else {
      byBase.set(base, p)
    }
  }

  return {
    resolve(target) {
      const norm = normalizeLinkTarget(target)
      const direct = byFull.get(norm)
      if (direct) return direct
      return byBase.get(norm) ?? null
    },
  }
}

// ── frontmatter mapping ──────────────────────────────────────────────────────

/** OKF families whose keys are written explicitly, not copied through. */
const HANDLED_KEYS = new Set([
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "sources",
  "usage_window",
  "generated",
  "verified",
  "status",
  "stale_after",
])

function isoDateTime(value: unknown): string | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00Z`
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return v
  return null
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
  }
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()]
  return []
}

export interface ConceptTransform {
  content: string
  unresolvedLinks: string[]
  warnings: string[]
}

/**
 * Map one llm_wiki page to an OKF v0.2 concept document.
 *
 * - `type` is required by OKF; pages without one fall back to `Concept`
 *   with a warning.
 * - llm_wiki `sources` (a flat list of source filenames/URLs) becomes
 *   OKF `sources` entries; `resource` is required within an entry.
 * - Trust fields are never synthesized: `generated`/`verified` only
 *   appear in the output when the source page already carries them.
 * - All other frontmatter keys pass through unchanged (spec §4.1:
 *   consumers must tolerate and should preserve producer extensions).
 */
/**
 * Re-parse the raw frontmatter block at full YAML fidelity.
 * parseFrontmatter intentionally normalizes every value to
 * string | string[] for the app's UI (nested values become JSON
 * text); for an export we want the author's actual values — numbers,
 * booleans, nested maps like an existing `generated`/`verified` or a
 * structured `sources` entry — preserved byte-semantically per OKF
 * section 4.1 ("consumers SHOULD preserve unknown keys when
 * round-tripping"). Falls back to null when the payload does not
 * parse as a mapping (e.g. repaired LLM output), in which case the
 * caller uses the normalized view.
 */
function fullFidelityFrontmatter(rawBlock: string): Record<string, unknown> | null {
  if (!rawBlock) return null
  const m = rawBlock.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!m) return null
  try {
    const parsed = yaml.load(m[1], { schema: yaml.JSON_SCHEMA })
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function transformConcept(
  page: OkfSourcePage,
  resolver: LinkResolver,
): ConceptTransform {
  const warnings: string[] = []
  const parsed = parseFrontmatter(page.content)

  // A frontmatter block that no parser can read must not be rewritten:
  // regenerating it from an empty map would silently DROP the author's
  // keys while the output still looks frontmatter-conformant. Export the
  // file verbatim with a warning instead (wikilinks and all).
  if (parsed.rawBlock && !parsed.frontmatter) {
    return {
      content: page.content,
      unresolvedLinks: [],
      warnings: [
        `${page.path}: frontmatter could not be parsed; exported unchanged (not rewritten to OKF form)`,
      ],
    }
  }

  const full = fullFidelityFrontmatter(parsed.rawBlock)
  if (parsed.rawBlock && full === null) {
    warnings.push(
      `${page.path}: frontmatter only parseable in normalized form (e.g. repaired wikilink lists); nested values export as text`,
    )
  }
  const fm: Record<string, unknown> = full ?? parsed.frontmatter ?? {}

  const out: Record<string, unknown> = {}

  const rawType =
    typeof fm.type === "string"
      ? fm.type.trim()
      : fm.type === null || fm.type === undefined
        ? ""
        : String(fm.type)
  if (rawType.length === 0) {
    out.type = "Concept"
    warnings.push(`${page.path}: missing frontmatter 'type', exported as 'Concept'`)
  } else {
    out.type = rawType
  }

  if (typeof fm.title === "string" && fm.title.trim()) out.title = fm.title
  if (typeof fm.description === "string" && fm.description.trim()) {
    out.description = fm.description
  }
  if (typeof fm.resource === "string" && fm.resource.trim()) out.resource = fm.resource
  const tags = asStringArray(fm.tags)
  if (tags.length > 0) out.tags = tags

  if (typeof fm.status === "string" && fm.status.trim()) out.status = fm.status
  const staleAfter = isoDateTime(fm.stale_after)
  if (staleAfter) out.stale_after = staleAfter

  // llm_wiki writes sources as a flat array of source filenames (the
  // ingest prompt's contract), which maps cleanly onto OKF entries
  // whose required key is `resource`. Any entry that is not a plain
  // string is already structured; copy it through unchanged rather
  // than dropping or mangling it.
  const rawSources = Array.isArray(fm.sources)
    ? fm.sources
    : typeof fm.sources === "string" && fm.sources.trim()
      ? [fm.sources.trim()]
      : []
  const sources = rawSources.map((entry) =>
    typeof entry === "string" ? { resource: entry } : entry,
  )
  if (sources.length > 0) out.sources = sources

  // Pass through spec families we do not compute (e.g. an author-added
  // `verified`) and all producer-defined extension keys, in source order.
  for (const [key, value] of Object.entries(fm)) {
    if (HANDLED_KEYS.has(key)) continue
    out[key] = value
  }
  if (fm.generated !== undefined) out.generated = fm.generated
  if (fm.verified !== undefined) out.verified = fm.verified
  if (fm.usage_window !== undefined) out.usage_window = fm.usage_window

  const frontmatterYaml = yaml.dump(out, {
    schema: yaml.JSON_SCHEMA,
    lineWidth: -1,
    noRefs: true,
    noCompatMode: true,
  })

  const body = rewriteWikilinks(parsed.body, (target, label) => {
    const resolved = resolver.resolve(target)
    if (!resolved) return null
    return `[${label}](/${resolved})`
  })

  return {
    content: `---\n${frontmatterYaml}---\n${body.text.startsWith("\n") ? "" : "\n"}${body.text}`,
    unresolvedLinks: body.unresolved,
    warnings,
  }
}

// ── index.md (§8) ────────────────────────────────────────────────────────────

/**
 * Rewrite an llm_wiki index.md for OKF: wikilinks become relative
 * markdown links, and the bundle-root index gains the `okf_version`
 * declaration (§12) — the only frontmatter an index may carry.
 */
export function transformIndex(
  page: OkfSourcePage,
  resolver: LinkResolver,
  isRoot: boolean,
): ConceptTransform {
  const warnings: string[] = []
  const parsed = parseFrontmatter(page.content)

  let existing: Record<string, unknown> = {}
  if (parsed.frontmatter) {
    if (isRoot) {
      existing = { ...parsed.frontmatter }
    } else {
      warnings.push(`${page.path}: index.md frontmatter dropped (OKF allows it only at the bundle root)`)
    }
  }

  const fromDir = dirName(page.path)
  const body = rewriteWikilinks(parsed.body, (target, label) => {
    const resolved = resolver.resolve(target)
    if (!resolved) return null
    return `[${label}](${relativeLink(fromDir, resolved)})`
  })

  let prefix = ""
  if (isRoot) {
    const fm = { okf_version: OKF_VERSION, ...existing }
    prefix = `---\n${yaml.dump(fm, { schema: yaml.JSON_SCHEMA, lineWidth: -1 })}---\n\n`
  }

  return {
    content: prefix + body.text.replace(/^\n+/, ""),
    unresolvedLinks: body.unresolved,
    warnings,
  }
}

/** Synthesize a bundle-root index.md when the wiki has none (§8, §12). */
export function synthesizeRootIndex(
  concepts: readonly { path: string; title: string }[],
): string {
  const groups = new Map<string, { path: string; title: string }[]>()
  for (const c of concepts) {
    const dir = dirName(c.path) || "."
    const list = groups.get(dir) ?? []
    list.push(c)
    groups.set(dir, list)
  }
  let out = `---\nokf_version: "${OKF_VERSION}"\n---\n\n# Index\n`
  for (const [dir, items] of [...groups.entries()].sort()) {
    out += `\n## ${dir}\n\n`
    for (const item of items) {
      out += `* [${item.title}](${relativeLink("", item.path)})\n`
    }
  }
  return out
}

// ── log.md (§9) ──────────────────────────────────────────────────────────────

const LOG_HEADING_RE = /^## \[(\d{4}-\d{2}-\d{2})\]\s*([^|\]]*?)\s*(?:\|\s*(.*))?$/

interface LogEntry {
  date: string
  op: string
  subject: string
  body: string
}

/**
 * Convert llm_wiki's `## [YYYY-MM-DD] op | subject` log.md to the OKF §9
 * shape (ISO date headings, newest first, bulleted entries). If any
 * heading does not parse, the file is exported verbatim with a warning
 * rather than risking a lossy rewrite of the user's history.
 */
export function transformLog(page: OkfSourcePage, resolver: LinkResolver): ConceptTransform {
  const warnings: string[] = []
  const lines = page.content.split("\n")

  let title = "# Directory Update Log"
  const entries: LogEntry[] = []
  let current: LogEntry | null = null
  const bodyLines: string[] = []
  let sawHeading = false

  const flush = () => {
    if (!current) return
    current.body = bodyLines.join(" ").replace(/\s+/g, " ").trim()
    bodyLines.length = 0
    entries.push(current)
  }

  for (const line of lines) {
    const h2 = line.match(/^## /)
    const m = line.match(LOG_HEADING_RE)
    if (h2 && !m) {
      // Unrecognized second-level heading: bail out losslessly.
      return {
        content: page.content,
        unresolvedLinks: [],
        warnings: [
          `${page.path}: kept as-is; heading "${line.trim().slice(0, 60)}" is not in '## [YYYY-MM-DD] op | subject' format`,
        ],
      }
    }
    if (m) {
      sawHeading = true
      flush()
      current = { date: m[1], op: m[2].trim(), subject: (m[3] ?? "").trim(), body: "" }
      continue
    }
    if (!sawHeading) {
      if (line.startsWith("# ")) title = line.trim()
      continue
    }
    bodyLines.push(line)
  }
  flush()

  const linkFor = (target: string, label: string): string | null => {
    const resolved = resolver.resolve(target)
    if (!resolved) return null
    return `[${label}](/${resolved})`
  }

  // Newest first; stable within a date so original order survives.
  const byDate = new Map<string, LogEntry[]>()
  for (const e of entries) {
    const list = byDate.get(e.date) ?? []
    list.push(e)
    byDate.set(e.date, list)
  }
  const dates = [...byDate.keys()].sort((a, b) => (a < b ? 1 : -1))

  let out = `${title}\n`
  for (const date of dates) {
    out += `\n## ${date}\n\n`
    for (const e of byDate.get(date) ?? []) {
      const op = e.op ? e.op[0].toUpperCase() + e.op.slice(1) : "Update"
      const subject = e.subject ? ` ${rewriteWikilinks(e.subject, linkFor).text}` : ""
      const detail = e.body ? ` — ${rewriteWikilinks(e.body, linkFor).text}` : ""
      out += `* **${op}**:${subject}${detail}\n`
    }
  }
  return { content: out, unresolvedLinks: [], warnings }
}

// ── bundle planner ───────────────────────────────────────────────────────────

/**
 * Plan a complete OKF v0.2 bundle from the wiki's pages. Pure: performs
 * no IO, so the whole transformation is unit-testable.
 */
export function planOkfBundle(pages: readonly OkfSourcePage[]): OkfBundlePlan {
  const warnings: string[] = []
  const files: OkfBundleFile[] = []
  const unresolvedByPage: [string, string[]][] = []

  const usable: OkfSourcePage[] = []
  for (const page of pages) {
    const path = normalizeSlashes(page.path).replace(/^\.\//, "").replace(/^\/+/, "")
    if (isUnsafeRelativePath(page.path)) {
      warnings.push(`${page.path}: skipped (unsafe path)`)
      continue
    }
    usable.push({ path, content: page.content })
  }

  const mdPaths = usable.filter((p) => p.path.toLowerCase().endsWith(".md")).map((p) => p.path)
  const resolver = buildLinkResolver(mdPaths)

  let conceptCount = 0
  let hasRootIndex = false
  const conceptListing: { path: string; title: string }[] = []

  const seenOut = new Map<string, string>()

  for (const page of usable) {
    const lower = page.path.toLowerCase()
    const isMd = lower.endsWith(".md")

    let result: ConceptTransform
    if (!isMd) {
      result = { content: page.content, unresolvedLinks: [], warnings: [] }
    } else if (isReservedName(page.path)) {
      if (baseName(page.path).toLowerCase() === "index.md") {
        const isRoot = !page.path.includes("/")
        hasRootIndex ||= isRoot
        result = transformIndex(page, resolver, isRoot)
      } else {
        result = transformLog(page, resolver)
      }
    } else {
      conceptCount++
      result = transformConcept(page, resolver)
      const parsed = parseFrontmatter(page.content)
      conceptListing.push({
        path: page.path,
        title:
          (typeof parsed.frontmatter?.title === "string" && parsed.frontmatter.title) ||
          baseName(stripMdExtension(page.path)),
      })
    }

    warnings.push(...result.warnings)
    if (result.unresolvedLinks.length > 0) {
      unresolvedByPage.push([page.path, result.unresolvedLinks])
    }

    const collisionKey = page.path.toLowerCase()
    const prior = seenOut.get(collisionKey)
    if (prior !== undefined && prior !== page.path) {
      warnings.push(`${page.path}: skipped; collides with ${prior} on case-insensitive filesystems`)
      continue
    }
    seenOut.set(collisionKey, page.path)
    files.push({ path: page.path, content: result.content })
  }

  if (!hasRootIndex) {
    files.unshift({ path: "index.md", content: synthesizeRootIndex(conceptListing) })
  }

  const unresolvedTotal = unresolvedByPage.reduce((n, [, list]) => n + list.length, 0)
  if (unresolvedTotal > 0) {
    const sample = unresolvedByPage
      .flatMap(([path, list]) => list.map((t) => `${t} (in ${path})`))
      .slice(0, 10)
      .join("; ")
    warnings.push(
      `${unresolvedTotal} wikilink(s) had no target page in the export and were kept as plain text: ${sample}${unresolvedTotal > 10 ? "; …" : ""}`,
    )
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, conceptCount, warnings }
}
