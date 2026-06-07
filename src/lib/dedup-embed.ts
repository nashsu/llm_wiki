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
 * Pipeline: load entity/concept pages → keep the rich ones (substantive prose) →
 * embed each once → upsert to the service → candidate pairs (cosine ≤ τ) →
 * union-find into clusters → run the existing detector on bounded batches of
 * clusters → DuplicateGroup[] (identical shape the Maintenance UI already
 * consumes). Stub / placeholder pages are deliberately excluded — they carry no
 * content to embed and collapse to identical vectors (see
 * scripts/dedup_prototype/FINDINGS.md, F2/F3); a separate lexical lane handles them.
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

// ── I/O orchestration ─────────────────────────────────────────────────────

/** Walk wiki/entities + wiki/concepts; return rich-page records to embed. */
export async function loadRichPageRecords(projectPath: string): Promise<RichPageRecord[]> {
  const pages = await loadAllWikiPages(projectPath)
  const out: RichPageRecord[] = []
  for (const { path, content } of pages) {
    if (!path.startsWith("wiki/entities/") && !path.startsWith("wiki/concepts/")) continue
    const summary = extractEntitySummary(path, content)
    if (!summary) continue
    const { body } = parseFrontmatter(content)
    const prose = extractProse(body ?? "")
    if (!isRichProse(prose)) continue
    out.push({ summary, embedText: buildEmbedText(summary.type, summary.title, summary.tags, prose) })
  }
  return out
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

async function servicePost<T>(serviceUrl: string, route: string, body: unknown, signal?: AbortSignal): Promise<T> {
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
  const { serviceUrl, threshold = 0.15, k = 6, signal, onProgress } = options
  const pp = normalizePath(projectPath)
  const dbPath = `${pp}/.llm-wiki/turbovecdb`

  onProgress?.("Loading rich pages…")
  const records = await loadRichPageRecords(pp)
  if (records.length < 2) return []

  onProgress?.(`Embedding ${records.length} rich pages…`)
  const items = await embedRecords(records, embeddingConfig, onProgress)
  if (items.length < 2) return []
  if (signal?.aborted) return []

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
  if (clusters.length === 0) return []

  // Map paths → summaries for the detector, then confirm in bounded batches.
  const summaryByPath = new Map(records.map((r) => [r.summary.path, r.summary]))
  const notDup = await loadNotDuplicates(pp)
  const llm = buildConfirmLlmCall(llmConfig)
  const batches = packClusters(clusters)

  // Each batch is one LLM call (thinking off, output capped → bounded). Run
  // them with limited concurrency so total wall-clock ≈ one batch, not the sum.
  const groups: DuplicateGroup[] = []
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
        const found = await detectDuplicateGroups(summaries, llm, { signal, notDuplicates: notDup })
        groups.push(...found)
      }
      completed++
      onProgress?.(`Confirming candidates (${completed}/${batches.length} batches)…`)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONFIRM_CONCURRENCY, batches.length) }, confirmWorker),
  )
  return groups
}
