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
 * HTTP goes through the Tauri plugin (`src/lib/tauri-fetch.ts`) so
 * CORS-unfriendly endpoints work the same as the LLM path.
 */

import { readFile, listDirectory } from "@/commands/fs"
import { invoke } from "@tauri-apps/api/core"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { getHttpFetch, isFetchNetworkError } from "@/lib/tauri-fetch"
import { chunkMarkdown, type Chunk } from "@/lib/text-chunker"
import { isLocalOrPrivateHttpEndpoint, localLlmOriginHeader } from "@/lib/llm-providers"

const RESERVED_EMBEDDING_HEADER_NAMES = new Set([
  "authorization",
  "content-type",
  "host",
  "content-length",
  "origin",
  "x-goog-api-key",
])
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function isSafeExtraHeader(name: string, value: string): boolean {
  const trimmedName = name.trim()
  const trimmedValue = value.trim()
  return (
    trimmedName.length > 0 &&
    trimmedValue.length > 0 &&
    HTTP_HEADER_NAME_RE.test(trimmedName) &&
    !RESERVED_EMBEDDING_HEADER_NAMES.has(trimmedName.toLowerCase())
  )
}

// ── Error surfacing ──────────────────────────────────────────────────────

/**
 * Most recent embedding failure description, so Settings → Embedding
 * can show the user WHY vector search fell back to BM25 instead of
 * silently dropping to keyword match. Cleared on any successful
 * embed.
 */
let lastEmbeddingError: string | null = null
const INCREMENTAL_OPTIMIZE_PAGE_THRESHOLD = 20
const incrementalOptimizeCounts = new Map<string, number>()

export function getLastEmbeddingError(): string | null {
  return lastEmbeddingError
}

export function resetEmbeddingOptimizeAccountingForTests(): void {
  incrementalOptimizeCounts.clear()
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

  const isGoogleNative = isGoogleEmbeddingConfig(cfg)
  const isDoubaoMultimodal = isDoubaoMultimodalEmbeddingConfig(cfg)
  const endpoint = isGoogleNative
    ? googleEmbeddingEndpoint(cfg)
    : volcengineEmbeddingEndpoint(cfg)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(isLocalOrPrivateHttpEndpoint(endpoint) ? localLlmOriginHeader() : {}),
  }
  if (cfg.apiKey) {
    if (isGoogleNative) {
      headers["x-goog-api-key"] = cfg.apiKey
    } else {
      headers.Authorization = `Bearer ${cfg.apiKey}`
    }
  }
  if (cfg.extraHeaders) {
    for (const [k, v] of Object.entries(cfg.extraHeaders)) {
      const name = k.trim()
      const value = v.trim()
      if (!isSafeExtraHeader(name, value)) continue
      headers[name] = value
    }
  }

  let current = text
  let attempts = 0
  while (attempts <= maxRetries) {
    attempts++
    try {
      const httpFetch = await getHttpFetch()
      const resp = await httpFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(
          isGoogleNative
            ? googleEmbeddingBody(cfg.model, current, cfg.outputDimensionality)
            : isDoubaoMultimodal
              ? doubaoMultimodalEmbeddingBody(cfg.model, current)
              : { model: cfg.model, input: current },
        ),
      })

      if (resp.ok) {
        const data = await resp.json()
        const embedding = isGoogleNative
          ? data?.embedding?.values ?? null
          : isDoubaoMultimodal
            ? data?.data?.embedding ?? null
            : data?.data?.[0]?.embedding ?? null
        if (isNonEmptyNumberArray(embedding)) {
          lastEmbeddingError = null
          return embedding
        }
        const expectedShape = isGoogleNative
          ? "embedding.values"
          : isDoubaoMultimodal
            ? "data.embedding"
            : "data[0].embedding"
        lastEmbeddingError = `Embedding response missing ${expectedShape} (got ${JSON.stringify(data).slice(0, 200)})`
        console.warn(`[Embedding] ${lastEmbeddingError}`)
        return null
      }

      // Non-OK: try to read the body for an oversize hint.
      let bodyText = ""
      try {
        bodyText = await resp.text()
      } catch {
        // ignore — some servers return empty bodies on error
      }

      if (looksLikeOversizeError(resp.status, bodyText)) {
        // Can we still halve-and-retry? Need room on both axes:
        // text not yet at the 64-char floor, and retry budget left.
        if (current.length > 64 && attempts <= maxRetries) {
          const prev = current.length
          current = current.slice(0, Math.floor(current.length / 2))
          console.warn(
            `[Embedding] auto-halving after HTTP ${resp.status} at ${prev} chars → retrying at ${current.length} chars (attempt ${attempts}/${maxRetries + 1})`,
          )
          continue
        }
        // Out of retries on a SERVER-oversize error — give the user a
        // message that names the smallest size that still failed so
        // they can tune Settings → Embedding accordingly.
        lastEmbeddingError = `Endpoint rejected input even at ${current.length} chars — server context smaller than expected. Lower Settings → Embedding → Max Chunk Chars (${bodyText.slice(0, 160)}).`
        console.warn(`[Embedding] ${lastEmbeddingError}`)
        return null
      }

      // Non-oversize definitive failure (auth, rate limit, server down, …).
      lastEmbeddingError = `API ${resp.status} ${resp.statusText}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ""} at ${endpoint}`
      console.warn(`[Embedding] ${lastEmbeddingError}`)
      return null
    } catch (err) {
      if (isFetchNetworkError(err)) {
        lastEmbeddingError = `Network error reaching ${endpoint}. Check endpoint URL, API key, and connectivity.`
      } else {
        lastEmbeddingError = err instanceof Error ? err.message : String(err)
      }
      console.warn(`[Embedding] ${lastEmbeddingError}`)
      return null
    }
  }

  // Exhausted retries (only reachable if every halving round triggered
  // the retry branch and then the loop condition ended).
  lastEmbeddingError = `Embedding endpoint rejected every size down to ${current.length} chars — the server's context is smaller than ${current.length * 2}. Lower Settings → Embedding → Max Chunk Chars.`
  console.warn(`[Embedding] ${lastEmbeddingError}`)
  return null
}

function isNonEmptyNumberArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item))
}

function isGoogleEmbeddingConfig(cfg: EmbeddingConfig): boolean {
  const endpoint = cfg.endpoint.toLowerCase()
  return endpoint.includes("generativelanguage.googleapis.com")
    || /:embedcontent(\?|$)/i.test(endpoint)
}

function isVolcengineEmbeddingEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return host === "volces.com"
      || host.endsWith(".volces.com")
      || host.includes("volcengine")
  } catch {
    const authority = endpoint
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      .toLowerCase()
    return authority === "volces.com"
      || authority.endsWith(".volces.com")
      || authority.includes("volcengine")
  }
}

function isDoubaoMultimodalEmbeddingConfig(cfg: EmbeddingConfig): boolean {
  return cfg.model.trim().toLowerCase().includes("doubao-embedding-vision")
}

function volcengineEmbeddingEndpoint(cfg: EmbeddingConfig): string {
  const raw = cfg.endpoint.trim()
  if (!isVolcengineEmbeddingEndpoint(raw)) return raw
  const targetSuffix = isDoubaoMultimodalEmbeddingConfig(cfg)
    ? "/embeddings/multimodal"
    : "/embeddings"
  return appendEndpointPath(raw, targetSuffix)
}

function appendEndpointPath(endpoint: string, targetSuffix: string): string {
  const suffix = targetSuffix.replace(/^\/+/, "")
  try {
    const url = new URL(endpoint)
    const path = url.pathname.replace(/\/+$/, "")
    const lowerPath = path.toLowerCase()
    const lowerSuffix = `/${suffix.toLowerCase()}`
    if (lowerPath.endsWith(lowerSuffix)) {
      url.pathname = path || "/"
      return url.toString()
    }
    if (lowerPath.endsWith("/embeddings/multimodal") && lowerSuffix === "/embeddings") {
      url.pathname = path.slice(0, -"/multimodal".length) || "/"
      return url.toString()
    }
    if (lowerPath.endsWith("/embeddings") && lowerSuffix === "/embeddings/multimodal") {
      url.pathname = `${path}/multimodal`
      return url.toString()
    }
    url.pathname = `${path}/${suffix}`.replace(/\/{2,}/g, "/")
    return url.toString()
  } catch {
    const [base, query = ""] = endpoint.split("?", 2)
    const trimmed = base.replace(/\/+$/, "")
    const lower = trimmed.toLowerCase()
    const lowerSuffix = `/${suffix.toLowerCase()}`
    const next = lower.endsWith(lowerSuffix)
      ? trimmed
      : lower.endsWith("/embeddings/multimodal") && lowerSuffix === "/embeddings"
        ? trimmed.slice(0, -"/multimodal".length)
      : lower.endsWith("/embeddings") && lowerSuffix === "/embeddings/multimodal"
        ? `${trimmed}/multimodal`
        : `${trimmed}/${suffix}`
    return query ? `${next}?${query}` : next
  }
}

function googleEmbeddingEndpoint(cfg: EmbeddingConfig): string {
  const raw = stripGoogleApiKeyQuery(cfg.endpoint.trim()).replace(/\/+$/, "")
  if (/:batchEmbedContents(\?|$)/i.test(raw)) {
    return raw.replace(/:batchEmbedContents/i, ":embedContent")
  }
  if (/:embedContent(\?|$)/i.test(raw)) return raw

  const modelPath = googleModelPath(cfg.model)
  if (/\/models\/[^/?]+$/i.test(raw)) {
    return `${raw}:embedContent`
  }
  return `${raw}/models/${encodeURIComponent(modelPath.replace(/^models\//, ""))}:embedContent`
}

function stripGoogleApiKeyQuery(endpoint: string): string {
  if (!endpoint.includes("?")) return endpoint
  try {
    const url = new URL(endpoint)
    url.searchParams.delete("key")
    return url.toString()
  } catch {
    return endpoint.replace(/([?&])key=[^&]*&?/i, (_, prefix: string) => prefix === "?" ? "?" : "&")
      .replace(/[?&]$/, "")
      .replace("?&", "?")
  }
}

function googleModelPath(model: string): string {
  const trimmed = model.trim()
  if (trimmed.startsWith("models/")) return trimmed
  return `models/${trimmed}`
}

function googleEmbeddingBody(
  model: string,
  text: string,
  outputDimensionality?: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: googleModelPath(model),
    content: {
      parts: [{ text }],
    },
  }
  if (typeof outputDimensionality === "number" && Number.isFinite(outputDimensionality) && outputDimensionality > 0) {
    body.output_dimensionality = Math.floor(outputDimensionality)
  }
  return body
}

function doubaoMultimodalEmbeddingBody(model: string, text: string): Record<string, unknown> {
  return {
    model,
    encoding_format: "float",
    input: [{ type: "text", text }],
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

function extractEmbeddingTitle(content: string, fallbackId: string): string {
  const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  return titleMatch ? titleMatch[1].trim() : fallbackId
}

async function preparePageEmbeddingRows(
  pageId: string,
  title: string,
  content: string,
  cfg: EmbeddingConfig,
): Promise<PageEmbeddingPreparation> {
  if (!cfg.enabled || !cfg.model) return { status: "empty" }

  const chunks = chunkMarkdown(content, {
    targetChars: cfg.maxChunkChars ?? 1000,
    overlapChars: cfg.overlapChunkChars ?? 200,
  })
  if (chunks.length === 0) return { status: "empty" }

  const rows: ChunkUpsertInput[] = []
  let failedChunks = 0
  for (const chunk of chunks) {
    const embedText = enrichChunkForEmbedding(title, chunk)
    const vec = await fetchEmbedding(embedText, cfg)
    if (vec) {
      rows.push({
        chunkIndex: chunk.index,
        chunkText: chunk.text,
        headingPath: chunk.headingPath,
        embedding: vec,
      })
    } else {
      failedChunks++
    }
  }

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

  let tree: FileNode[]
  try {
    tree = await listDirectory(`${pp}/wiki`)
  } catch {
    if (options?.clearExisting) {
      throw new Error("Could not read wiki tree; existing index was left unchanged.")
    }
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

  if (options?.clearExisting) {
    if (mdFiles.length === 0) {
      const existingChunks = await vectorCountChunks(pp).catch(() => 0)
      if (existingChunks > 0) {
        throw new Error(
          `Wiki tree returned no content pages, but ${existingChunks} chunks are currently indexed. Existing index was left unchanged.`,
        )
      }
      await clearChunkVectorTable(pp)
      await dropLegacyVectorTableBestEffort(pp)
      return 0
    }

    const preparedPages: PreparedPageEmbedding[] = []
    const failures: string[] = []
    let attempted = 0
    for (const file of mdFiles) {
      try {
        const content = await readFile(file.path)
        const title = extractEmbeddingTitle(content, file.id)
        const prepared = await preparePageEmbeddingRows(file.id, title, content, cfg)
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
      if (onProgress) onProgress(attempted, mdFiles.length)
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} of ${mdFiles.length} pages could not be embedded (${failures[0]}). Existing index was left unchanged.`,
      )
    }

    if (preparedPages.length === 0) {
      const existingChunks = await vectorCountChunks(pp).catch(() => 0)
      if (existingChunks > 0) {
        throw new Error(
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
        throw new Error(
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

    return written
  }

  let done = 0
  let indexed = 0
  for (const file of mdFiles) {
    try {
      const content = await readFile(file.path)
      const title = extractEmbeddingTitle(content, file.id)
      if (await embedPage(pp, file.id, title, content, cfg, { deferOptimization: true })) {
        indexed++
      }
    } catch {
      // skip — individual file failure doesn't halt the batch
    }
    done++
    if (onProgress) onProgress(done, mdFiles.length)
  }

  if (indexed > 0) {
    await optimizeChunkVectorTableBestEffort(pp)
  }

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
