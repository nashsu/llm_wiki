// Server port of the ingest-relevant slice of src/lib/embedding.ts
// (issue #14 P0): chunk → enrich → embed (batch with per-item fallback) →
// vector_upsert_chunks into the sqlite-vec vec0 table.
//
// Divergences from the desktop module, all intentional:
//  • transport: embeddingFetch/embeddingFetchBatch from commands/search.js
//    (plain fetch to the OpenAI-compatible /embeddings endpoint) instead of
//    the Rust embedding_fetch command
//  • no LanceDB optimize/legacy-table bookkeeping — vec0 needs neither
//  • no reindex-state store listeners (Settings re-index is a separate flow)
//
// Chunking, enrichment, batching, oversize retry semantics and the fround to
// float32 are preserved exactly so server-embedded rows match desktop rows.

import { chunkMarkdown } from "./text-chunker.js"
import { parseFrontmatter } from "./frontmatter.js"
import { embeddingFetch, embeddingFetchBatch } from "../commands/search.js"
import { vectorUpsertChunks, vectorDeletePage } from "../commands/vectorstore.js"

let lastEmbeddingError = null

export function getLastEmbeddingError() {
  return lastEmbeddingError
}

/** @internal test seam */
export function resetEmbeddingStateForTests() {
  lastEmbeddingError = null
}

async function fetchEmbedding(text, cfg, maxRetries = 3) {
  if (!cfg.endpoint) return null
  try {
    const vec = await embeddingFetch({ text, cfg, maxRetries })
    lastEmbeddingError = null
    return vec
  } catch (err) {
    lastEmbeddingError = err instanceof Error ? err.message : String(err)
    console.warn(`[Embedding] ${lastEmbeddingError}`)
    return null
  }
}

async function fetchBatchEmbeddings(texts, cfg) {
  if (texts.length === 0) return []
  try {
    const embeddings = await embeddingFetchBatch({ texts, cfg })
    if (embeddings.length !== texts.length) {
      throw new Error(`Embedding batch returned ${embeddings.length} vectors for ${texts.length} inputs`)
    }
    lastEmbeddingError = null
    return embeddings
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[Embedding] Batch request failed; retrying inputs individually: ${message}`)
    return null
  }
}

function supportsOpenAiCompatibleBatch(cfg) {
  const endpoint = cfg.endpoint.toLowerCase()
  const model = cfg.model.toLowerCase()
  return !endpoint.includes("generativelanguage.googleapis.com")
    && !endpoint.includes(":embedcontent")
    && !model.includes("doubao-embedding-vision")
}

function createAsyncLimiter(rawLimit) {
  const limit = Math.max(1, Math.min(32, Math.floor(rawLimit ?? 1)))
  let active = 0
  const waiters = []
  return async (task) => {
    if (active < limit) {
      active++
    } else {
      await new Promise((resolve) => waiters.push(resolve))
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

function enrichChunkForEmbedding(pageTitle, chunk) {
  const parts = []
  if (pageTitle.trim().length > 0) parts.push(pageTitle.trim())
  if (chunk.headingPath.trim().length > 0) parts.push(chunk.headingPath.trim())
  parts.push(chunk.text.trim())
  return parts.join("\n\n")
}

export function extractEmbeddingTitle(content, fallbackId) {
  const title = parseFrontmatter(content).frontmatter?.title
  return typeof title === "string" && title.trim() ? title.trim() : fallbackId
}

async function preparePageEmbeddingRows(pageId, title, content, cfg, schedule = createAsyncLimiter(cfg.concurrency)) {
  if (!cfg.enabled || !cfg.model) return { status: "empty" }

  const chunks = chunkMarkdown(content, {
    targetChars: cfg.maxChunkChars ?? 1000,
    overlapChars: cfg.overlapChunkChars ?? 200,
  })
  if (chunks.length === 0) return { status: "empty" }

  const batchSize = Math.max(1, Math.min(64, Math.floor(cfg.batchSize ?? 1)))
  const tasks = []
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
    page: { pageId, rows, chunkCount: chunks.length, failedChunks },
  }
}

/**
 * Embed a wiki page: chunk → per-chunk embed → replace the page's vectors
 * in the vec0 table in one transaction. Every transient failure leaves the
 * existing rows intact (empty upsert is a no-op store-side). Called by the
 * ingest pipeline after writing a page to disk. Desktop call-signature
 * parity: embedPage(projectPath, pageId, title, content, cfg) → boolean.
 */
export async function embedPage(projectPath, pageId, title, content, cfg) {
  if (!cfg) return false
  const t0 = Date.now()
  const prepared = await preparePageEmbeddingRows(pageId, title, content, cfg)

  if (prepared.status !== "ready") {
    if (prepared.status === "failed") {
      console.log(
        `[Embedding] Indexed nothing for "${pageId}" — no chunks could be embedded: ${prepared.reason}`,
      )
    }
    return false
  }

  await vectorUpsertChunks({
    projectPath,
    pageId,
    chunks: prepared.page.rows.map((c) => ({
      chunk_index: c.chunkIndex,
      chunk_text: c.chunkText,
      heading_path: c.headingPath,
      // float32 parity with the desktop client (LanceDB FLOAT columns);
      // keeps server- and client-written rows numerically identical.
      embedding: c.embedding.map((v) => Math.fround(v)),
    })),
  })
  const elapsed = Date.now() - t0
  console.log(
    `[Embedding] Indexed "${pageId}": ${prepared.page.rows.length}/${prepared.page.chunkCount} chunks (${prepared.page.failedChunks} skipped) in ${elapsed}ms`,
  )
  return true
}

/** Remove a page's embeddings (source-delete flow). Non-critical. */
export async function removePageEmbedding(projectPath, pageId) {
  try {
    await vectorDeletePage({ projectPath, pageId })
  } catch {
    // non-critical
  }
}
