import fs from "node:fs"
import path from "node:path"
import { getDb, isVecAvailable } from "../store/db.js"

// SQLite-backed vector store (issue #14 gap). Replaces the former
// vectorstore.json file store: chunk embeddings live in a sqlite-vec vec0
// virtual table (cosine distance) in the server database, keyed by a stable
// project id. Same invoke contract and score transform as before —
// score = 1 / (1 + distance) — so RRF blending downstream is unchanged.
//
// Graceful degradation: on platforms where the sqlite-vec extension cannot
// load (no prebuilt binary), writes no-op with a warning and searches return
// empty results; callers fall back to keyword retrieval. Requests never fail.
//
// The vec0 table is created lazily (not in a numbered migration) because its
// embedding column type — FLOAT[dim] — depends on the configured embedding
// provider's dimensionality. If the provider changes dimension, the table is
// dropped and recreated; embeddings are regenerated on the next ingest.

const fwd = (p) => p.split(path.sep).join("/")

// ── project identity ──────────────────────────────────────────────────────
// Stable project key: the UUID persisted in .llm-wiki/project.json, falling
// back to the normalized path for directories that lack one. Cached per path.
const projectKeyCache = new Map()
function projectKey(projectPath) {
  const key0 = fwd(projectPath)
  const cached = projectKeyCache.get(key0)
  if (cached !== undefined) return cached
  let key = key0
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "project.json"), "utf-8"))
    if (meta && typeof meta.id === "string" && meta.id.length > 0) key = meta.id
  } catch { /* no project.json → path key */ }
  projectKeyCache.set(key0, key)
  return key
}

function validatePageId(pageId) {
  if (!pageId || typeof pageId !== "string" || pageId.length > 256) {
    throw new Error("Invalid page_id: empty or too long")
  }
  if (/[\x00-\x1f]/.test(pageId) || /[/\\'"]/.test(pageId)) {
    throw new Error(`Invalid page_id: contains disallowed character: ${pageId}`)
  }
}

function validateVector(v) {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error("Invalid embedding: expected non-empty array of finite numbers")
  }
}

// ── vec0 table management ─────────────────────────────────────────────────
let vecTableDim = 0 // dim the live vec_chunks table was created for (0 = none)

function vecTableExists(db) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_chunks'`).get()
}

/**
 * Ensure the vec0 table exists for the given embedding dimension. Drops and
 * recreates it when the dimension changes (provider switch). Returns false
 * when sqlite-vec is unavailable.
 */
function ensureVecTable(dim) {
  if (!isVecAvailable()) return false
  if (vecTableDim === dim) return true
  const db = getDb()
  const meta = db.prepare(`SELECT dim FROM vec_meta WHERE id = 1`).get()
  if (meta && meta.dim === dim && vecTableExists(db)) {
    vecTableDim = dim
    return true
  }
  db.exec(`DROP TABLE IF EXISTS vec_chunks`)
  db.exec(`
    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY,
      project_id TEXT,
      page_id TEXT,
      chunk_index INTEGER,
      chunk_text TEXT,
      heading_path TEXT,
      embedding FLOAT[${dim}] distance_metric=cosine
    )
  `)
  db.prepare(`
    INSERT INTO vec_meta (id, dim, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET dim = excluded.dim, updated_at = excluded.updated_at
  `).run(dim, Date.now())
  vecTableDim = dim
  return true
}

let degradedWarned = false
function warnDegraded(op) {
  if (degradedWarned) return
  degradedWarned = true
  console.warn(`[vectorstore] sqlite-vec unavailable — ${op} skipped; keyword-only retrieval`)
}

// ── chunk-level vector commands (v2) ──────────────────────────────────────
async function vectorUpsertChunks({ projectPath, pageId, chunks }) {
  validatePageId(pageId)
  if (!chunks || chunks.length === 0) return
  if (!isVecAvailable()) { warnDegraded("vector_upsert_chunks"); return }
  const dim = chunks[0].embedding?.length
  if (!dim) throw new Error("Invalid embedding: expected non-empty array of finite numbers")
  for (const c of chunks) validateVector(c.embedding)
  if (!chunks.every((c) => c.embedding.length === dim)) {
    throw new Error(`Inconsistent embedding dimensions in one upsert (expected ${dim})`)
  }
  if (!ensureVecTable(dim)) return
  const db = getDb()
  const pid = projectKey(projectPath)
  const del = db.prepare(`DELETE FROM vec_chunks WHERE project_id = ? AND page_id = ?`)
  // CAST: better-sqlite3 binds JS numbers as REAL; vec0 metadata columns are
  // strict about storage class, so chunk_index must be coerced to INTEGER.
  const ins = db.prepare(`
    INSERT INTO vec_chunks (chunk_id, project_id, page_id, chunk_index, chunk_text, heading_path, embedding)
    VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    del.run(pid, pageId)
    for (const c of chunks) {
      ins.run(
        // PK is project-scoped: the table is shared across projects, while the
        // legacy JSON store was per-project (so "pageId#idx" was unique there).
        `${pid}:${pageId}#${c.chunk_index}`,
        pid,
        pageId,
        c.chunk_index,
        c.chunk_text ?? "",
        c.heading_path ?? "",
        JSON.stringify(c.embedding),
      )
    }
  })
  tx()
}

async function vectorSearchChunks({ projectPath, queryEmbedding, topK = 10 }) {
  if (!isVecAvailable()) return []
  validateVector(queryEmbedding)
  const db = getDb()
  if (!vecTableExists(db)) return []
  const meta = db.prepare(`SELECT dim FROM vec_meta WHERE id = 1`).get()
  // Query embedded by a different provider than the stored chunks: no
  // meaningful comparison — return nothing rather than garbage ranks.
  if (!meta || meta.dim !== queryEmbedding.length) return []
  const rows = db.prepare(`
    SELECT page_id || '#' || chunk_index AS chunk_id,
           page_id, chunk_index, chunk_text, heading_path, distance
    FROM vec_chunks
    WHERE embedding MATCH ? AND project_id = ?
    ORDER BY distance
    LIMIT ?
  `).all(JSON.stringify(queryEmbedding), projectKey(projectPath), Math.max(1, topK))
  return rows.map((r) => ({
    chunk_id: r.chunk_id,
    page_id: r.page_id,
    chunk_index: r.chunk_index,
    chunk_text: r.chunk_text,
    heading_path: r.heading_path,
    score: 1 / (1 + r.distance),
  }))
}

async function vectorDeletePage({ projectPath, pageId }) {
  validatePageId(pageId)
  if (!isVecAvailable()) return
  const db = getDb()
  if (!vecTableExists(db)) return
  db.prepare(`DELETE FROM vec_chunks WHERE project_id = ? AND page_id = ?`)
    .run(projectKey(projectPath), pageId)
}

async function vectorCountChunks({ projectPath }) {
  if (!isVecAvailable()) return 0
  const db = getDb()
  if (!vecTableExists(db)) return 0
  return db.prepare(`SELECT COUNT(*) AS n FROM vec_chunks WHERE project_id = ?`)
    .get(projectKey(projectPath)).n
}

async function vectorClearChunks({ projectPath }) {
  if (!isVecAvailable()) return
  const db = getDb()
  if (!vecTableExists(db)) return
  db.prepare(`DELETE FROM vec_chunks WHERE project_id = ?`).run(projectKey(projectPath))
}

// No-ops kept for contract parity with the desktop (LanceDB housekeeping and
// legacy-store notice in settings).
async function vectorOptimizeChunks() { return null }
async function vectorLegacyRowCount() { return 0 }
async function vectorDropLegacy() { return null }

export const vectorCommands = {
  vector_upsert_chunks: vectorUpsertChunks,
  vector_search_chunks: vectorSearchChunks,
  vector_delete_page: vectorDeletePage,
  vector_count_chunks: vectorCountChunks,
  vector_clear_chunks: vectorClearChunks,
  vector_optimize_chunks: vectorOptimizeChunks,
  vector_legacy_row_count: vectorLegacyRowCount,
  vector_drop_legacy: vectorDropLegacy,
}
