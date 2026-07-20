/**
 * Embedding pipeline — standard RAG flow.
 *
 *   1. chunkMarkdown(content)        (src/lib/text-chunker.ts)
 *   2. for each chunk:
 *        fetchEmbedding(title + heading_path + chunk_text)
 *        with auto-halve retry on "input too long" errors
 *   3. vector_upsert_chunks(page_id, [{chunk_index, chunk_text,
 *      heading_path, embedding}, …])
 *
 * Search:
 *   1. fetchEmbedding(query)
 *   2. vector_search_chunks(query_emb, topK × 3)
 *   3. group by page_id, max-pool primary score + weighted tail sum
 *   4. return top-K pages, outer API-compatible with the old per-page
 *      `{id, score}[]` shape; matched chunks available on the
 *      optional `matchedChunks` field for future UI surfacing.
 *
 * Provider HTTP is executed by the Rust `embedding_fetch` command so
 * CORS-unfriendly endpoints keep working while the core embedding
 * transport is shared by UI and backend callers.
 */

import { readFile, listDirectory } from "@/commands/fs"
import { invoke } from "@tauri-apps/api/core"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { chunkMarkdown, type Chunk } from "@/lib/text-chunker"
import { parseFrontmatter } from "@/lib/frontmatter"

// ── Error surfacing ──────────────────────────────────────────────────────

/**
 * Most recent embedding failure description, so Settings → Embedding
 * can show the user WHY vector search fell back to BM25 instead of
 * silently dropping to keyword match. Cleared on any successful
 * embed.
 */
let lastEmbeddingError: string | null = null
let embeddingFailureVersion = 0
const INCREMENTAL_OPTIMIZE_PAGE_THRESHOLD = 20
const incrementalOptimizeCounts = new Map<string, number>()

export function getLastEmbeddingError(): string | null {
  return lastEmbeddingError
}

export function resetEmbeddingOptimizeAccountingForTests(): void {
  incrementalOptimizeCounts.clear()
  embeddingFailureVersion = 0
  lastEmbeddingError = null
}

// ── fetchEmbedding with auto-halve retry ────────────────────────────────

/**
 * Heuristic: does this error response look like an "input too long /
 * exceeds model context / payload too large" rejection? True for all
 * the phrasings we've seen from OpenAI, LM Studio, llama.cpp,
 * Ollama, and Azure. Safer to over-match than under-match — a false
 * positive just means a retry at half size, which will still succeed
 * on a real auth/model-id error (it won't) or just log the same error.
 */
export function looksLikeOversizeError(httpStatus: number, body: string): boolean {
  if (httpStatus === 413) return true
  const lower = body.toLowerCase()
  return (
    lower.includes("too long") ||
    lower.includes("maximum context") ||
    lower.includes("max_tokens") ||
    lower.includes("max tokens") ||
    lower.includes("context length") ||
    lower.includes("token limit") ||
    lower.includes("exceeds") ||
    lower.includes("input length")
  )
}

/**
 * POST one embedding request; on an oversize rejection, halve the text
 * and retry up to `maxRetries` times. Returns null on definitive
 * failure (auth, network, dim mismatch, retries exhausted) with a
 * human-readable reason left in `lastEmbeddingError`.
 *
 * The returned vector represents the (possibly truncated) text that
 * actually got through. Chunker config should be tuned to minimise
 * truncation — this is a safety net, not the main line of defence.
 */
export async function fetchEmbedding(
  text: string,
  cfg: EmbeddingConfig,
  maxRetries = 3,
): Promise<number[] | null> {
  if (!cfg.endpoint) return null
  const failureVersionAtStart = embeddingFailureVersion
  try {
    const embedding = await invoke<number[]>("embedding_fetch", {
      text,
      cfg,
      maxRetries,
    })
    // Do not let a concurrent success erase an error that completed after
    // this request began. A later sequential success still clears it.
    if (embeddingFailureVersion === failureVersionAtStart) lastEmbeddingError = null
    return embedding
  } catch (err) {
    embeddingFailureVersion++
    lastEmbeddingError = err instanceof Error ? err.message : String(err)
    console.warn(`[Embedding] ${lastEmbeddingError}`)
    return null
  }
}

async function fetchBatchEmbeddings(
  texts: string[],
  cfg: EmbeddingConfig,
): Promise<number[][] | null> {
  if (texts.length === 0) return []
  const failureVersionAtStart = embeddingFailureVersion
  try {
    const embeddings = await invoke<number[][]>("embedding_fetch_batch", { texts, cfg })
    if (embeddings.length !== texts.length) {
      throw new Error(`Embedding batch returned ${embeddings.length} vectors for ${texts.length} inputs`)
    }
    if (embeddingFailureVersion === failureVersionAtStart) lastEmbeddingError = null
    return embeddings
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[Embedding] Batch request failed; retrying inputs individually: ${message}`)
    return null
  }
}

function supportsOpenAiCompatibleBatch(cfg: EmbeddingConfig): boolean {
  const endpoint = cfg.endpoint.toLowerCase()
  const model = cfg.model.toLowerCase()
  return !endpoint.includes("generativelanguage.googleapis.com")
    && !endpoint.includes(":embedcontent")
    && !model.includes("doubao-embedding-vision")
}

type AsyncLimiter = <T>(task: () => Promise<T>) => Promise<T>

function createAsyncLimiter(rawLimit: number | undefined): AsyncLimiter {
  const limit = Math.max(1, Math.min(32, Math.floor(rawLimit ?? 1)))
  let active = 0
  const waiters: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < limit) {
      active++
    } else {
      // A queued resolver owns the permit transferred by the completing task;
      // it must not increment active again when it resumes.
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    try {
      return await task()
    } finally {
      const next = waiters.shift()
      if (next) next()
      else active--
    }
  }
}

// ── LanceDB v2 operations (via Rust Tauri commands) ──────────────────────

interface ChunkUpsertInput {
  chunkIndex: number
  chunkText: string
  headingPath: string
  embedding: number[]
}

async function vectorUpsertChunks(
  projectPath: string,
  pageId: string,
  chunks: ChunkUpsertInput[],
): Promise<void> {
  await invoke("vector_upsert_chunks", {
    projectPath: normalizePath(projectPath),
    pageId,
    chunks: chunks.map((c) => ({
      chunk_index: c.chunkIndex,
      chunk_text: c.chunkText,
      heading_path: c.headingPath,
      embedding: c.embedding.map((v) => Math.fround(v)),
    })),
  })
}

interface ChunkSearchResult {
  chunk_id: string
  page_id: string
  chunk_index: number
  chunk_text: string
  heading_path: string
  score: number
}

async function vectorSearchChunks(
  projectPath: string,
  queryEmbedding: number[],
  topK: number,
): Promise<ChunkSearchResult[]> {
  return await invoke("vector_search_chunks", {
    projectPath: normalizePath(projectPath),
    queryEmbedding: queryEmbedding.map((v) => Math.fround(v)),
    topK,
  })
}

async function vectorDeletePage(projectPath: string, pageId: string): Promise<void> {
  await invoke("vector_delete_page", {
    projectPath: normalizePath(projectPath),
    pageId,
  })
}

async function vectorCountChunks(projectPath: string): Promise<number> {
  return await invoke("vector_count_chunks", {
    projectPath: normalizePath(projectPath),
  })
}

async function vectorClearChunks(projectPath: string): Promise<void> {
  await invoke("vector_clear_chunks", {
    projectPath: normalizePath(projectPath),
  })
}

async function vectorOptimizeChunks(projectPath: string): Promise<void> {
  await invoke("vector_optimize_chunks", {
    projectPath: normalizePath(projectPath),
  })
}

export async function legacyVectorRowCount(projectPath: string): Promise<number> {
  try {
    return await invoke("vector_legacy_row_count", {
      projectPath: normalizePath(projectPath),
    })
  } catch {
    return 0
  }
}

export async function dropLegacyVectorTable(projectPath: string): Promise<void> {
  await invoke("vector_drop_legacy", {
    projectPath: normalizePath(projectPath),
  })
}

export async function clearChunkVectorTable(projectPath: string): Promise<void> {
  await vectorClearChunks(projectPath)
}

async function optimizeChunkVectorTableBestEffort(projectPath: string): Promise<void> {
  try {
    await vectorOptimizeChunks(projectPath)
  } catch (err) {
    console.warn(
      `[Embedding] LanceDB chunk optimization failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

async function dropLegacyVectorTableBestEffort(projectPath: string): Promise<void> {
  try {
    await dropLegacyVectorTable(projectPath)
  } catch (err) {
    console.warn(
      `[Embedding] Legacy vector table cleanup failed: ${err instanceof Error ? err.message : err}`,
    )
  }
}

async function noteIncrementalVectorWrite(projectPath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  const count = (incrementalOptimizeCounts.get(pp) ?? 0) + 1
  if (count < INCREMENTAL_OPTIMIZE_PAGE_THRESHOLD) {
    incrementalOptimizeCounts.set(pp, count)
    return
  }
  incrementalOptimizeCounts.set(pp, 0)
  await optimizeChunkVectorTableBestEffort(pp)
}

// ── Chunk enrichment ─────────────────────────────────────────────────────

/**
 * Build the text we actually embed for a chunk: page title + heading
 * breadcrumb + chunk content. The breadcrumb is the most important
 * context for a short chunk — a 300-char excerpt about "Mixture of
 * Experts" is far more findable when the embedded text explicitly
 * names its containing sections.
 */
function enrichChunkForEmbedding(
  pageTitle: string,
  chunk: Chunk,
): string {
  const parts: string[] = []
  if (pageTitle.trim().length > 0) parts.push(pageTitle.trim())
  if (chunk.headingPath.trim().length > 0) parts.push(chunk.headingPath.trim())
  parts.push(chunk.text.trim())
  return parts.join("\n\n")
}

interface PreparedPageEmbedding {
  pageId: string
  rows: ChunkUpsertInput[]
  chunkCount: number
  failedChunks: number
}

type PageEmbeddingPreparation =
  | { status: "ready"; page: PreparedPageEmbedding }
  | { status: "empty" }
  | { status: "failed"; reason: string }

/** @internal Exported for unit tests only. */
export function extractEmbeddingTitle(content: string, fallbackId: string): string {
  const title = parseFrontmatter(content).frontmatter?.title
  return typeof title === "string" && title.trim() ? title.trim() : fallbackId
}

async function preparePageEmbeddingRows(
  pageId: string,
  title: string,
  content: string,
  cfg: EmbeddingConfig,
  schedule: AsyncLimiter = createAsyncLimiter(cfg.concurrency),
): Promise<PageEmbeddingPreparation> {
  if (!cfg.enabled || !cfg.model) return { status: "empty" }

  const chunks = chunkMarkdown(content, {
    targetChars: cfg.maxChunkChars ?? 1000,
    overlapChars: cfg.overlapChunkChars ?? 200,
  })
  if (chunks.length === 0) return { status: "empty" }

  const batchSize = Math.max(1, Math.min(64, Math.floor(cfg.batchSize ?? 1)))
  const tasks: Array<Promise<ChunkUpsertInput[]>> = []
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize)
    const texts = batch.map((chunk) => enrichChunkForEmbedding(title, chunk))
    tasks.push((async () => {
      const vectors = batch.length > 1 && supportsOpenAiCompatibleBatch(cfg)
        ? await schedule(() => fetchBatchEmbeddings(texts, cfg))
        : null
      const resolved = vectors ?? await Promise.all(
        texts.map((text) => schedule(() => fetchEmbedding(text, cfg))),
      )
      return resolved.flatMap((embedding, index) => {
        if (!embedding) return []
        const chunk = batch[index]
        return [{
          chunkIndex: chunk.index,
          chunkText: chunk.text,
          headingPath: chunk.headingPath,
          embedding,
        }]
      })
    })())
  }
  const rows = (await Promise.all(tasks)).flat()
  rows.sort((a, b) => a.chunkIndex - b.chunkIndex)
  const failedChunks = chunks.length - rows.length

  if (rows.length === 0) {
    return {
      status: "failed",
      reason: getLastEmbeddingError() || "all chunks failed to embed",
    }
  }
  return {
    status: "ready",
    page: {
      pageId,
      rows,
      chunkCount: chunks.length,
      failedChunks,
    },
  }
}

// ── Public API: embedPage / embedAllPages / searchByEmbedding ────────────

/**
 * Embed a wiki page: chunk → per-chunk embed → replace the page's
 * vectors in LanceDB in one batch. Every transient failure leaves the
 * existing v2 rows intact (empty upsert is a no-op Rust-side).
 *
 * Called by ingest.ts after writing a page to disk.
 */
export async function embedPage(
  projectPath: string,
  pageId: string,
  title: string,
  content: string,
  cfg: EmbeddingConfig,
  options?: { deferOptimization?: boolean },
): Promise<boolean> {
  const t0 = performance.now()
  const prepared = await preparePageEmbeddingRows(pageId, title, content, cfg)

  if (prepared.status !== "ready") {
    if (prepared.status === "failed") {
      console.log(
        `[Embedding] Indexed nothing for "${pageId}" — no chunks could be embedded. See getLastEmbeddingError().`,
      )
    }
    return false
  }

  await vectorUpsertChunks(projectPath, pageId, prepared.page.rows)
  if (!options?.deferOptimization) {
    await noteIncrementalVectorWrite(projectPath)
  }
  const elapsed = Math.round(performance.now() - t0)
  console.log(
    `[Embedding] Indexed "${pageId}": ${prepared.page.rows.length}/${prepared.page.chunkCount} chunks (${prepared.page.failedChunks} skipped) in ${elapsed}ms`,
  )
  return true
}

export type EmbeddingReindexState =
  | { kind: "idle" }
  | { kind: "running"; projectPath: string; done: number; total: number }
  | { kind: "done"; projectPath: string; count: number }
  | { kind: "error"; projectPath: string; message: string }

let embeddingReindexState: EmbeddingReindexState = { kind: "idle" }
const embeddingReindexListeners = new Set<() => void>()

export function getEmbeddingReindexState(): EmbeddingReindexState {
  return embeddingReindexState
}

export function subscribeEmbeddingReindexState(listener: () => void): () => void {
  embeddingReindexListeners.add(listener)
  return () => embeddingReindexListeners.delete(listener)
}

function setEmbeddingReindexState(state: EmbeddingReindexState): void {
  embeddingReindexState = state
  for (const listener of embeddingReindexListeners) listener()
}

function throwEmbeddingReindexError(projectPath: string, message: string): never {
  setEmbeddingReindexState({ kind: "error", projectPath, message })
  throw new Error(message)
}

async function parallelForEach<T>(
  items: T[],
  rawLimit: number | undefined,
  visit: (item: T) => Promise<void>,
): Promise<void> {
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.min(32, Math.floor(rawLimit ?? 1))),
  )
  let next = 0
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++
      await visit(items[index])
    }
  }))
}

async function preparePageEmbeddingRowsWithRetry(
  pageId: string,
  title: string,
  content: string,
  cfg: EmbeddingConfig,
  attempts = 3,
  schedule: AsyncLimiter = createAsyncLimiter(cfg.concurrency),
): Promise<PageEmbeddingPreparation> {
  let best = await preparePageEmbeddingRows(pageId, title, content, cfg, schedule)
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (best.status === "empty") return best
    if (best.status === "ready" && best.page.failedChunks === 0) return best
    await new Promise((resolve) => setTimeout(resolve, attempt * 250))
    const candidate = await preparePageEmbeddingRows(pageId, title, content, cfg, schedule)
    if (
      candidate.status === "ready"
      && (best.status !== "ready" || candidate.page.failedChunks < best.page.failedChunks)
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * Embed every wiki content page that isn't already indexed (or re-embed
 * all when `force === true`). Driven from Settings → Embedding or on
 * first enable. Skips structural pages (index / log / overview /
 * purpose / schema) — they're aggregate views, not retrieval targets.
 */
export async function embedAllPages(
  projectPath: string,
  cfg: EmbeddingConfig,
  onProgress?: (done: number, total: number) => void,
  options?: { clearExisting?: boolean },
): Promise<number> {
  if (!cfg.enabled || !cfg.model) return 0
  lastEmbeddingError = null

  const pp = normalizePath(projectPath)
  setEmbeddingReindexState({ kind: "running", projectPath: pp, done: 0, total: 0 })

  let tree: FileNode[]
  try {
    tree = await listDirectory(`${pp}/wiki`)
  } catch {
    if (options?.clearExisting) {
      const message = "Could not read wiki tree; existing index was left unchanged."
      setEmbeddingReindexState({ kind: "error", projectPath: pp, message })
      throw new Error(message)
    }
    setEmbeddingReindexState({ kind: "done", projectPath: pp, count: 0 })
    return 0
  }

  const mdFiles: { id: string; path: string }[] = []
  function walk(nodes: FileNode[]) {
    for (const node of nodes) {
      if (node.is_dir && node.children) {
        walk(node.children)
      } else if (!node.is_dir && node.name.endsWith(".md")) {
        const id = node.name.replace(/\.md$/, "")
        if (!["index", "log", "overview", "purpose", "schema"].includes(id)) {
          mdFiles.push({ id, path: node.path })
        }
      }
    }
  }
  walk(tree)
  const scheduleEmbedding = createAsyncLimiter(cfg.concurrency)
  // LanceDB page replacement is intentionally serialized. The configured
  // concurrency applies to outbound embedding HTTP, not database writers.
  const scheduleVectorWrite = createAsyncLimiter(1)

  if (options?.clearExisting) {
    if (mdFiles.length === 0) {
      const existingChunks = await vectorCountChunks(pp).catch(() => 0)
      if (existingChunks > 0) {
        throwEmbeddingReindexError(
          pp,
          `Wiki tree returned no content pages, but ${existingChunks} chunks are currently indexed. Existing index was left unchanged.`,
        )
      }
      await clearChunkVectorTable(pp)
      await dropLegacyVectorTableBestEffort(pp)
      setEmbeddingReindexState({ kind: "done", projectPath: pp, count: 0 })
      return 0
    }

    const preparedPages: PreparedPageEmbedding[] = []
    const failures: string[] = []
    let attempted = 0
    await parallelForEach(mdFiles, cfg.concurrency, async (file) => {
      try {
        const content = await readFile(file.path)
        const title = extractEmbeddingTitle(content, file.id)
        const prepared = await preparePageEmbeddingRowsWithRetry(
          file.id,
          title,
          content,
          cfg,
          3,
          scheduleEmbedding,
        )
        if (prepared.status === "ready") {
          if (prepared.page.failedChunks > 0) {
            const reason = getLastEmbeddingError()
            failures.push(
              `${file.id}: ${prepared.page.failedChunks} of ${prepared.page.chunkCount} chunks failed to embed${reason ? ` (${reason})` : ""}`,
            )
          } else {
            preparedPages.push(prepared.page)
          }
        } else if (prepared.status === "failed") {
          failures.push(`${file.id}: ${prepared.reason}`)
        }
      } catch (err) {
        failures.push(`${file.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      attempted++
      setEmbeddingReindexState({
        kind: "running",
        projectPath: pp,
        done: attempted,
        total: mdFiles.length,
      })
      if (onProgress) onProgress(attempted, mdFiles.length)
    })

    if (failures.length > 0) {
      let updated = 0
      for (const page of preparedPages) {
        try {
          await vectorUpsertChunks(pp, page.pageId, page.rows)
          updated++
        } catch (err) {
          failures.push(
            `${page.pageId}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      if (updated > 0) await optimizeChunkVectorTableBestEffort(pp)
      const error = `${failures.length} of ${mdFiles.length} pages could not be embedded (${failures[0]}). ${updated} successful page(s) were updated; failed pages kept their previous vectors and can be retried.`
      setEmbeddingReindexState({ kind: "error", projectPath: pp, message: error })
      throw new Error(error)
    }

    if (preparedPages.length === 0) {
      const existingChunks = await vectorCountChunks(pp).catch(() => 0)
      if (existingChunks > 0) {
        throwEmbeddingReindexError(
          pp,
          `Wiki tree has only empty content pages, but ${existingChunks} chunks are currently indexed. Existing index was left unchanged.`,
        )
      }
    }

    await clearChunkVectorTable(pp)

    let written = 0
    for (const page of preparedPages) {
      try {
        await vectorUpsertChunks(pp, page.pageId, page.rows)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throwEmbeddingReindexError(
          pp,
          `Rebuild write failed after clearing existing chunks (${page.pageId}: ${reason}). The rebuilt index may be incomplete; run re-index again after fixing the error.`,
        )
      }
      written++
      console.log(
        `[Embedding] Rebuilt "${page.pageId}": ${page.rows.length}/${page.chunkCount} chunks (${page.failedChunks} skipped)`,
      )
    }

    if (written > 0) {
      await optimizeChunkVectorTableBestEffort(pp)
    }
    // Forced rebuild succeeded, so the legacy v1 per-page table is obsolete
    // even when every readable content page was empty and no v2 rows were
    // written. Keep this outside the `written > 0` optimization guard.
    await dropLegacyVectorTableBestEffort(pp)

    setEmbeddingReindexState({ kind: "done", projectPath: pp, count: written })
    return written
  }

  let done = 0
  let indexed = 0
  await parallelForEach(mdFiles, cfg.concurrency, async (file) => {
    try {
      const content = await readFile(file.path)
      const title = extractEmbeddingTitle(content, file.id)
      const prepared = await preparePageEmbeddingRows(file.id, title, content, cfg, scheduleEmbedding)
      if (prepared.status === "ready") {
        await scheduleVectorWrite(() => vectorUpsertChunks(pp, file.id, prepared.page.rows))
        indexed++
      }
    } catch {
      // skip — individual file failure doesn't halt the batch
    }
    done++
    setEmbeddingReindexState({ kind: "running", projectPath: pp, done, total: mdFiles.length })
    if (onProgress) onProgress(done, mdFiles.length)
  })

  if (indexed > 0) {
    await optimizeChunkVectorTableBestEffort(pp)
  }

  setEmbeddingReindexState({ kind: "done", projectPath: pp, count: indexed })
  return indexed
}

/**
 * Vector search over the v2 chunk store, shaped to stay API-compatible
 * with the pre-0.3.11 per-page interface. Under the hood:
 *   1. Embed the query.
 *   2. Over-fetch top-K × 3 chunks.
 *   3. Group by page_id; score each page as max(chunk_scores) plus
 *      0.3 × sum of the other chunks' scores (bounded — capped at
 *      1.0 - max_score), so a page with two good chunks outranks a
 *      page with one equally-good chunk and a weaker one.
 *   4. Sort pages by score, return top-K.
 *
 * The optional `matchedChunks` field gives callers the raw chunk
 * context when they want to surface "matched in this section" in
 * the UI. Existing callers can ignore it.
 */
export interface PageSearchResult {
  id: string
  score: number
  matchedChunks?: Array<{ text: string; headingPath: string; score: number }>
}

export async function searchByEmbedding(
  projectPath: string,
  query: string,
  cfg: EmbeddingConfig,
  topK: number = 10,
): Promise<PageSearchResult[]> {
  if (!cfg.enabled || !cfg.model) return []

  const queryEmb = await fetchEmbedding(query, cfg)
  if (!queryEmb) return []

  const t0 = performance.now()
  let rawChunks: ChunkSearchResult[] = []
  try {
    rawChunks = await vectorSearchChunks(projectPath, queryEmb, Math.max(topK * 3, 30))
  } catch (err) {
    console.log(`[Embedding] LanceDB chunk search failed: ${err instanceof Error ? err.message : err}`)
    return []
  }
  if (rawChunks.length === 0) return []

  // Group by page; keep every matched chunk's score so we can compute
  // a blended per-page score.
  const byPage = new Map<string, ChunkSearchResult[]>()
  for (const c of rawChunks) {
    const bucket = byPage.get(c.page_id)
    if (bucket) bucket.push(c)
    else byPage.set(c.page_id, [c])
  }

  const ranked: PageSearchResult[] = []
  for (const [pageId, chunks] of byPage.entries()) {
    chunks.sort((a, b) => b.score - a.score)
    const top = chunks[0].score
    const tail = chunks.slice(1).reduce((sum, c) => sum + c.score, 0)
    // Cap the tail contribution so many-weak-chunks can't drown a
    // single-strong-chunk page. 0.3 weight is empirical; adjust later
    // with real data.
    const blended = top + Math.min(tail * 0.3, Math.max(0, 1 - top))
    ranked.push({
      id: pageId,
      score: blended,
      matchedChunks: chunks.slice(0, 3).map((c) => ({
        text: c.chunk_text,
        headingPath: c.heading_path,
        score: c.score,
      })),
    })
  }
  ranked.sort((a, b) => b.score - a.score)

  const elapsed = Math.round(performance.now() - t0)
  console.log(
    `[Embedding] LanceDB chunk search: ${rawChunks.length} chunks → ${ranked.length} pages in ${elapsed}ms`,
  )

  return ranked.slice(0, topK)
}

/**
 * Remove a page's embeddings from the v2 index. Called from the
 * source-delete flow so orphaned chunks don't pollute future searches.
 */
export async function removePageEmbedding(
  projectPath: string,
  pageId: string,
): Promise<void> {
  try {
    await vectorDeletePage(projectPath, pageId)
  } catch {
    // non-critical
  }
}

/**
 * Total chunks in the v2 index. Surfaces "N chunks indexed" status
 * in Settings.
 */
export async function getEmbeddingCount(projectPath: string): Promise<number> {
  try {
    return await vectorCountChunks(projectPath)
  } catch {
    return 0
  }
}
