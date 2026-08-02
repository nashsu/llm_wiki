import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

// Node port of src-tauri/src/commands/vectorstore.rs (LanceDB-backed on the
// desktop). The web server persists vectors as JSON under
// <project>/.llm-wiki/vectorstore.json and ranks by cosine similarity, with
// the same score transform the desktop uses (1 / (1 + distance)). Because
// modern embedding models return unit vectors, cosine ranking is rank-equivalent
// to the desktop's L2 ranking, so hybrid RRF blending behaves the same.

const fwd = (p) => p.split(path.sep).join("/")
const storeFile = (projectPath) => path.join(projectPath, ".llm-wiki", "vectorstore.json")

const cache = new Map() // projectPath -> { v1:[], v2:[] }

function empty() { return { v1: [], v2: [] } }

function load(projectPath) {
  const key = fwd(projectPath)
  if (cache.has(key)) return cache.get(key)
  let data = empty()
  try { data = JSON.parse(fs.readFileSync(storeFile(projectPath), "utf-8")) } catch { data = empty() }
  if (!data || !Array.isArray(data.v1)) data.v1 = []
  if (!Array.isArray(data.v2)) data.v2 = []
  cache.set(key, data)
  return data
}

async function save(projectPath) {
  const key = fwd(projectPath)
  const data = cache.get(key) ?? empty()
  const file = storeFile(projectPath)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data), "utf-8")
  await fsp.rename(tmp, file)
}

function validatePageId(pageId) {
  if (!pageId || typeof pageId !== "string" || pageId.length > 256) {
    throw new Error("Invalid page_id: empty or too long")
  }
  if (/[\x00-\x1f]/.test(pageId) || /[/\\'"]/.test(pageId)) {
    throw new Error(`Invalid page_id: contains disallowed character: ${pageId}`)
  }
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
const scoreFrom = (sim) => 1 / (1 + (1 - sim)) // distance = 1 - cosine

// ── v1 (page-level vectors) ───────────────────────────────────────────────
async function vectorUpsert({ projectPath, pageId, embedding }) {
  validatePageId(pageId)
  const data = load(projectPath)
  data.v1 = data.v1.filter((r) => r.page_id !== pageId)
  data.v1.push({ page_id: pageId, vector: embedding })
  await save(projectPath)
}
async function vectorSearch({ projectPath, queryEmbedding, topK = 10 }) {
  const data = load(projectPath)
  return data.v1
    .map((r) => ({ page_id: r.page_id, score: scoreFrom(cosine(r.vector, queryEmbedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK))
}
async function vectorDelete({ projectPath, pageId }) {
  const data = load(projectPath)
  data.v1 = data.v1.filter((r) => r.page_id !== pageId)
  await save(projectPath)
}
async function vectorCount({ projectPath }) { return load(projectPath).v1.length }

// ── v2 (chunk-level vectors) ──────────────────────────────────────────────
async function vectorUpsertChunks({ projectPath, pageId, chunks }) {
  validatePageId(pageId)
  if (!chunks || chunks.length === 0) return
  const data = load(projectPath)
  data.v2 = data.v2.filter((r) => r.page_id !== pageId)
  for (const c of chunks) {
    data.v2.push({
      chunk_id: `${pageId}#${c.chunk_index}`,
      page_id: pageId,
      chunk_index: c.chunk_index,
      chunk_text: c.chunk_text ?? "",
      heading_path: c.heading_path ?? "",
      vector: c.embedding,
    })
  }
  await save(projectPath)
}
async function vectorSearchChunks({ projectPath, queryEmbedding, topK = 10 }) {
  const data = load(projectPath)
  return data.v2
    .map((r) => ({
      chunk_id: r.chunk_id, page_id: r.page_id, chunk_index: r.chunk_index,
      chunk_text: r.chunk_text, heading_path: r.heading_path,
      score: scoreFrom(cosine(r.vector, queryEmbedding)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK))
}
async function vectorDeletePage({ projectPath, pageId }) {
  const data = load(projectPath)
  data.v2 = data.v2.filter((r) => r.page_id !== pageId)
  await save(projectPath)
}
async function vectorCountChunks({ projectPath }) { return load(projectPath).v2.length }
async function vectorClearChunks({ projectPath }) {
  const data = load(projectPath); data.v2 = []; await save(projectPath)
}
async function vectorOptimizeChunks() { return null } // no-op (LanceDB compaction)
async function vectorLegacyRowCount() { return 0 }
async function vectorDropLegacy() { return null }

export const vectorCommands = {
  vector_upsert: vectorUpsert,
  vector_search: vectorSearch,
  vector_delete: vectorDelete,
  vector_count: vectorCount,
  vector_upsert_chunks: vectorUpsertChunks,
  vector_search_chunks: vectorSearchChunks,
  vector_delete_page: vectorDeletePage,
  vector_count_chunks: vectorCountChunks,
  vector_clear_chunks: vectorClearChunks,
  vector_optimize_chunks: vectorOptimizeChunks,
  vector_legacy_row_count: vectorLegacyRowCount,
  vector_drop_legacy: vectorDropLegacy,
}
