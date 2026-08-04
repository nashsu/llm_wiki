import fs from "node:fs"
import path from "node:path"
import { blendGraphResults } from "../graph.js"
import { vectorCommands, vectorIndexHealth } from "./vectorstore.js"
import { isVecAvailable } from "../store/db.js"
import { readStoreKey } from "../store.js"
import { SHARED_STORE_NAME } from "../config.js"

// Node port of the keyword-search + page-links subset of
// src-tauri/src/commands/search.rs, plus server-side embedding fetches.
// Keyword ranking is blended with the wikilink-graph neighbor expansion
// (blend_graph_results), matching the desktop hybrid engine's graph layer.
// Vector ranking is layered separately via the server vector store.
//
// Retrieval mode (issue #14 gap): the global `wikiSearchMode` setting
// (keyword | vector | hybrid, default hybrid) governs every RAG surface —
// search UI, v1/v2 HTTP routes, the invoke bridge, and agent wiki.search.
// keyword = keyword+graph, vector = vector+graph, hybrid = all three. When
// the vector leg was requested but cannot run, the response degrades to
// keyword results and carries `vectorUnavailableReason` so clients can show a
// notice; requests never fail.

const MAX_SEARCH_FILES = 5000
const fwd = (p) => p.split(path.sep).join("/")

const STOP_WORDS = new Set([
  "的","是","了","什么","在","有","和","与","对","从",
  "the","is","a","an","what","how","are","was","were",
  "do","does","did","be","been","being","have","has","had",
  "it","its","in","on","at","to","for","of","with","by",
  "this","that","these","those",
])

function isQuerySeparator(ch) {
  if (/\s/.test(ch)) return true
  if (/[!-/:-@[-`{-~]/.test(ch)) return true // ASCII punctuation
  return "，。！？、；：“”‘’（）·～…".includes(ch)
}

export function tokenizeQuery(query) {
  const lower = query.toLowerCase()
  const raw = []
  let cur = ""
  for (const ch of lower) {
    if (isQuerySeparator(ch)) { if (cur) { raw.push(cur); cur = "" } }
    else cur += ch
  }
  if (cur) raw.push(cur)
  const filtered = raw.filter((t) => [...t].length > 1 && !STOP_WORDS.has(t))
  const out = []
  for (const token of filtered) {
    const chars = [...token]
    const hasCjk = chars.some((c) => c >= "\u3400" && c <= "\u9fff")
    if (hasCjk && chars.length > 2) {
      for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
      for (const ch of chars) if (!STOP_WORDS.has(ch)) out.push(ch)
      out.push(token)
    } else {
      out.push(token)
    }
  }
  return [...new Set(out)]
}

export function extractTitle(content, fileName) {
  const lines = content.split("\n")
  let i = 0
  if (lines[0] && lines[0].trim() === "---") {
    for (let j = 1; j < lines.length; j++) {
      const trimmed = lines[j].trim()
      if (trimmed === "---") { i = j + 1; break }
      const m = /^title:\s*(.+)$/.exec(lines[j])
      if (m) return m[1].trim().replace(/^["']|["']$/g, "")
    }
  }
  for (; i < lines.length; i++) {
    const m = /^#\s+(.+)$/.exec(lines[i].trim())
    if (m) return m[1].trim()
  }
  return fileName.replace(/\.md$/i, "")
}

function extractWikilinks(content) {
  const links = []
  let rest = content
  while (true) {
    const start = rest.indexOf("[[")
    if (start < 0) break
    rest = rest.slice(start + 2)
    const end = rest.indexOf("]]")
    if (end < 0) break
    const target = rest.slice(0, end).split("|")[0].trim()
    if (target) links.push(target)
    rest = rest.slice(end + 2)
  }
  return links
}

function extractImages(content) {
  const images = []
  const mdImg = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g
  let m
  while ((m = mdImg.exec(content)) && images.length < 8) {
    images.push({ url: m[2], alt: m[1] })
  }
  return images
}

function walkMarkdownFiles(root, out) {
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= MAX_SEARCH_FILES) return
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue
      walkMarkdownFiles(full, out)
    } else if (entry.name.endsWith(".md")) {
      out.push(full)
    }
  }
}

function relativeToProject(project, file) {
  return fwd(path.relative(project, file))
}

function stripFrontmatter(content) {
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3)
    if (end >= 0) return content.slice(end + 4)
  }
  return content
}

function makeSnippet(content, tokens) {
  content = stripFrontmatter(content)
  const lower = content.toLowerCase()
  let idx = -1
  for (const t of tokens) { const found = lower.indexOf(t); if (found >= 0 && (idx < 0 || found < idx)) idx = found }
  if (idx < 0) {
    const plain = content.replace(/^---[\s\S]*?---\n*/, "").replace(/[#>*`_\-]+/g, " ").replace(/\s+/g, " ").trim()
    return plain.slice(0, 160)
  }
  const start = Math.max(0, idx - 40)
  return content.slice(start, start + 200).replace(/\s+/g, " ").trim()
}

const RRF_K = 60
const SNIPPET_CONTEXT = 80
const normPath = (p) => fwd(p).replace(/\\/g, "/")
const fileStem = (p) => path.basename(p).replace(/\.md$/i, "")

function buildVectorSnippet(chunkText, headingPath) {
  let text = String(chunkText ?? "").trim().replace(/\n/g, " ")
  if (!text) return ""
  const chars = [...text]
  if (chars.length > SNIPPET_CONTEXT * 2) text = chars.slice(0, SNIPPET_CONTEXT * 2).join("") + "..."
  const heading = String(headingPath ?? "").trim()
  return heading ? `${heading}: ${text}` : text
}

function searchMode(tokenRankEmpty, vectorHits, graphHits) {
  if (graphHits > 0) return "hybrid"
  if (vectorHits === 0) return "keyword"
  if (tokenRankEmpty) return "vector"
  return "hybrid"
}

async function resolveQueryEmbedding(query, queryEmbedding, embeddingConfig) {
  if (Array.isArray(queryEmbedding) && queryEmbedding.length) return queryEmbedding
  if (!embeddingConfig || !embeddingConfig.enabled || !embeddingConfig.endpoint) return null
  try {
    const vec = await embeddingFetch({ text: query, cfg: embeddingConfig })
    return Array.isArray(vec) && vec.length ? vec : null
  } catch {
    return null
  }
}

// Mirror of Rust search_by_embedding: chunk search -> per-page blend
// (top + min(tail*0.3, max(0,1-top))) -> rank pages -> truncate.
async function searchByEmbeddingServer(projectPath, queryEmb, requestK) {
  const chunkK = Math.max(requestK * 3, 30)
  const raw = await vectorCommands.vector_search_chunks({ projectPath, queryEmbedding: queryEmb, topK: chunkK })
  if (!raw || !raw.length) return []
  const byPage = new Map()
  for (const c of raw) {
    if (!byPage.has(c.page_id)) byPage.set(c.page_id, [])
    byPage.get(c.page_id).push(c)
  }
  const ranked = []
  for (const [id, chunks] of byPage) {
    chunks.sort((a, b) => (b.score - a.score) || (a.chunk_index - b.chunk_index))
    const top = chunks[0]
    const tail = chunks.slice(1).reduce((sum, c) => sum + c.score, 0)
    const blended = top.score + Math.min(tail * 0.3, Math.max(0, 1 - top.score))
    ranked.push({ id, score: blended, chunkText: top.chunk_text, headingPath: top.heading_path })
  }
  ranked.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return ranked.slice(0, requestK)
}

function materializeVectorOnly(vectorResults, pagePathsByStem, projectPath, results, includeContent) {
  const known = new Set(results.map((r) => fileStem(r.path)))
  for (const vr of vectorResults) {
    if (known.has(vr.id)) continue
    const rel = pagePathsByStem.get(vr.id)
    if (!rel) continue
    const abs = path.join(projectPath, rel)
    let content
    try { content = fs.readFileSync(abs, "utf-8") } catch { continue }
    results.push({
      path: rel,
      title: extractTitle(content, path.basename(rel)),
      snippet: buildVectorSnippet(vr.chunkText, vr.headingPath),
      titleMatch: false,
      score: 0,
      vectorScore: vr.score,
      images: extractImages(content),
      ...(includeContent ? { content } : {}),
    })
    known.add(vr.id)
  }
}

function applyRrf(results, tokenRank, vectorRank, vectorScoreMap) {
  for (const r of results) {
    const t = tokenRank.get(normPath(r.path))
    const v = vectorRank.get(fileStem(r.path))
    let rrf = 0
    if (t) rrf += 1 / (RRF_K + t)
    if (v) rrf += 1 / (RRF_K + v)
    const vs = vectorScoreMap.get(fileStem(r.path))
    if (vs != null) r.vectorScore = vs
    r.score = rrf
  }
}

const WIKI_SEARCH_MODES = new Set(["keyword", "vector", "hybrid"])

/** Resolve the effective retrieval mode: explicit param → shared store → hybrid. */
export function resolveWikiSearchMode(requested) {
  if (WIKI_SEARCH_MODES.has(requested)) return requested
  const stored = readStoreKey(SHARED_STORE_NAME, "wikiSearchMode")
  if (WIKI_SEARCH_MODES.has(stored)) return stored
  return "hybrid"
}

async function searchProject({ projectPath, query, topK = 20, includeContent = false, queryEmbedding = null, embeddingConfig = null, wikiSearchMode = null }) {
  const retrievalMode = resolveWikiSearchMode(wikiSearchMode)
  const wikiRoot = path.join(projectPath, "wiki")
  const files = []
  walkMarkdownFiles(wikiRoot, files)
  const tokens = tokenizeQuery(query || "")
  const qLower = (query || "").toLowerCase()
  const results = []
  const graphPages = []
  const pagePathsByStem = new Map()

  // Decide the vector leg up front so a requested-but-unavailable vector mode
  // can still fall back to keyword scoring below. An explicit queryEmbedding
  // (desktop Rust parity, also reachable via the invoke bridge) is honored
  // even when no server embedding provider is configured.
  const wantVector = retrievalMode !== "keyword"
  let vectorUnavailableReason = null
  let qEmb = null
  if (wantVector) {
    const hasExplicitEmbedding = Array.isArray(queryEmbedding) && queryEmbedding.length > 0
    if (!isVecAvailable()) {
      vectorUnavailableReason = "Vector search is unavailable on this server (sqlite-vec extension not loaded)"
    } else if (!hasExplicitEmbedding && (!embeddingConfig || !embeddingConfig.enabled || !embeddingConfig.endpoint)) {
      vectorUnavailableReason = "No embedding provider is configured"
    } else {
      qEmb = await resolveQueryEmbedding(query, queryEmbedding, embeddingConfig)
      if (!qEmb) vectorUnavailableReason = "The embedding request failed"
    }
  }
  let useVector = wantVector && !!qEmb
  // Index health gate: an empty index (project never re-indexed since the
  // sqlite-vec upgrade) or a dimension mismatch (provider switch) must
  // degrade to keyword results with a reason — not return a silent zero.
  if (useVector) {
    const health = vectorIndexHealth({ projectPath, queryEmbedding: qEmb })
    if (health === "empty") {
      useVector = false
      vectorUnavailableReason ??= "The vector index is empty for this project — re-index pages to enable vector search"
    } else if (health === "dim_mismatch") {
      useVector = false
      vectorUnavailableReason ??= "The embedding dimension does not match the vector index — re-index pages to enable vector search"
    }
  }

  for (const file of files) {
    let content
    try { content = fs.readFileSync(file, "utf-8") } catch { continue }
    const rel = relativeToProject(projectPath, file)
    const fileName = path.basename(file)
    pagePathsByStem.set(fileStem(rel), rel)
    graphPages.push({ path: rel, title: extractTitle(content, fileName), links: extractWikilinks(content), content })
  }

  // The vector leg runs BEFORE keyword scoring so a mid-retrieval failure can
  // still degrade a vector-mode search to keyword results.
  // LIMIT binds must be integers: floor topK so fractional values don't throw.
  const limit = Math.max(1, Math.floor(Number(topK) || 20))
  let vectorHits = 0
  let vectorResults = []
  if (useVector) {
    try {
      vectorResults = await searchByEmbeddingServer(projectPath, qEmb, Math.max(limit, 10)) || []
      vectorHits = vectorResults.length
    } catch {
      useVector = false
      vectorUnavailableReason ??= "Vector search failed during retrieval"
    }
  }

  // Keyword leg runs in keyword/hybrid modes, and as the fallback when a
  // vector-mode search degrades (either the gates above or the catch below).
  if (retrievalMode !== "vector" || !useVector) {
    for (const page of graphPages) {
      const fileName = path.basename(page.path)
      if (fileName === "index.md" || fileName === "log.md") continue
      const title = page.title
      const content = page.content
      const titleLower = title.toLowerCase()
      const bodyLower = content.toLowerCase()
      let score = 0
      let titleMatch = false
      if (qLower && titleLower.includes(qLower)) { score += 100; titleMatch = true }
      for (const t of tokens) {
        if (titleLower.includes(t)) { score += 20; titleMatch = true }
        const occ = bodyLower.split(t).length - 1
        if (occ > 0) score += Math.min(occ, 20)
      }
      if (score <= 0) continue
      results.push({
        path: page.path, title,
        snippet: makeSnippet(content, tokens.length ? tokens : [qLower]),
        titleMatch, score, images: extractImages(content),
        ...(includeContent ? { content } : {}),
      })
    }
  }

  // token_rank over keyword-sorted order (path tiebreak, like the desktop).
  const keywordSorted = [...results].sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const tokenRank = new Map()
  keywordSorted.forEach((r, idx) => tokenRank.set(normPath(r.path), idx + 1))

  const vectorRank = new Map()
  const vectorScoreMap = new Map()
  if (useVector && vectorResults.length) {
    vectorResults.forEach((vr, idx) => { vectorRank.set(vr.id, idx + 1); vectorScoreMap.set(vr.id, vr.score) })
    materializeVectorOnly(vectorResults, pagePathsByStem, projectPath, results, includeContent)
  }

  if (vectorHits > 0) applyRrf(results, tokenRank, vectorRank, vectorScoreMap)

  results.sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const { results: blended, graphHits } = blendGraphResults(results, graphPages, limit, vectorHits)
  const limited = blended.slice(0, limit)
  const mode = searchMode(tokenRank.size === 0, vectorHits, graphHits)
  return {
    mode, results: limited, tokenHits: tokenRank.size, vectorHits, graphHits,
    ...(vectorUnavailableReason ? { vectorUnavailableReason } : {}),
  }
}

function resolveReaderWikilink(pageKeys, link) {
  const normalized = link.trim().replace(/\\/g, "/")
  if (normalized.includes("/")) {
    return pageKeys.includes(normalized) ? normalized : null
  }
  const filename = normalized.endsWith(".md") ? normalized : `${normalized}.md`
  return pageKeys.find((p) => path.basename(p) === filename) || null
}

async function getPageLinks({ projectPath, filePath }) {
  const project = fs.realpathSync(projectPath)
  const file = fs.realpathSync(filePath)
  const wikiRoot = path.join(project, "wiki")
  if (!file.startsWith(wikiRoot) || !fs.statSync(file).isFile() || path.extname(file) !== ".md") {
    throw new Error("Page links target must be an existing Markdown file under wiki/")
  }
  const files = []
  walkMarkdownFiles(wikiRoot, files)
  const pages = new Map()
  for (const f of files) {
    let content
    try { content = fs.readFileSync(f, "utf-8") } catch { continue }
    const rel = relativeToProject(project, f)
    pages.set(rel, { path: rel, title: extractTitle(content, path.basename(f)), links: extractWikilinks(content) })
  }
  const currentPath = relativeToProject(project, file)
  const current = pages.get(currentPath)
  if (!current) throw new Error("Page is not available in the current wiki index")
  const keys = [...pages.keys()]
  const outgoing = []
  const missing = []
  for (const link of current.links) {
    const target = resolveReaderWikilink(keys, link)
    if (target) {
      if (target === currentPath) continue
      const t = pages.get(target)
      if (t) outgoing.push({ title: t.title, path: t.path, snippet: null })
    } else {
      missing.push({ title: link, path: null, snippet: null })
    }
  }
  const backlinks = []
  for (const [p, page] of pages) {
    if (p === currentPath) continue
    const linksHere = page.links.some((link) => resolveReaderWikilink(keys, link) === currentPath)
    if (linksHere) backlinks.push({ title: page.title, path: page.path, snippet: null })
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title)
  outgoing.sort(byTitle); backlinks.sort(byTitle); missing.sort(byTitle)
  const dedupByPath = (arr) => { const seen = new Set(); return arr.filter((e) => { const k = e.path ?? e.title; if (seen.has(k)) return false; seen.add(k); return true }) }
  const dedupByTitle = (arr) => { const seen = new Set(); return arr.filter((e) => { if (seen.has(e.title)) return false; seen.add(e.title); return true }) }
  return { outgoing: dedupByPath(outgoing), backlinks: dedupByPath(backlinks), missing: dedupByTitle(missing) }
}

// ── Server-side embeddings (OpenAI-compatible /embeddings) ────────────────
function embeddingUrl(endpoint) {
  const base = (endpoint || "").replace(/\/+$/, "")
  return /\/embeddings$/.test(base) ? base : `${base}/embeddings`
}

function embeddingHeaders(cfg) {
  const headers = { "Content-Type": "application/json" }
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`
  const reserved = new Set(["authorization","content-type","host","content-length","x-goog-api-key"])
  for (const [k, v] of Object.entries(cfg.extraHeaders || {})) {
    if (!reserved.has(k.toLowerCase())) headers[k] = v
  }
  return headers
}

async function callEmbedding(cfg, input) {
  if (!cfg || !cfg.endpoint) throw new Error("Embedding endpoint not configured")
  const body = { model: cfg.model, input }
  if (cfg.outputDimensionality) body.dimensions = Math.round(cfg.outputDimensionality)
  const res = await fetch(embeddingUrl(cfg.endpoint), {
    method: "POST",
    headers: embeddingHeaders(cfg),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text().catch(() => "")}`)
  const json = await res.json()
  return json.data.map((d) => d.embedding)
}

async function embeddingFetch({ text, cfg, maxRetries = 3 }) {
  let lastErr
  for (let attempt = 0; attempt < Math.max(1, maxRetries); attempt++) {
    try { const [vec] = await callEmbedding(cfg, text); return vec }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 250 * (attempt + 1))) }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function embeddingFetchBatch({ texts, cfg }) {
  if (!texts || texts.length === 0) return []
  return await callEmbedding(cfg, texts)
}

export const searchCommands = {
  search_project: searchProject,
  get_page_links: getPageLinks,
  embedding_fetch: embeddingFetch,
  embedding_fetch_batch: embeddingFetchBatch,
}
