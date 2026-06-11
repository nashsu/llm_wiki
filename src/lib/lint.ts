import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig, EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import { computeContextBudget } from "@/lib/context-budget"
import { fetchEmbedding } from "@/lib/embedding"
import { clusterPairs, servicePost } from "@/lib/dedup-embed"

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic" | "suggested-link"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
  /** broken-link only: the unresolved wikilink text (the `[[X]]`). */
  brokenTarget?: string
  /** broken-link only: a suggested existing page (basename slug) to repoint to.
   *  When set, the fix rewrites `[[brokenTarget]]` → `[[suggestedTarget]]`. */
  suggestedTarget?: string
  /** orphan only: an existing page (shortPath) closely related to this orphan.
   *  When set, the fix adds `[[orphan]]` to that page's `## Related` section,
   *  giving the orphan a real inbound link the detector will count next run. */
  suggestedSource?: string
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

/**
 * Append `- [[linkText]]` to a page's body so a `suggested-link` becomes a real
 * cross-reference. Idempotent (no-op if the page already links `linkText`,
 * case-insensitive). Inserts under an existing `## Related` / `## See also`
 * heading if present, otherwise appends a new `## Related` section. `linkText`
 * is the target's basename, matching how the rest of the wiki writes wikilinks.
 */
export function addRelatedLink(content: string, linkText: string): string {
  const already = extractWikilinks(content).some(
    (l) => l.toLowerCase() === linkText.toLowerCase(),
  )
  if (already) return content

  const entry = `- [[${linkText}]]`
  const lines = content.split("\n")
  const headingIdx = lines.findIndex((l) => /^#{1,6}\s+(related|see also)\b/i.test(l.trim()))
  if (headingIdx >= 0) {
    let insertAt = headingIdx + 1
    if (lines[insertAt]?.trim() === "") insertAt++ // keep the blank line after the heading
    lines.splice(insertAt, 0, entry)
    return lines.join("\n")
  }
  return `${content.trimEnd()}\n\n## Related\n\n${entry}\n`
}

// ── Broken-link "did you mean?" matching ──────────────────────────────────────

/** Minimum normalized-edit-distance ratio to suggest a lexical repoint. */
const LEXICAL_MATCH_THRESHOLD = 0.8
/** A slug candidate for repoint matching. */
export interface SlugCandidate {
  /** Basename written into the wikilink, e.g. "foo-bar". */
  basename: string
  /** Wiki-relative path of the page, e.g. "entities/foo-bar.md". */
  shortPath: string
}

/** Collapse case/spacing/punctuation so "Foo Bar", "foo-bar", "foobar" compare equal. */
function normalizeSlugKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Iterative Levenshtein distance (small strings — slug-length only). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * Best lexical "did you mean" for a broken wikilink: the existing page whose
 * basename is closest to the broken text after normalization. Returns null if
 * nothing clears `LEXICAL_MATCH_THRESHOLD` (so we suggest nothing rather than a
 * wrong repoint). Exact-after-normalization (e.g. "Foo Bar" → "foo-bar") wins.
 */
export function bestLexicalSlug(
  brokenText: string,
  candidates: readonly SlugCandidate[],
): SlugCandidate | null {
  const q = normalizeSlugKey(brokenText)
  if (q.length < 3) return null
  let best: SlugCandidate | null = null
  let bestScore = 0
  for (const c of candidates) {
    const key = normalizeSlugKey(c.basename)
    if (!key) continue
    const score = key === q ? 1 : 1 - levenshtein(q, key) / Math.max(q.length, key.length)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return bestScore >= LEXICAL_MATCH_THRESHOLD ? best : null
}

/** "phandalin-town" / "phandalin town" → "Phandalin Town". */
function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

export interface StubPageSpec {
  /** Wiki-relative path to write, e.g. "entities/phandalin.md". */
  path: string
  content: string
}

/**
 * Build a minimal stub page for a broken wikilink so the link resolves. The
 * filename basename is the (sanitized) broken-link text — the linter resolves
 * `[[X]]` by basename, so this guarantees the link is no longer broken. The
 * stub is placed beside the page that referenced it and its `type` inferred
 * from that directory; a backlink to the source keeps the new page non-orphan.
 * Returns null if the broken text can't yield a usable filename.
 */
export function buildBrokenLinkStub(
  brokenTarget: string,
  sourceShortPath: string,
  today: string,
  typeOverride?: string,
): StubPageSpec | null {
  const safeName = brokenTarget.trim().replace(/[/\\:*?"<>|]/g, "-").trim()
  if (!safeName) return null
  const dir = sourceShortPath.includes("/") ? sourceShortPath.replace(/\/[^/]*$/, "") : ""
  const type = typeOverride?.trim() ? typeOverride.trim() : dir.endsWith("concepts") ? "concept" : "entity"
  const sourceSlug = sourceShortPath.replace(/\.md$/, "").split("/").pop() ?? sourceShortPath
  const title = titleCase(safeName)
  const path = dir ? `${dir}/${safeName}.md` : `${safeName}.md`
  const content = [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    `created: ${today}`,
    `updated: ${today}`,
    "tags: [stub]",
    "---",
    "",
    `# ${title}`,
    "",
    `> Stub created from a broken link in [[${sourceSlug}]]. Add content here.`,
    "",
  ].join("\n")
  return { path, content }
}

/** Distinct frontmatter `type:` values across the wiki, for the stub-type
 *  selector — so it reflects the wiki's real taxonomy (e.g. "location"), not a
 *  fixed enum. Sorted; empty on read failure. */
export async function loadWikiPageTypes(projectPath: string): Promise<string[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }
  const files = flattenMdFiles(tree).filter((f) => f.name !== "log.md" && f.name !== "index.md")
  const types = new Set<string>()
  for (const f of files) {
    try {
      const content = await readFile(f.path)
      const fm = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fm) continue
      const tm = fm[1].match(/^type:\s*["']?([A-Za-z0-9_-]+)/m)
      if (tm) types.add(tm[1].toLowerCase())
    } catch {
      // skip unreadable files
    }
  }
  return [...types].sort()
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

  // Candidate pages for broken-link "did you mean?" matching.
  const linkTargets: SlugCandidate[] = pages.map((p) => ({
    basename: p.slug.split("/").pop() ?? p.slug,
    shortPath: getRelativePath(p.path, wikiRoot),
  }))

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
        const match = bestLexicalSlug(link, linkTargets)
        results.push({
          type: "broken-link",
          severity: "warning",
          page: shortName,
          detail: match
            ? `Broken link: [[${link}]] — did you mean [[${match.basename}]]?`
            : `Broken link: [[${link}]] — target page not found.`,
          brokenTarget: link,
          suggestedTarget: match?.basename,
          affectedPages: match ? [match.shortPath] : undefined,
        })
      }
    }
  }

  return results
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

/**
 * How the semantic linter copes with wikis too large to fit in one prompt.
 *
 *  - "batch"   — chunk the page previews into context-safe batches and run
 *                one LLM call per batch. Full coverage, but a contradiction
 *                whose two pages land in different batches won't be seen.
 *  - "cluster" — embed every page, group topically-related ones via the
 *                turbovecdb service, and lint each cluster as one batch, so
 *                cross-page issues survive even on big wikis. Pages with no
 *                related neighbour are still swept in "batch" fashion so the
 *                run never silently skips a page.
 *
 * Both modes cap output (`max_tokens`) and cap input (char budget derived from
 * the model's context window) — without that cap the single-prompt scan packed
 * every page into one request and overflowed the context (HTTP 400, "you
 * requested 0 output tokens and your prompt contains 131073 input tokens").
 */
export type SemanticLintMode = "batch" | "cluster"

export interface SemanticLintOptions {
  /** Defaults to "batch". "cluster" additionally needs `embeddingConfig` +
   *  `serviceUrl`; if either is missing or the embedding/cluster step fails,
   *  the run falls back to "batch" rather than returning nothing. */
  mode?: SemanticLintMode
  embeddingConfig?: EmbeddingConfig
  /** turbovecdb-service base URL for "cluster" mode, e.g. http://127.0.0.1:8077 */
  serviceUrl?: string
  signal?: AbortSignal
}

interface LintPage {
  /** Wiki-relative path, e.g. "entities/foo.md". */
  shortPath: string
  /** First slice of the page, used both for the prompt and for embedding. */
  preview: string
}

const PAGE_PREVIEW_CHARS = 500
/** Output cap for a semantic batch. Bounds a runaway/thinking model AND
 *  guarantees the server has room to reply — the missing cap is exactly what
 *  produced the "0 output tokens" 400 on large wikis. */
const SEMANTIC_MAX_OUTPUT_TOKENS = 4096
/** Coarse chars→tokens factor for sizing `max_tokens` from the char reserve. */
const CHARS_PER_TOKEN = 4
/** Char reserve for the fixed instruction scaffold (format spec + directives). */
const INSTRUCTION_RESERVE_CHARS = 4_000
/** Cosine-distance ceiling for "related" pages in cluster mode. Deliberately
 *  looser than dedup's τ: semantic lint WANTS topically-adjacent pages grouped
 *  (that's where contradictions live), not just near-duplicates. */
const CLUSTER_THRESHOLD = 0.2
const CLUSTER_K = 8
const EMBED_CONCURRENCY = 8
const BATCH_CONCURRENCY = 3

/** The fixed instruction scaffold + the page block, assembled into one prompt. */
function buildSemanticPrompt(pages: LintPage[]): string {
  const rendered = pages.map((p) => `### ${p.shortPath}\n${p.preview}`)
  // For auto-mode language detection, sample the concatenated previews so
  // non-English wikis get a matching language directive.
  const summarySample = rendered.join("\n").slice(0, 2000)
  return [
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
    rendered.join("\n\n"),
  ].join("\n")
}

function parseLintBlocks(raw: string): LintResult[] {
  const results: LintResult[] = []
  for (const match of raw.matchAll(LINT_BLOCK_REGEX)) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

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
  return results
}

/** Run one bounded LLM call over a single batch of pages. Throws on stream
 *  error so the caller can record it and carry on with the other batches. */
async function lintBatch(
  pages: LintPage[],
  llmConfig: LlmConfig,
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
): Promise<LintResult[]> {
  if (pages.length === 0) return []
  const prompt = buildSemanticPrompt(pages)
  let raw = ""
  let streamError: Error | null = null
  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => { streamError = err },
    },
    signal,
    { temperature: 0.1, max_tokens: maxOutputTokens },
  )
  if (streamError) throw streamError
  return parseLintBlocks(raw)
}

/** Greedily pack pages into batches whose total preview size stays under
 *  `budget` characters. A single page never exceeds `budget` (previews are
 *  capped at PAGE_PREVIEW_CHARS), so no page is ever dropped. */
function packByChars(pages: LintPage[], budget: number): LintPage[][] {
  const batches: LintPage[][] = []
  let cur: LintPage[] = []
  let curChars = 0
  for (const p of pages) {
    const cost = p.shortPath.length + p.preview.length + 8
    if (cur.length && curChars + cost > budget) {
      batches.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(p)
    curChars += cost
  }
  if (cur.length) batches.push(cur)
  return batches
}

/** Embed a list of `{id, text}` entries with bounded concurrency, dropping any
 *  that fail to embed. Shared by cluster-lint and link-suggestion candidate-gen.
 *  `type`/`title` are filler so the items match the turbovecdb upsert schema. */
async function embedForService(
  entries: { id: string; text: string }[],
  cfg: EmbeddingConfig,
  signal: AbortSignal | undefined,
): Promise<{ id: string; vector: number[]; type: string; title: string }[]> {
  const items: { id: string; vector: number[]; type: string; title: string }[] = []
  let cursor = 0
  async function worker() {
    while (cursor < entries.length) {
      if (signal?.aborted) return
      const e = entries[cursor++]
      const vector = await fetchEmbedding(e.text, cfg)
      if (vector) items.push({ id: e.id, vector, type: "page", title: e.id })
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, entries.length) }, worker))
  return items
}

/**
 * Cluster mode: embed each page, group related ones via turbovecdb, and return
 * batches where each genuine cluster (≥2 related pages) is its own batch — so
 * the LLM sees contradicting/overlapping pages together. Singletons are swept
 * via `packByChars` so every page is still linted. A cluster larger than the
 * char budget is split (cross-page reasoning is preserved within each window).
 */
async function clusterIntoBatches(
  pages: LintPage[],
  embeddingConfig: EmbeddingConfig,
  serviceUrl: string,
  dbPath: string,
  charBudget: number,
  signal: AbortSignal | undefined,
  onProgress: (m: string) => void,
): Promise<LintPage[][]> {
  const byPath = new Map(pages.map((p) => [p.shortPath, p]))

  onProgress(`Embedding ${pages.length} pages…`)
  const items = await embedForService(
    pages.map((p) => ({ id: p.shortPath, text: `${p.shortPath}\n${p.preview}` })),
    embeddingConfig,
    signal,
  )
  if (items.length < 2) return packByChars(pages, charBudget)

  onProgress("Indexing embeddings…")
  await servicePost(serviceUrl, "/clear", { db_path: dbPath }, signal)
  await servicePost(serviceUrl, "/upsert", { db_path: dbPath, items }, signal)

  onProgress("Grouping related pages…")
  const { pairs } = await servicePost<{ pairs: { a: string; b: string }[] }>(
    serviceUrl,
    "/candidate_pairs",
    { db_path: dbPath, threshold: CLUSTER_THRESHOLD, k: CLUSTER_K },
    signal,
  )

  const batches: LintPage[][] = []
  const clustered = new Set<string>()
  for (const cluster of clusterPairs(pairs)) {
    const cp = cluster.map((id) => byPath.get(id)).filter((p): p is LintPage => !!p)
    cluster.forEach((id) => clustered.add(id))
    for (const b of packByChars(cp, charBudget)) batches.push(b)
  }
  const singles = pages.filter((p) => !clustered.has(p.shortPath))
  for (const b of packByChars(singles, charBudget)) batches.push(b)
  return batches
}

export async function runSemanticLint(
  projectPath: string,
  llmConfig: LlmConfig,
  options: SemanticLintOptions = {},
): Promise<LintResult[]> {
  const { mode = "batch", embeddingConfig, serviceUrl, signal } = options
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

  const wikiFiles = flattenMdFiles(tree).filter((f) => f.name !== "log.md")

  // Build a compact preview of each page (frontmatter + first 500 chars).
  const pages: LintPage[] = []
  for (const f of wikiFiles) {
    try {
      const content = await readFile(f.path)
      const preview = content.slice(0, PAGE_PREVIEW_CHARS) + (content.length > PAGE_PREVIEW_CHARS ? "..." : "")
      pages.push({ shortPath: getRelativePath(f.path, wikiRoot), preview })
    } catch {
      // skip unreadable files
    }
  }

  if (pages.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No wiki pages to lint." })
    return []
  }

  // Cap input (char budget from the model's context window) and output
  // (max_tokens). Both caps are what keep any single request inside context.
  const { maxCtx, responseReserve } = computeContextBudget(llmConfig.maxContextSize)
  const inputCharBudget = Math.max(8_000, maxCtx - responseReserve - INSTRUCTION_RESERVE_CHARS)
  const maxOutputTokens = Math.min(
    SEMANTIC_MAX_OUTPUT_TOKENS,
    Math.max(1024, Math.floor(responseReserve / CHARS_PER_TOKEN)),
  )

  let batches: LintPage[][]
  if (mode === "cluster" && embeddingConfig?.enabled && embeddingConfig.endpoint && serviceUrl) {
    try {
      batches = await clusterIntoBatches(
        pages,
        embeddingConfig,
        serviceUrl,
        `${pp}/.llm-wiki/turbovecdb-lint`,
        inputCharBudget,
        signal,
        (m) => activity.updateItem(activityId, { detail: m }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      activity.updateItem(activityId, { detail: `Cluster mode failed (${msg}); using batches…` })
      batches = packByChars(pages, inputCharBudget)
    }
  } else {
    batches = packByChars(pages, inputCharBudget)
  }

  activity.updateItem(activityId, {
    detail: `Running LLM semantic analysis (${batches.length} batch${batches.length === 1 ? "" : "es"})…`,
  })

  // Run batches with bounded concurrency; a failing batch is recorded but
  // doesn't abort the others.
  const all: LintResult[] = []
  let batchCursor = 0
  let completed = 0
  let failures = 0
  async function batchWorker() {
    while (batchCursor < batches.length) {
      if (signal?.aborted) return
      const i = batchCursor++
      try {
        all.push(...(await lintBatch(batches[i], llmConfig, maxOutputTokens, signal)))
      } catch {
        failures++
      }
      completed++
      activity.updateItem(activityId, { detail: `Analyzed ${completed}/${batches.length} batches…` })
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, batchWorker))

  // Every page lands in exactly one batch, so findings don't duplicate across
  // batches — no dedup needed.
  if (failures > 0 && all.length === 0) {
    activity.updateItem(activityId, { status: "error", detail: `All ${failures} batch(es) failed.` })
    return []
  }
  activity.updateItem(activityId, {
    status: "done",
    detail: failures > 0
      ? `Found ${all.length} semantic issue(s); ${failures} batch(es) failed.`
      : `Found ${all.length} semantic issue(s).`,
  })
  return all
}

// ── Link suggestions ──────────────────────────────────────────────────────────
//
// The inverse of broken-link/no-outlinks: instead of "this link is dead" or
// "this page links nowhere", surface "page A is closely related to existing
// page B and links to neither direction — consider connecting them". The signal
// is pure embedding similarity (nearest neighbours minus pages already linked);
// an optional LLM pass keeps only pairs where a link genuinely helps a reader.

/** Embedding-distance ceiling for a link suggestion. Tighter than cluster-lint's
 *  τ: a suggested link needs high confidence or it's noise. */
const LINK_SUGGEST_THRESHOLD = 0.12
const LINK_SUGGEST_K = 6
/** Output cap for the LLM confirm pass (a short keep/drop list per batch). */
const LINK_CONFIRM_MAX_OUTPUT_TOKENS = 2048
/** Max candidate pairs sent to one confirm call (each pair carries two previews;
 *  the char budget splits further if needed). */
const LINK_CONFIRM_PAIRS_PER_BATCH = 40

export type LinkSuggestMode = "fast" | "confirm"

export interface LinkSuggestOptions {
  /** "fast" (default) = embedding-only. "confirm" = embedding + an LLM pass that
   *  drops weak pairs and picks the link direction; requires `llmConfig`. */
  mode?: LinkSuggestMode
  llmConfig?: LlmConfig
  signal?: AbortSignal
}

interface LinkPage {
  /** turbovecdb id + display path, e.g. "entities/foo.md". */
  shortPath: string
  /** Lowercased wiki-relative slug ("entities/foo") for link comparison. */
  slug: string
  title: string
  preview: string
  /** Lowercased slugs this page already links to (resolved wikilinks). */
  linkedSlugs: Set<string>
}

/** Load every wiki page with its preview and the set of slugs it already links
 *  to (wikilinks resolved against the slug map, so case/basename variants count). */
async function loadPagesForLinks(projectPath: string): Promise<LinkPage[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }
  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md" && f.name !== "index.md",
  )
  const slugMap = buildSlugMap(wikiFiles, wikiRoot)
  const resolveToSlug = (link: string): string => {
    const path = slugMap.get(link.toLowerCase())
    return path
      ? relativeToSlug(getRelativePath(path, wikiRoot)).toLowerCase()
      : link.toLowerCase()
  }

  const pages: LinkPage[] = []
  for (const f of wikiFiles) {
    try {
      const content = await readFile(f.path)
      const shortPath = getRelativePath(f.path, wikiRoot)
      const slug = relativeToSlug(shortPath).toLowerCase()
      const linkedSlugs = new Set(extractWikilinks(content).map(resolveToSlug))
      const preview = content.slice(0, PAGE_PREVIEW_CHARS) + (content.length > PAGE_PREVIEW_CHARS ? "..." : "")
      pages.push({ shortPath, slug, title: shortPath, preview, linkedSlugs })
    } catch {
      // skip unreadable files
    }
  }
  return pages
}

/** A directed missing-link candidate: `from` should perhaps link to `to`. */
interface LinkCandidate {
  from: LinkPage
  to: LinkPage
}

const LINK_BLOCK_REGEX =
  /---LINK:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINK---/g

/** Build the LLM confirm prompt for a batch of candidate pairs. */
function buildLinkConfirmPrompt(batch: LinkCandidate[]): string {
  const blocks = batch.map((c, i) => {
    return [
      `## Pair ${i + 1}`,
      `SOURCE: ${c.from.shortPath}`,
      c.from.preview,
      `TARGET: ${c.to.shortPath}`,
      c.to.preview,
    ].join("\n")
  })
  const sample = blocks.join("\n").slice(0, 2000)
  return [
    "You help curate a wiki's cross-references. Each pair below is two topically-similar pages where SOURCE does not currently link to TARGET.",
    "",
    buildLanguageDirective(sample),
    "",
    "For each pair, decide whether a reader of SOURCE would genuinely benefit from a [[link]] to TARGET. Be strict — only keep pairs where the link is clearly useful, not merely same-category.",
    "",
    "For each pair you KEEP, output exactly this block (omit pairs you reject):",
    "",
    "---LINK: source/path.md | target/path.md | confidence---",
    "One short sentence on why the link helps.",
    "---END LINK---",
    "",
    "confidence is high | medium | low. Use the exact SOURCE and TARGET paths from the pair. Output ONLY ---LINK--- blocks, nothing else. If no pair warrants a link, output nothing.",
    "",
    "## Candidate pairs",
    "",
    blocks.join("\n\n"),
  ].join("\n")
}

/** Run the LLM confirm pass over candidate pairs, returning only kept ones as
 *  suggestion results. Tolerates per-batch stream errors (skips that batch). */
async function confirmLinkCandidates(
  candidates: LinkCandidate[],
  llmConfig: LlmConfig,
  signal: AbortSignal | undefined,
  onProgress: (m: string) => void,
): Promise<LintResult[]> {
  const { responseReserve, maxCtx } = computeContextBudget(llmConfig.maxContextSize)
  const charBudget = Math.max(8_000, maxCtx - responseReserve - INSTRUCTION_RESERVE_CHARS)
  const maxOutputTokens = Math.min(
    LINK_CONFIRM_MAX_OUTPUT_TOKENS,
    Math.max(512, Math.floor(responseReserve / CHARS_PER_TOKEN)),
  )

  // Pack candidates into batches bounded by both pair-count and chars.
  const batches: LinkCandidate[][] = []
  let cur: LinkCandidate[] = []
  let curChars = 0
  for (const c of candidates) {
    const cost = c.from.preview.length + c.to.preview.length + c.from.shortPath.length + c.to.shortPath.length + 32
    if (cur.length && (cur.length >= LINK_CONFIRM_PAIRS_PER_BATCH || curChars + cost > charBudget)) {
      batches.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(c)
    curChars += cost
  }
  if (cur.length) batches.push(cur)

  // Index candidates so we can validate the model's source/target against the
  // real pairs and recover the target title for the detail line.
  const byPair = new Map(candidates.map((c) => [`${c.from.shortPath} ${c.to.shortPath}`, c]))

  const out: LintResult[] = []
  let cursor = 0
  let completed = 0
  async function worker() {
    while (cursor < batches.length) {
      if (signal?.aborted) return
      const i = cursor++
      const prompt = buildLinkConfirmPrompt(batches[i])
      let raw = ""
      let streamError: Error | null = null
      await streamChat(
        llmConfig,
        [{ role: "user", content: prompt }],
        {
          onToken: (t) => { raw += t },
          onDone: () => {},
          onError: (err) => { streamError = err },
        },
        signal,
        { temperature: 0.1, max_tokens: maxOutputTokens },
      )
      completed++
      onProgress(`Confirming links (${completed}/${batches.length} batches)…`)
      if (streamError) continue
      for (const m of raw.matchAll(LINK_BLOCK_REGEX)) {
        const source = m[1].trim()
        const target = m[2].trim()
        const confidence = m[3].trim().toLowerCase()
        const reason = m[4].trim()
        const match = byPair.get(`${source} ${target}`)
        if (!match) continue // model invented or swapped a pair → drop
        out.push({
          type: "suggested-link",
          severity: "info",
          page: source,
          affectedPages: [target],
          detail: `Suggested link → ${match.to.title}${reason ? `: ${reason}` : "."}${confidence === "low" ? " (low confidence)" : ""}`,
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, worker))
  return out
}

/**
 * Suggest cross-links: pages that are closely related (by embedding) but where
 * neither links the other. "fast" mode emits those pairs directly; "confirm"
 * mode runs a bounded LLM pass to keep only the genuinely-useful ones.
 *
 * Safe by the pipeline rule: every suggestion is reviewed before it edits a
 * file (Fix → Review queue), so the LLM/embedding output is a first draft, not
 * an autonomous scope decision.
 */
export async function runLinkSuggestions(
  projectPath: string,
  embeddingConfig: EmbeddingConfig,
  serviceUrl: string,
  options: LinkSuggestOptions = {},
): Promise<LintResult[]> {
  const { mode = "fast", llmConfig, signal } = options
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Link suggestions",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  if (!embeddingConfig?.enabled || !embeddingConfig.endpoint || !serviceUrl) {
    activity.updateItem(activityId, { status: "error", detail: "Link suggestions need an embedding endpoint." })
    return []
  }

  const pages = await loadPagesForLinks(pp)
  if (pages.length < 2) {
    activity.updateItem(activityId, { status: "done", detail: "Not enough pages to suggest links." })
    return []
  }
  const byId = new Map(pages.map((p) => [p.shortPath, p]))

  let pairs: { a: string; b: string }[]
  try {
    activity.updateItem(activityId, { detail: `Embedding ${pages.length} pages…` })
    const items = await embedForService(
      pages.map((p) => ({ id: p.shortPath, text: `${p.shortPath}\n${p.preview}` })),
      embeddingConfig,
      signal,
    )
    if (items.length < 2) {
      activity.updateItem(activityId, { status: "done", detail: "Not enough pages embedded to suggest links." })
      return []
    }
    const dbPath = `${pp}/.llm-wiki/turbovecdb-links`
    activity.updateItem(activityId, { detail: "Indexing embeddings…" })
    await servicePost(serviceUrl, "/clear", { db_path: dbPath }, signal)
    await servicePost(serviceUrl, "/upsert", { db_path: dbPath, items }, signal)
    activity.updateItem(activityId, { detail: "Finding related pages…" })
    const res = await servicePost<{ pairs: { a: string; b: string }[] }>(
      serviceUrl,
      "/candidate_pairs",
      { db_path: dbPath, threshold: LINK_SUGGEST_THRESHOLD, k: LINK_SUGGEST_K },
      signal,
    )
    pairs = res.pairs
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    activity.updateItem(activityId, { status: "error", detail: `Embedding/index step failed: ${msg}` })
    return []
  }

  // A pair is a suggestion only when NEITHER page links the other — the
  // strongest "these belong together but are disconnected" signal. One card per
  // pair (source = the first id), keyed to avoid duplicates.
  const candidates: LinkCandidate[] = []
  const seen = new Set<string>()
  for (const { a, b } of pairs) {
    const pa = byId.get(a)
    const pb = byId.get(b)
    if (!pa || !pb) continue
    if (pa.linkedSlugs.has(pb.slug) || pb.linkedSlugs.has(pa.slug)) continue
    const key = [pa.shortPath, pb.shortPath].sort().join(" ")
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ from: pa, to: pb })
  }

  if (candidates.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No missing links found." })
    return []
  }

  let results: LintResult[]
  if (mode === "confirm" && llmConfig) {
    activity.updateItem(activityId, { detail: `Confirming ${candidates.length} candidate link(s)…` })
    results = await confirmLinkCandidates(candidates, llmConfig, signal, (m) =>
      activity.updateItem(activityId, { detail: m }),
    )
  } else {
    results = candidates.map((c) => ({
      type: "suggested-link",
      severity: "info",
      page: c.from.shortPath,
      affectedPages: [c.to.shortPath],
      detail: `Closely related to ${c.to.title} but neither page links the other — consider adding a [[link]].`,
    }))
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `Suggested ${results.length} link(s).`,
  })
  return results
}

// ── Broken-link embedding fallback ────────────────────────────────────────────

/** Minimum cosine similarity for a semantic broken-link match. Strict, because
 *  repointing to the wrong page is worse than leaving the link broken. */
const BROKEN_LINK_EMBED_MIN_SIM = 0.6

function cosineSim(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Embedding fallback for broken links the lexical pass couldn't match (synonyms,
 * abbreviations). Embeds every page once, then for each unresolved broken target
 * embeds the broken text and picks the nearest page by cosine similarity (in
 * memory — turbovecdb has no arbitrary-vector query endpoint). Mutates and
 * returns `results`; only broken-link items with `brokenTarget` and no
 * `suggestedTarget` are touched, and only when embeddings are configured.
 *
 * Cost: embeds all pages, so it only does work when there ARE unresolved broken
 * links — callers should gate it behind an embedding opt-in.
 */
export async function resolveBrokenLinksByEmbedding(
  projectPath: string,
  results: LintResult[],
  embeddingConfig: EmbeddingConfig,
  signal?: AbortSignal,
  onProgress?: (m: string) => void,
): Promise<LintResult[]> {
  const unresolved = results.filter(
    (r) => r.type === "broken-link" && r.brokenTarget && !r.suggestedTarget,
  )
  if (unresolved.length === 0 || !embeddingConfig?.enabled || !embeddingConfig.endpoint) {
    return results
  }

  const pages = await loadPagesForLinks(normalizePath(projectPath))
  if (pages.length === 0) return results

  onProgress?.(`Embedding ${pages.length} pages for broken-link matching…`)
  const vecs = await embedForService(
    pages.map((p) => ({ id: p.shortPath, text: `${p.shortPath}\n${p.preview}` })),
    embeddingConfig,
    signal,
  )
  if (vecs.length === 0) return results

  // Cache by broken text so repeated identical broken links embed once.
  const cache = new Map<string, string | null>()
  for (const r of unresolved) {
    if (signal?.aborted) break
    const text = r.brokenTarget!
    let matchedPath = cache.get(text)
    if (matchedPath === undefined) {
      const qv = await fetchEmbedding(text, embeddingConfig)
      if (!qv) {
        matchedPath = null
      } else {
        let best: { id: string; sim: number } | null = null
        for (const v of vecs) {
          const sim = cosineSim(qv, v.vector)
          if (!best || sim > best.sim) best = { id: v.id, sim }
        }
        matchedPath = best && best.sim >= BROKEN_LINK_EMBED_MIN_SIM ? best.id : null
      }
      cache.set(text, matchedPath)
    }
    if (matchedPath) {
      const basename = matchedPath.replace(/\.md$/, "").split("/").pop() ?? matchedPath
      r.suggestedTarget = basename
      r.affectedPages = [matchedPath]
      r.detail = `Broken link: [[${text}]] — did you mean [[${basename}]]? (semantic match)`
    }
  }
  return results
}

// ── No-outlinks forward-link suggestion ──────────────────────────────────────

/** Minimum cosine similarity for a no-outlinks → target suggestion. Same bar
 *  as orphan backlinks — we'd rather leave it manual than suggest an unrelated
 *  page. */
const NO_OUTLINKS_EMBED_MIN_SIM = 0.5

/**
 * For each page with no outbound wikilinks, find the existing page most closely
 * related by embedding and attach it as `affectedPages[0]`. The fix then adds
 * `[[target]]` to that page's `## Related` section with one click.
 *
 * Mutates and returns `results`; only no-outlinks items without an existing
 * `affectedPages` are touched, and only when embeddings are configured.
 */
export async function resolveNoOutlinksByEmbedding(
  projectPath: string,
  results: LintResult[],
  embeddingConfig: EmbeddingConfig,
  signal?: AbortSignal,
  onProgress?: (m: string) => void,
): Promise<LintResult[]> {
  const noOutlinks = results.filter((r) => r.type === "no-outlinks" && !r.affectedPages?.length)
  if (noOutlinks.length === 0 || !embeddingConfig?.enabled || !embeddingConfig.endpoint) {
    return results
  }

  const pages = await loadPagesForLinks(normalizePath(projectPath))
  if (pages.length < 2) return results

  onProgress?.(`Embedding ${pages.length} pages for link suggestions…`)
  const vecs = await embedForService(
    pages.map((p) => ({ id: p.shortPath, text: `${p.shortPath}\n${p.preview}` })),
    embeddingConfig,
    signal,
  )
  if (vecs.length < 2) return results

  for (const o of noOutlinks) {
    if (signal?.aborted) break
    const self = vecs.find((v) => v.id === o.page)
    if (!self) continue
    let best: { id: string; sim: number } | null = null
    for (const v of vecs) {
      if (v.id === o.page) continue
      const sim = cosineSim(self.vector, v.vector)
      if (!best || sim > best.sim) best = { id: v.id, sim }
    }
    if (best && best.sim >= NO_OUTLINKS_EMBED_MIN_SIM) {
      const basename = best.id.replace(/\.md$/, "").split("/").pop() ?? best.id
      o.affectedPages = [best.id]
      o.detail = `No outbound links — [[${basename}]] is closely related; consider adding a link.`
    }
  }
  return results
}

// ── Orphan backlink suggestion ────────────────────────────────────────────────

/** Minimum cosine similarity for an orphan→source suggestion. An orphan with no
 *  neighbour this close is genuinely standalone; we'd rather leave it unlinked
 *  than wire it to an unrelated page. */
const ORPHAN_EMBED_MIN_SIM = 0.5

/**
 * For each orphan ("no other pages link to this page"), find the existing page
 * most closely related by embedding and attach it as `suggestedSource`. The
 * orphan's Fix then adds `[[orphan]]` to that page's `## Related` section — a
 * real body wikilink the orphan detector counts, so the orphan resolves on the
 * next scan (unlike the old index.md dump, which the detector ignores).
 *
 * Reuses the page set's own vectors: an orphan is itself a wiki page, so its
 * embedding is already in the batch — no extra per-orphan embed call. Mutates
 * and returns `results`; only orphans without a `suggestedSource` are touched,
 * and only when embeddings are configured.
 */
export async function resolveOrphansByEmbedding(
  projectPath: string,
  results: LintResult[],
  embeddingConfig: EmbeddingConfig,
  signal?: AbortSignal,
  onProgress?: (m: string) => void,
): Promise<LintResult[]> {
  const orphans = results.filter((r) => r.type === "orphan" && !r.suggestedSource)
  if (orphans.length === 0 || !embeddingConfig?.enabled || !embeddingConfig.endpoint) {
    return results
  }

  const pages = await loadPagesForLinks(normalizePath(projectPath))
  if (pages.length < 2) return results

  onProgress?.(`Embedding ${pages.length} pages for orphan backlinks…`)
  const vecs = await embedForService(
    pages.map((p) => ({ id: p.shortPath, text: `${p.shortPath}\n${p.preview}` })),
    embeddingConfig,
    signal,
  )
  if (vecs.length < 2) return results

  for (const o of orphans) {
    if (signal?.aborted) break
    const self = vecs.find((v) => v.id === o.page)
    if (!self) continue
    let best: { id: string; sim: number } | null = null
    for (const v of vecs) {
      if (v.id === o.page) continue
      const sim = cosineSim(self.vector, v.vector)
      if (!best || sim > best.sim) best = { id: v.id, sim }
    }
    if (best && best.sim >= ORPHAN_EMBED_MIN_SIM) {
      const basename = best.id.replace(/\.md$/, "").split("/").pop() ?? best.id
      o.suggestedSource = best.id
      o.detail = `No page links here yet — [[${basename}]] is closely related; add a backlink from it.`
    }
  }
  return results
}
