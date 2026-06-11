/**
 * Embedding-based duplicate DETECTION for rich (substantive-prose) wiki pages.
 *
 * The original `runDuplicateDetection` (dedup-runner.ts) sends EVERY entity /
 * concept summary to the LLM in one prompt — which times out on large wikis
 * (~1000 pages → 30-min backstop → "request cancelled"). This module instead
 * uses a vector store (the turbovecdb HTTP service) to generate duplicate
 * CANDIDATES cheaply, then runs the SAME LLM detector (`detectDuplicateGroups`,
 * same prompt + parsing + notDuplicates whitelist) on the small candidate set.
 *
 * Three lanes (to control "chaff" — false groups from embedding similarity ≠
 * duplication; see scripts/dedup_prototype/FINDINGS.md):
 *   1. LEXICAL date-snapshot lane — date-suffixed pages (`X-YYYY-MM-DD`) grouped
 *      by stripped base slug. Exact; embeddings mis-cluster these templated stubs.
 *   2. EMBEDDING lane — substantive, non-dated pages: embed once → candidate pairs
 *      at a tight cosine threshold → union-find → bounded batches → the existing
 *      detector with a STRICT prompt (same-entity-only) → drop low-confidence.
 *   3. (excluded) empty/stub pages — no content to embed; left for a future
 *      lexical pass.
 * Output is DuplicateGroup[] — the shape the Maintenance UI + merge queue consume.
 */
import { getHttpFetch } from "./tauri-fetch"
import { fetchEmbedding } from "./embedding"
import { parseFrontmatter } from "./frontmatter"
import { normalizePath } from "./path-utils"
import { loadAllWikiPages } from "./dedup-runner"
import { streamChat } from "./llm-client"
import { detectDuplicateGroups, extractEntitySummary, type DedupLlmCall, type DuplicateGroup, type EntitySummary } from "./dedup"
import { loadNotDuplicates } from "./dedup-storage"
import type { LlmConfig, EmbeddingConfig } from "@/stores/wiki-store"

/** A rich page ready to embed: its EntitySummary (for the LLM detector) plus
 *  the text we actually embed (richer than the truncated summary description). */
export interface RichPageRecord {
  summary: EntitySummary
  embedText: string
}

export interface EmbeddingDedupOptions {
  /** turbovecdb-service base URL, e.g. http://127.0.0.1:8077 */
  serviceUrl: string
  /** Cosine-distance ceiling for a candidate pair (0 = identical). */
  threshold?: number
  /** Nearest neighbors fetched per page. */
  k?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

// ── Tuning knobs ──────────────────────────────────────────────────────────
/** Pages with less prose than this are "thin" → excluded from the embedding
 *  lane (they collapse to identical vectors under most embedding models). */
export const RICH_MIN_PROSE_CHARS = 200
/** Hard cap on pages fed to the LLM detector per call — keeps each confirm
 *  prompt (and its groups output) small regardless of wiki size, so we never
 *  recreate the timeout. */
export const MAX_DETECTOR_BATCH_PAGES = 60
/** Per-confirm output cap. The detector emits a bounded JSON groups list; a
 *  60-page batch is well under this. Caps a thinking/runaway model. */
const CONFIRM_MAX_TOKENS = 4096
/** Concurrency for embedding requests. */
const EMBED_CONCURRENCY = 8
/** Concurrency for the per-batch LLM confirm calls. */
const CONFIRM_CONCURRENCY = 4

/**
 * Stricter system prompt for the embedding lane's confirm step. Candidate pages
 * come from cosine similarity, which clusters *topically related* pages, not just
 * duplicates — so the default detector prompt (designed for soft dupes) emits a
 * lot of "medium: related dimensions of X" chaff. This prompt insists on
 * same-entity-different-name only. (Date-suffixed snapshots are handled by the
 * lexical lane and never reach here, so there's no "dated snapshot" example to
 * over-generalize from.)
 */
export const STRICT_CONFIRM_SYSTEM_PROMPT = `You are a wiki maintenance assistant deciding which pages are DUPLICATES that should be MERGED into one.

Group pages ONLY IF they describe the SAME specific entity or concept under a different name — merging them would lose no distinct subject. Good reasons to group: same name in two languages; plural vs singular; abbreviation vs full form; the same proper noun spelled differently; a page and a near-verbatim copy of it under a different slug.

Do NOT group pages that are merely:
- related, adjacent, or part of a common theme (e.g. "political-system" vs "political-structure");
- different facets or sub-topics of one subject (e.g. "arts" vs "literature");
- narratively connected but distinct things (e.g. "spy-channel" vs "coercion");
- different entities that happen to be empty/placeholder stubs.

When uncertain, DO NOT group — a false merge destroys information.

Output ONLY valid JSON, no prose or fences. Schema:
{ "groups": [ { "slugs": ["a", "b"], "reason": "...", "confidence": "high" } ] }
"high" = certainly the same thing, only the name differs. Use "medium"/"low" sparingly — prefer NOT grouping over a weak group. Only include slugs from the input. If none are duplicates, output {"groups": []}.`

// ── Pure helpers (unit-tested) ────────────────────────────────────────────

/**
 * Extract substantive prose from a page body: drop headings, tables,
 * blockquotes, and body-level metadata / bullet lines (`- **Status:** …`),
 * which are boilerplate that makes unrelated pages embed alike.
 */
export function extractProse(body: string): string {
  const keep: string[] = []
  for (const raw of body.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const c = line[0]
    if (c === "#" || c === "|" || c === ">" || c === "-" || c === "*") continue
    if (line.startsWith("---")) continue
    keep.push(line)
  }
  return keep.join(" ")
}

/** A page is "rich" if it has enough real prose and isn't a placeholder. */
export function isRichProse(prose: string): boolean {
  if (prose.length < RICH_MIN_PROSE_CHARS) return false
  if (/\(\s*content pending\s*\)/i.test(prose)) return false
  return true
}

/** Build the text we embed for a page — richer than the detector summary. */
export function buildEmbedText(type: string, title: string, tags: string[], prose: string): string {
  const tagPart = tags.length ? ` [${tags.join(", ")}]` : ""
  return `${type}: ${title}${tagPart} — ${prose.slice(0, 1200)}`
}

/** Union-find: turn candidate pairs into connected clusters of page paths. */
export function clusterPairs(pairs: { a: string; b: string }[]): string[][] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x)
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // path-compress
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const { a, b } of pairs) union(a, b)
  const groups = new Map<string, string[]>()
  for (const node of parent.keys()) {
    const r = find(node)
    const g = groups.get(r)
    if (g) g.push(node)
    else groups.set(r, [node])
  }
  return [...groups.values()].filter((g) => g.length >= 2)
}

/**
 * Greedily pack clusters into batches whose total page count stays within
 * `budget`, so each LLM detector call gets a bounded prompt. A single cluster
 * larger than the budget becomes its own (over-budget but intact) batch — we
 * never split a cluster, since the detector needs the whole candidate set to
 * judge it.
 */
export function packClusters(clusters: string[][], budget = MAX_DETECTOR_BATCH_PAGES): string[][] {
  const batches: string[][] = []
  let cur: string[] = []
  for (const cluster of clusters) {
    if (cur.length && cur.length + cluster.length > budget) {
      batches.push(cur)
      cur = []
    }
    cur.push(...cluster)
  }
  if (cur.length) batches.push(cur)
  return batches
}

/** Trailing `-YYYY-MM-DD` or `-YYYY-MM-DD-HHMMSS` snapshot suffix. */
const DATE_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}(?:-\d{6})?$/
export function isDateSuffixedSlug(slug: string): boolean {
  return DATE_SUFFIX_RE.test(slug)
}
export function baseSlug(slug: string): string {
  return slug.replace(DATE_SUFFIX_RE, "")
}

/**
 * Lexical lane for date-suffixed snapshot pages. Embeddings mis-cluster these
 * (templated session snapshots embed alike, so unrelated entities like
 * `wayside-inn-2026-05-27` and `whispering-woods-2026-05-27` look similar).
 * Grouping by stripped base slug instead is exact: a base page and its dated
 * snapshot(s) share a base name (same subject); unrelated stubs don't. Only
 * emits a group when ≥2 pages share a base AND at least one is date-suffixed.
 */
export function dateSnapshotGroups(slugs: string[]): DuplicateGroup[] {
  const byBase = new Map<string, string[]>()
  for (const s of slugs) {
    const base = baseSlug(s)
    const arr = byBase.get(base)
    if (arr) arr.push(s)
    else byBase.set(base, [s])
  }
  const groups: DuplicateGroup[] = []
  for (const members of byBase.values()) {
    // Dedupe basenames within a base (the same basename can appear under both
    // entities/ and concepts/ — F1; collapse to unique display slugs).
    const unique = [...new Set(members)].sort()
    if (unique.length < 2 || !unique.some(isDateSuffixedSlug)) continue
    groups.push({
      slugs: unique,
      reason: "Same page name plus a dated snapshot suffix — dated copies of one subject.",
      confidence: "high",
    })
  }
  return groups
}

/** Canonical key for a slug-set (lowercased, sorted) — matches the notDuplicates
 *  whitelist key used elsewhere, so confirmed false-positives stay suppressed. */
export function groupKey(slugs: string[]): string {
  return slugs.map((s) => s.toLowerCase()).sort().join(",")
}

// ── I/O orchestration ─────────────────────────────────────────────────────

/**
 * Walk wiki/entities + wiki/concepts once. Returns:
 *  - `rich`: substantive-prose, NON-date-suffixed records for the embedding lane.
 *  - `allSlugs`: every entity/concept slug (incl. empty + dated) for the lexical
 *    date-snapshot lane, which needs the full set to find base↔dated matches.
 * Date-suffixed pages are kept OUT of `rich` because they embed alike and form
 * cross-entity false clusters; the lexical lane handles them precisely.
 */
export async function loadEntityConceptPages(
  projectPath: string,
): Promise<{ rich: RichPageRecord[]; allSlugs: string[] }> {
  const pages = await loadAllWikiPages(projectPath)
  const rich: RichPageRecord[] = []
  const allSlugs: string[] = []
  for (const { path, content } of pages) {
    if (!path.startsWith("wiki/entities/") && !path.startsWith("wiki/concepts/")) continue
    const summary = extractEntitySummary(path, content)
    if (!summary) continue
    allSlugs.push(summary.slug)
    if (isDateSuffixedSlug(summary.slug)) continue // → lexical lane
    const { body } = parseFrontmatter(content)
    const prose = extractProse(body ?? "")
    if (!isRichProse(prose)) continue
    rich.push({ summary, embedText: buildEmbedText(summary.type, summary.title, summary.tags, prose) })
  }
  return { rich, allSlugs }
}

/** Embed records with bounded concurrency; drops any that fail to embed. */
async function embedRecords(
  records: RichPageRecord[],
  cfg: EmbeddingConfig,
  onProgress?: (m: string) => void,
): Promise<{ id: string; vector: number[]; type: string; title: string }[]> {
  const items: { id: string; vector: number[]; type: string; title: string }[] = []
  let done = 0
  let cursor = 0
  async function worker() {
    while (cursor < records.length) {
      const i = cursor++
      const r = records[i]
      const vector = await fetchEmbedding(r.embedText, cfg)
      done++
      if (done % 50 === 0) onProgress?.(`Embedded ${done}/${records.length} pages…`)
      if (vector) items.push({ id: r.summary.path, vector, type: r.summary.type, title: r.summary.title })
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, records.length) }, worker))
  return items
}

/**
 * LLM call for the per-batch confirm. Unlike the v0.4.21 dedup wrapper, this
 * DISABLES thinking and CAPS output — without that, a reasoning-capable model
 * (or one that doesn't cleanly stop) spends an unbounded amount of time on a
 * batch, recreating the original "request cancelled" hang. Mirrors what every
 * other structured caller in the app does. (The standalone hardening lives on
 * the fix-dedup-runaway-hardening branch; this is the local equivalent so the
 * embedding path is safe on its own.)
 */
function buildConfirmLlmCall(llmConfig: LlmConfig): DedupLlmCall {
  return async (systemPrompt, userMessage, signal) => {
    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (t) => {
            result += t
          },
          onDone: () => resolve(),
          onError: (err) => {
            streamError = err
            resolve()
          },
        },
        signal,
        { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: CONFIRM_MAX_TOKENS },
      ).catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

export async function servicePost<T>(serviceUrl: string, route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const httpFetch = await getHttpFetch()
  const resp = await httpFetch(`${serviceUrl.replace(/\/$/, "")}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "")
    throw new Error(`turbovecdb-service ${route} failed: HTTP ${resp.status} ${detail}`)
  }
  return (await resp.json()) as T
}

/**
 * Detect duplicate groups among rich pages using embedding candidate-generation
 * + the existing LLM detector. Returns the same DuplicateGroup[] shape the
 * Maintenance UI and merge queue already consume.
 */
export async function runEmbeddingDuplicateDetection(
  projectPath: string,
  llmConfig: LlmConfig,
  embeddingConfig: EmbeddingConfig,
  options: EmbeddingDedupOptions,
): Promise<DuplicateGroup[]> {
  // Default τ tightened from 0.15 → 0.10: thematic-but-distinct pages cluster at
  // ~0.08–0.15 cosine distance and become "related, not duplicate" chaff, while
  // genuine near-identical-content dups sit near 0. Tunable per wiki from the UI.
  const { serviceUrl, threshold = 0.1, k = 6, signal, onProgress } = options
  const pp = normalizePath(projectPath)
  const dbPath = `${pp}/.llm-wiki/turbovecdb`

  onProgress?.("Loading pages…")
  const { rich, allSlugs } = await loadEntityConceptPages(pp)
  const notDup = await loadNotDuplicates(pp)
  const notDupSet = new Set(notDup.map(groupKey))

  // Lane 1 — lexical: date-suffixed snapshot pages grouped by base slug (exact,
  // no LLM, no embeddings). Catches base↔dated dups without the cross-entity
  // chaff embeddings produce for these templated stubs.
  const lexicalGroups = dateSnapshotGroups(allSlugs).filter(
    (g) => !notDupSet.has(groupKey(g.slugs)),
  )

  if (rich.length < 2) return lexicalGroups

  // Lane 2 — embedding: substantive pages → candidate pairs → strict LLM confirm.
  onProgress?.(`Embedding ${rich.length} rich pages…`)
  const items = await embedRecords(rich, embeddingConfig, onProgress)
  if (items.length < 2 || signal?.aborted) return lexicalGroups

  // Rebuild the index from scratch each scan so deleted/edited pages don't
  // leave stale vectors. (Incremental upsert-by-content-hash is a later step.)
  onProgress?.("Indexing embeddings…")
  await servicePost(serviceUrl, "/clear", { db_path: dbPath }, signal)
  await servicePost(serviceUrl, "/upsert", { db_path: dbPath, items }, signal)

  onProgress?.("Finding candidate duplicates…")
  const { pairs } = await servicePost<{ pairs: { a: string; b: string }[] }>(
    serviceUrl,
    "/candidate_pairs",
    { db_path: dbPath, threshold, k },
    signal,
  )
  const clusters = clusterPairs(pairs)
  if (clusters.length === 0) return lexicalGroups

  // Map paths → summaries for the detector, then confirm in bounded batches with
  // the STRICT prompt (cuts "related-but-not-duplicate" chaff).
  const summaryByPath = new Map(rich.map((r) => [r.summary.path, r.summary]))
  const llm = buildConfirmLlmCall(llmConfig)
  const batches = packClusters(clusters)

  // Each batch is one LLM call (thinking off, output capped → bounded). Run
  // them with limited concurrency so total wall-clock ≈ one batch, not the sum.
  const embedGroups: DuplicateGroup[] = []
  let completed = 0
  let cursor = 0
  async function confirmWorker() {
    while (cursor < batches.length) {
      const i = cursor++
      if (signal?.aborted) return
      const summaries = batches[i]
        .map((path) => summaryByPath.get(path))
        .filter((s): s is EntitySummary => !!s)
      if (summaries.length >= 2) {
        const found = await detectDuplicateGroups(summaries, llm, {
          signal,
          notDuplicates: notDup,
          systemPrompt: STRICT_CONFIRM_SYSTEM_PROMPT,
        })
        embedGroups.push(...found)
      }
      completed++
      onProgress?.(`Confirming candidates (${completed}/${batches.length} batches)…`)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONFIRM_CONCURRENCY, batches.length) }, confirmWorker),
  )

  // Drop low-confidence embedding groups — that's where the residual chaff lands
  // (placeholder/loosely-related pages). Lexical date groups are always kept.
  const confirmed = embedGroups.filter((g) => g.confidence !== "low")

  // Dedup by normalized slug-set key. The LLM can output the same group twice
  // within one call, and slug-order variants of the same pair produce different
  // raw keys but represent the same merge candidate. Lexical groups take
  // precedence (they come first) since their reason text is more precise.
  const seen = new Set<string>()
  const result: DuplicateGroup[] = []
  for (const g of [...lexicalGroups, ...confirmed]) {
    const k = groupKey(g.slugs)
    if (!seen.has(k)) {
      seen.add(k)
      result.push(g)
    }
  }
  return result
}
