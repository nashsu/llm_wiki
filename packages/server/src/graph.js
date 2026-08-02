import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

// Server port of the desktop's wikilink-graph retrieval used by (a) the Agent
// `graph.search` tool (src-tauri/src/agent/tools.rs::search_graph +
// build_knowledge_graph_snapshot) and (b) the graph-boosted blending in
// `search_project` (blend_graph_results). Both are *neighbor-expansion* over
// the wikilink adjacency graph — NOT the 4-signal relevance model (that one
// only powers the client-side Graph view, which already runs in the browser).
// Constants and normalization mirror the Rust source so rankings match.

const RRF_K = 60
const MAX_GRAPH_SEEDS = 20
const MAX_GRAPH_SEARCH_FILES = 10000
const MAX_KNOWLEDGE_CONTEXT_ITEMS = 20
const MIN_GRAPH_RESULT_RATIO = 0.15
const MAX_GRAPH_RESULT_RATIO = 0.30

const fwd = (p) => p.split(path.sep).join("/")
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

function normPath(p) { return fwd(p).replace(/\\/g, "/") }

function normalizeWikiLink(value) {
  let s = String(value).split("#")[0].trim()
  while (s.endsWith(".md")) s = s.slice(0, -3)
  return s.replace(/\\/g, "/").toLowerCase().replace(/ /g, "-")
}

function graphQueryTerms(query) {
  return String(query).split(/[\s,，;；:：/|]+/).map((t) => t.trim()).filter(Boolean)
}

function isHiddenRel(rel) {
  return normPath(rel).split("/").some((seg) => seg.startsWith("."))
}

function extractTitle(content, fileName) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  if (fm) {
    const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])
    if (t) return t[1].trim()
  }
  const h = /^#\s+(.+)$/m.exec(content)
  if (h) return h[1].trim()
  return (fileName || "").replace(/\.md$/i, "")
}

function extractWikilinks(content) {
  const out = []
  const re = new RegExp(WIKILINK_RE.source, "g")
  let m
  while ((m = re.exec(content))) out.push(m[1].trim())
  return out
}

function extractFrontmatterList(content, key) {
  const normalized = content.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) return []
  const end = normalized.indexOf("\n---", 4)
  if (end < 0) return []
  const body = normalized.slice(4, end)
  const lines = body.split("\n")
  const prefix = `${key}:`
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim().startsWith(prefix)) continue
    const inline = line.trim().slice(prefix.length).trim()
    if (inline.startsWith("[") && inline.endsWith("]")) {
      return inline.slice(1, -1).split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
    }
    const values = []
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (!t.startsWith("-")) break
      const item = t.slice(1).trim().replace(/^['"]|['"]$/g, "")
      if (item) values.push(item)
    }
    return values
  }
  return []
}

function extractImages(content) {
  const out = []
  const re = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g
  let m
  while ((m = re.exec(content)) && out.length < 8) out.push({ url: m[2], alt: m[1] })
  return out
}

function fileStem(p) { return path.basename(p).replace(/\.md$/i, "") }
function wikiRelative(p) { const n = normPath(p); return n.startsWith("wiki/") ? n.slice(5) : n }

// ── snapshot ──────────────────────────────────────────────────────────────
function walkWiki(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkWiki(full, out)
    else if (e.name.endsWith(".md")) out.push(full)
  }
}

/**
 * Build the knowledge-graph snapshot. `pagesArg` lets the search path reuse
 * files it already read (avoiding double IO); when omitted we read from disk
 * (the agent graph.search path). Each page carries an undirected adjacency
 * (`neighbors`, truncated like the desktop) plus a full `adjacency` map for
 * blending, and a knowledge context (outgoing/backlinks/linkCount/tags).
 */
export function buildSnapshot(projectPath, query, pagesArg) {
  const wikiRoot = path.join(projectPath, "wiki")
  let files = []
  let pages
  if (pagesArg) {
    pages = pagesArg.map((p) => ({ ...p, stem: fileStem(p.path), tags: p.tags ?? [] }))
  } else {
    if (!fs.existsSync(wikiRoot) || !fs.statSync(wikiRoot).isDirectory()) {
      return { pages: [], contexts: new Map(), adjacency: new Map() }
    }
    walkWiki(wikiRoot, files)
    pages = []
    for (const f of files) {
      if (pages.length >= MAX_GRAPH_SEARCH_FILES) break
      const rel = normPath(path.relative(projectPath, f))
      if (isHiddenRel(rel)) continue
      let content
      try { content = fs.readFileSync(f, "utf-8") } catch { continue }
      pages.push({
        path: rel,
        title: extractTitle(content, path.basename(f)),
        stem: fileStem(f),
        tags: extractFrontmatterList(content, "tags"),
        links: extractWikilinks(content),
        content,
      })
    }
  }

  const q = query != null ? String(query).trim().toLowerCase() : null
  const terms = q ? graphQueryTerms(q) : []
  for (const page of pages) {
    if (q == null) { page.matchesQuery = false; continue }
    const haystack = `${page.title} ${page.path} ${page.content ?? ""}`.toLowerCase()
    page.matchesQuery = haystack.includes(q) || terms.some((t) => haystack.includes(t))
  }

  // alias -> normPath
  const aliases = new Map()
  for (const page of pages) {
    for (const alias of [page.stem, page.title, page.path, wikiRelative(page.path)]) {
      aliases.set(normalizeWikiLink(alias), page.path)
    }
  }
  const adjacency = new Map()   // normPath -> Set<normPath> (undirected, full)
  const backlinks = new Map()   // normPath -> Set<normPath>
  for (const page of pages) {
    for (const link of page.links) {
      const target = aliases.get(normalizeWikiLink(link))
      if (!target || target === page.path) continue
      if (!adjacency.has(page.path)) adjacency.set(page.path, new Set())
      if (!adjacency.has(target)) adjacency.set(target, new Set())
      adjacency.get(page.path).add(target)
      adjacency.get(target).add(page.path)
      if (!backlinks.has(target)) backlinks.set(target, new Set())
      backlinks.get(target).add(page.path)
    }
  }

  const contexts = new Map()
  for (const page of pages) {
    const outgoingAll = [...new Set(page.links)].sort()
    const totalOut = outgoingAll.length
    const outgoing = outgoingAll.slice(0, MAX_KNOWLEDGE_CONTEXT_ITEMS)
    const backAll = [...(backlinks.get(page.path) ?? [])]
    const totalBack = backAll.length
    const back = backAll.slice(0, MAX_KNOWLEDGE_CONTEXT_ITEMS)
    page.neighbors = [...(adjacency.get(page.path) ?? [])].slice(0, MAX_KNOWLEDGE_CONTEXT_ITEMS)
    contexts.set(page.path, {
      relatedTo: [],
      tags: page.tags.slice(0, MAX_KNOWLEDGE_CONTEXT_ITEMS),
      outgoingLinks: outgoing,
      backlinks: back,
      linkCount: totalOut + totalBack,
    })
  }
  return { pages, contexts, adjacency }
}

// ── agent graph.search (mirrors search_graph) ─────────────────────────────
export function searchGraph(projectPath, query, topK) {
  const q = (query || "").trim().toLowerCase()
  if (!q) return []
  const { pages, contexts } = buildSnapshot(projectPath, q)
  const seedPaths = new Set(pages.filter((p) => p.matchesQuery).map((p) => p.path))
  if (seedPaths.size === 0) return []
  const refs = []
  for (const page of pages) {
    const ctx = contexts.get(page.path)
    if (!ctx) continue
    const connected = page.neighbors.some((n) => seedPaths.has(n))
    if (!page.matchesQuery && !connected) continue
    const relation = page.matchesQuery ? "matched entity" : "direct neighbor"
    refs.push({
      title: page.title,
      path: page.path,
      kind: "graph",
      snippet: `${relation}; ${ctx.linkCount} related link(s)`,
      score: (page.matchesQuery ? 10000 : 5000) + ctx.linkCount,
      knowledgeContext: { relatedTo: ctx.relatedTo, tags: ctx.tags, outgoingLinks: ctx.outgoingLinks, backlinks: ctx.backlinks, linkCount: ctx.linkCount },
    })
  }
  refs.sort((a, b) => (b.score - a.score) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const k = Math.max(1, Math.min(10, topK || 5))
  return refs.slice(0, k)
}

// ── search blending (mirrors blend_graph_results) ─────────────────────────
function graphResultQuota(limit, vectorHits) {
  if (limit < 2) return 0
  const coverage = Math.min(vectorHits, limit) / limit
  const ratio = MAX_GRAPH_RESULT_RATIO - (MAX_GRAPH_RESULT_RATIO - MIN_GRAPH_RESULT_RATIO) * coverage
  return Math.max(1, Math.min(limit - 1, Math.ceil(limit * ratio)))
}

/**
 * Layer graph neighbors onto an already keyword-ranked result list.
 * `ranked` = [{path, title, snippet, ...}] sorted desc by keyword score.
 * `graphPages` = [{path, title, links, content}] for the whole wiki (the same
 * objects the search scan produced — no extra IO). Returns {results, graphHits}.
 */
export function blendGraphResults(ranked, graphPages, limit, vectorHits = 0) {
  if (!ranked.length || !graphPages.length) return { results: ranked.slice(0, limit), graphHits: 0 }

  const aliases = new Map()
  for (const page of graphPages) {
    for (const alias of [page.path, wikiRelative(page.path), fileStem(page.path), page.title]) {
      aliases.set(normalizeWikiLink(alias), normPath(page.path))
    }
  }
  const adjacency = new Map()
  for (const page of graphPages) {
    const src = normPath(page.path)
    for (const link of page.links) {
      const target = aliases.get(normalizeWikiLink(link))
      if (!target || target === src) continue
      if (!adjacency.has(src)) adjacency.set(src, new Set())
      if (!adjacency.has(target)) adjacency.set(target, new Set())
      adjacency.get(src).add(target)
      adjacency.get(target).add(src)
    }
  }

  const seedPaths = ranked.slice(0, Math.min(limit, MAX_GRAPH_SEEDS)).map((r) => normPath(r.path))
  const seedSet = new Set(seedPaths)
  const candidateScores = new Map()
  const candidateSeeds = new Map()
  const pageByPath = new Map(graphPages.map((p) => [normPath(p.path), p]))
  seedPaths.forEach((seed, rank) => {
    const neigh = adjacency.get(seed)
    if (!neigh) return
    for (const n of neigh) {
      if (seedSet.has(n)) continue
      candidateScores.set(n, (candidateScores.get(n) ?? 0) + 1 / (rank + 1))
      const seedPage = pageByPath.get(seed)
      if (seedPage) {
        if (!candidateSeeds.has(n)) candidateSeeds.set(n, new Set())
        candidateSeeds.get(n).add(seedPage.title)
      }
    }
  })

  let candidates = [...candidateScores.entries()].map(([p, s]) => ({ p, s }))
  candidates.sort((a, b) => (b.s - a.s) || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
  candidates = candidates.slice(0, graphResultQuota(limit, vectorHits))
  if (!candidates.length) return { results: ranked.slice(0, limit), graphHits: 0 }

  const selected = new Set(candidates.map((c) => c.p))
  const existing = new Map()
  const rankedPaths = []
  for (const r of ranked) { const np = normPath(r.path); rankedPaths.push(np); existing.set(np, r) }

  const graphCount = candidates.length
  const baseLimit = Math.max(0, limit - graphCount)
  const merged = rankedPaths.filter((p) => !selected.has(p)).filter((p) => existing.has(p)).slice(0, baseLimit).map((p) => existing.get(p))

  for (const { p, s } of candidates) {
    const related = [...(candidateSeeds.get(p) ?? [])]
    if (existing.has(p)) {
      const r = existing.get(p)
      merged.push({ ...r, graphRelatedTo: related })
      continue
    }
    const page = pageByPath.get(p)
    if (!page) continue
    merged.push({
      path: page.path,
      title: page.title,
      snippet: `Graph neighbor of ${related.join(", ")}`,
      titleMatch: false,
      score: s / (RRF_K + 1),
      images: extractImages(page.content ?? ""),
      graphRelatedTo: related,
    })
  }
  return { results: merged, graphHits: graphCount }
}
