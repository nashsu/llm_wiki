import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { readStore } from "./store.js"
import { searchCommands } from "./commands/search.js"
import { buildSnapshot } from "./graph.js"
import { fileSyncCommands } from "./commands/fileSync.js"
import { agentStartTurn, agentCancelTurn } from "./agent.js"

// Server port of the desktop's external REST API (src-tauri/src/api_server.rs)
// so the bundled MCP server (mcp-server/src/api-client.ts) and the advertised
// external agent skill talk to the WEB backend unchanged — i.e. "one backend"
// for the user AND their agents. Response envelopes, the public-path guard,
// traversal-safe joins, and auth all mirror the Rust source so the MCP client's
// parsers (requireObject + field reads) succeed byte-for-byte.
//
// Auth is read from the SAME shared store the desktop uses (apiConfig.token) or
// LLM_WIKI_API_TOKEN, so a token set in the desktop's Settings is enforced here
// too. Accepted via ?token=, header x-llm-wiki-token, or Authorization: Bearer.

import { constantTimeEq } from "./lib/crypto-utils.js"

const fwd = (p) => p.split(path.sep).join("/")
const normPath = (p) => fwd(p).replace(/\\/g, "/")
function fmType(content) {
  const m = /^---\n[\s\S]*?\n---/.exec(String(content || ""))
  if (!m) return ""
  const t = /^type:\s*["']?([^"'\n]+?)\s*["']?\s*$/m.exec(m[0])
  return t ? t[1].trim().toLowerCase() : ""
}

// ── auth (mirror api_server.rs) ───────────────────────────────────────────
function apiAuth(store) {
  const envT = (process.env.LLM_WIKI_API_TOKEN || "").trim()
  const cfg = (store && store.apiConfig) || {}
  const storeT = typeof cfg.token === "string" ? cfg.token.trim() : ""
  const token = envT || storeT
  const source = envT ? "env" : (storeT ? "store" : "none")
  const allowUnauth = cfg.allowUnauthenticated === true
  const enabled = cfg.enabled !== false
  const mcpEnabled = cfg.mcpEnabled !== false // web server always serves /api/v1
  return { token, source, allowUnauth, authRequired: !allowUnauth, authConfigured: !!token, enabled, mcpEnabled }
}
function isAuthorized(store, headers, searchParams) {
  const a = apiAuth(store)
  if (!a.authRequired) return true
  if (!a.token) return false
  const qtok = searchParams.get("token")
  if (qtok && constantTimeEq(qtok, a.token)) return true
  const x = headers["x-llm-wiki-token"]
  if (typeof x === "string" && constantTimeEq(x, a.token)) return true
  const auth = headers["authorization"]
  if (typeof auth === "string" && auth.startsWith("Bearer ") && constantTimeEq(auth.slice(7), a.token)) return true
  return false
}

// ── public-path guard + safe join (mirror is_public_project_rel/safe_join) ─
function isPublicRel(rel) {
  const r = normPath(rel).replace(/^\/+/, "")
  if (r.split("/").some((p) => p === "" || p.startsWith("."))) return false
  const l = r.toLowerCase()
  return l === "purpose.md" || l === "schema.md" || l.startsWith("wiki/") || l.startsWith("raw/sources/")
}
const TEXT_EXTS = new Set(["md","mdx","txt","csv","json","yaml","yml","xml","html","htm","rtf","log"])
function isTextRel(rel) { return TEXT_EXTS.has((path.extname(rel).slice(1) || "").toLowerCase()) }
function safeJoin(projectPath, rel) {
  const r = String(rel || "").replace(/^\/+/, "")
  const rp = path.normalize(r)
  if (path.isAbsolute(rp) || rp.split(path.sep).some((c) => c === "..")) throw new Error("Path traversal is not allowed")
  const joined = path.join(projectPath, rp)
  const rootCanon = fs.realpathSync(projectPath)
  if (fs.existsSync(joined)) {
    const jc = fs.realpathSync(joined)
    if (jc !== rootCanon && !jc.startsWith(rootCanon + path.sep)) throw new Error("Resolved path escapes the project directory")
    return jc
  }
  const parent = path.dirname(joined)
  if (fs.existsSync(parent)) {
    const pc = fs.realpathSync(parent)
    if (pc !== rootCanon && !pc.startsWith(rootCanon + path.sep)) throw new Error("Resolved parent escapes the project directory")
  }
  return joined
}

// ── project resolution (mirror load_projects / resolve_project) ────────────
function readProjectIdOnDisk(p) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(p, ".llm-wiki", "project.json"), "utf-8"))
    return typeof j?.id === "string" && j.id ? j.id : null
  } catch { return null }
}
function projectNameFromPath(p) { return path.basename(p.replace(/\/+$/, "")) || "Unknown" }
function loadProjects(store) {
  const reg = (store && store.projectRegistry) || {}
  const recents = Array.isArray(store?.recentProjects) ? store.recentProjects : []
  const lastPath = normPath(store?.lastProject?.path || "")
  const byPath = new Map()
  for (const [id, v] of Object.entries(reg)) {
    const p = normPath(v?.path || "")
    if (!p) continue
    byPath.set(p, { id, name: typeof v?.name === "string" && v.name ? v.name : projectNameFromPath(p), path: p, current: p === lastPath })
  }
  for (const v of recents) {
    const p = normPath(v?.path || "")
    if (!p || byPath.has(p)) continue
    const id = (typeof v?.id === "string" && v.id) ? v.id : (readProjectIdOnDisk(p) || p)
    byPath.set(p, { id, name: typeof v?.name === "string" && v.name ? v.name : projectNameFromPath(p), path: p, current: p === lastPath })
  }
  return [...byPath.values()]
}
function resolveProject(store, id) {
  const projects = loadProjects(store)
  if (id === "current") {
    const cur = projects.find((p) => p.current) || (projects.length === 1 ? projects[0] : null)
    if (!cur) throw Object.assign(new Error("No current project. Open a project first."), { status: 404 })
    return cur
  }
  let found = projects.find((p) => p.id === id)
  if (!found) found = projects.find((p) => normPath(p.path) === normPath(id))
  if (!found) {
    const reg = (store && store.projectRegistry) || {}
    if (reg[id]?.path) found = { id, name: reg[id].name || projectNameFromPath(reg[id].path), path: normPath(reg[id].path), current: normPath(reg[id].path) === normPath(store?.lastProject?.path || "") }
  }
  if (!found) throw Object.assign(new Error(`Project not found: ${id}`), { status: 404 })
  return found
}

// ── files ──────────────────────────────────────────────────────────────────
function walkPublic(dir, relBase, recursive, counter, maxFiles, truncated) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    if (counter.n >= maxFiles) { truncated.v = true; break }
    const full = path.join(dir, e.name)
    const rel = relBase ? `${relBase}/${e.name}` : e.name
    const isDir = e.isDirectory()
    const node = { name: e.name, path: fwd(rel), isDir }
    if (isDir) {
      if (recursive) node.children = walkPublic(full, rel, true, counter, maxFiles, truncated)
      else node.children = []
    } else {
      counter.n++
    }
    out.push(node)
  }
  return out
}
function listFiles(projectPath, root, recursive, maxFiles) {
  const roots = root === "sources" ? ["raw/sources"] : root === "all" ? ["wiki", "raw/sources"] : ["wiki"]
  const counter = { n: 0 }
  const truncated = { v: false }
  const files = []
  for (const r of roots) {
    const abs = path.join(projectPath, r)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue
    if (recursive) {
      const kids = walkPublic(abs, r, true, counter, maxFiles, truncated)
      files.push({ name: path.basename(r === "raw/sources" ? "sources" : r), path: fwd(r), isDir: true, children: kids })
    } else {
      files.push(...walkPublic(abs, r, false, counter, maxFiles, truncated))
    }
    if (truncated.v) break
  }
  return { files, truncated: truncated.v }
}

// ── reviews (on-disk shape already matches ApiReviewItem) ──────────────────
function loadReviews(projectPath, { status, type, limit }) {
  let items = []
  try { items = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "review.json"), "utf-8")) } catch { items = [] }
  if (!Array.isArray(items)) items = []
  const norm = (it) => ({
    id: String(it?.id ?? ""), type: String(it?.type ?? ""), title: String(it?.title ?? ""),
    description: String(it?.description ?? ""), sourcePath: typeof it?.sourcePath === "string" ? it.sourcePath : undefined,
    affectedPages: Array.isArray(it?.affectedPages) ? it.affectedPages.map(String) : undefined,
    searchQueries: Array.isArray(it?.searchQueries) ? it.searchQueries.map(String) : undefined,
    options: Array.isArray(it?.options) ? it.options.map((o) => ({ label: String(o?.label ?? ""), action: String(o?.action ?? "") })) : [],
    resolved: it?.resolved === true, resolvedAction: typeof it?.resolvedAction === "string" ? it.resolvedAction : undefined,
    createdAt: typeof it?.createdAt === "number" ? it.createdAt : 0,
  })
  let filtered = items.map(norm)
  if (status === "resolved") filtered = filtered.filter((r) => r.resolved)
  else if (status === "unresolved") filtered = filtered.filter((r) => !r.resolved)
  if (type) filtered = filtered.filter((r) => r.type === type)
  if (typeof limit === "number" && limit >= 0) filtered = filtered.slice(0, limit)
  return { status: status || "unresolved", reviews: filtered }
}

// ── graph (from graph.js snapshot) ─────────────────────────────────────────
function buildGraph(projectPath, { q, nodeType, limit }) {
  const { pages, adjacency } = buildSnapshot(projectPath, null)
  let nodes = pages.map((p) => {
    const deg = (adjacency.get(p.path)?.size) || 0
    return { id: fwd(p.path), label: p.title || p.stem, nodeType: (fmType(p.content) || p.type || "other"), path: fwd(p.path), linkCount: deg, weight: 1 }
  })
  const edgeSet = new Set()
  const edges = []
  for (const [a, set] of adjacency) {
    for (const b of set) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      edges.push({ source: fwd(a), target: fwd(b), weight: 1 })
    }
  }
  if (nodeType) { const t = String(nodeType).toLowerCase(); nodes = nodes.filter((n) => String(n.nodeType).toLowerCase() === t) }
  if (q) { const ql = String(q).toLowerCase(); nodes = nodes.filter((n) => n.label.toLowerCase().includes(ql) || n.id.toLowerCase().includes(ql)) }
  const keep = new Set(nodes.map((n) => n.id))
  const fEdges = edges.filter((e) => keep.has(e.source) && keep.has(e.target))
  if (typeof limit === "number" && limit >= 0) nodes = nodes.slice(0, limit)
  return { nodes, edges: fEdges }
}

// ── handler entry ──────────────────────────────────────────────────────────
export async function handleApiV1(ctx) {
  const { method, pathname, searchParams, headers, body, sendJson } = ctx
  if (!pathname.startsWith("/api/v1/")) return false
  const segs = pathname.slice("/api/v1/".length).split("/").filter(Boolean).map((s) => decodeURIComponent(s))
  const store = readStore("app-state.json")
  const ok = (obj) => sendJson(200, { ok: true, ...obj })
  const err = (status, msg) => sendJson(status, { ok: false, error: msg })
  const needAuth = !(segs[0] === "health")
  if (needAuth && !isAuthorized(store, headers, searchParams)) return err(401, "Unauthorized"), true

  try {
    if (method === "GET" && segs[0] === "health") {
      const a = apiAuth(store)
      return ok({ status: "ok", enabled: a.enabled, mcpEnabled: a.mcpEnabled, authRequired: a.authRequired, authConfigured: a.authConfigured, allowUnauthenticated: a.allowUnauth, tokenSource: a.source }), true
    }
    if (method === "GET" && segs[0] === "projects" && segs.length === 1) {
      const projects = loadProjects(store)
      return ok({ projects, currentProject: projects.find((p) => p.current) || null }), true
    }
    if (segs[0] === "projects" && segs.length >= 2) {
      const pid = segs[1]
      const project = resolveProject(store, pid)
      const rest = segs.slice(2)
      if (method === "GET" && rest[0] === "files" && rest.length === 1) {
        const root = searchParams.get("root") || "wiki"
        const recursive = searchParams.get("recursive") !== "false"
        const maxFiles = Math.max(1, Math.min(50000, Number(searchParams.get("maxFiles")) || 5000))
        const { files, truncated } = listFiles(project.path, root, recursive, maxFiles)
        return ok({ files, truncated }), true
      }
      if (method === "GET" && rest[0] === "files" && rest[1] === "content") {
        const rel = searchParams.get("path") || ""
        if (!isPublicRel(rel)) return err(403, "Path is not public"), true
        if (!isTextRel(rel)) return err(400, "Only text files can be read through the API"), true
        let abs
        try { abs = safeJoin(project.path, rel) } catch (e) { return err(400, e.message), true }
        let content
        try { content = fs.readFileSync(abs, "utf-8") } catch { return err(404, "File not found"), true }
        return ok({ path: rel, content }), true
      }
      if (method === "GET" && rest[0] === "reviews") {
        const status = searchParams.get("status") || "unresolved"
        const type = searchParams.get("type") || undefined
        const limit = searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined
        const { status: st, reviews } = loadReviews(project.path, { status, type, limit })
        return ok({ projectId: project.id, status: st, count: reviews.length, reviews }), true
      }
      if (method === "POST" && rest[0] === "search") {
        const b = parseJson(body)
        const embCfg = store?.embeddingConfig
        const r = await searchCommands.search_project({
          projectPath: project.path, query: String(b?.query ?? ""), topK: Number(b?.topK) || 20,
          includeContent: b?.includeContent === true, queryEmbedding: null,
          embeddingConfig: embCfg && embCfg.enabled ? embCfg : null,
        })
        return ok({ results: r.results, mode: r.mode, tokenHits: r.tokenHits, vectorHits: r.vectorHits, graphHits: r.graphHits }), true
      }
      if (method === "POST" && rest[0] === "chat" && rest.length === 1) {
        const b = parseJson(body)
        const sessionId = (typeof b?.sessionId === "string" && b.sessionId) ? b.sessionId : crypto.randomUUID()
        const request = {
          message: String(b?.message ?? ""), sessionId, runId: crypto.randomUUID(),
          mode: b?.mode || "standard", retrievalMode: "standard",
          tools: b?.tools && typeof b.tools === "object" ? { wiki: b.tools.wiki !== false, web: !!b.tools.web, anytxt: !!b.tools.anytxt } : { wiki: true, web: false, anytxt: false },
          topK: Number(b?.topK) || 5, includeContent: b?.includeContent === true,
          skills: Array.isArray(b?.skills) ? b.skills : [], history: [],
        }
        let resp
        try { resp = await agentStartTurn({ projectId: project.id, request }) }
        catch (e) {
          return ok({ projectId: project.id, sessionId, mode: request.mode, message: { role: "assistant", content: `Error: ${e instanceof Error ? e.message : String(e)}` }, references: [], toolEvents: [], events: [], usage: { referenceCount: 0, toolEventCount: 0 } }), true
        }
        const content = typeof resp.message === "string" ? resp.message : (resp.message?.content ?? "")
        const refs = resp.references || []
        const te = resp.toolEvents || []
        return ok({ projectId: project.id, sessionId: resp.sessionId || sessionId, mode: resp.mode || request.mode, message: { role: "assistant", content }, references: refs, toolEvents: te, events: [], usage: { referenceCount: refs.length, toolEventCount: te.length } }), true
      }
      if (method === "POST" && rest[0] === "chat" && rest.length === 3 && rest[2] === "cancel") {
        const sid = rest[1]
        try { await agentCancelTurn({ runId: sid }) } catch { /* best effort */ }
        return ok({ sessionId: sid, cancelled: true }), true
      }
      if (method === "GET" && rest[0] === "graph") {
        const g = buildGraph(project.path, { q: searchParams.get("q") || undefined, nodeType: searchParams.get("nodeType") || undefined, limit: searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined })
        return ok({ projectId: project.id, nodes: g.nodes, edges: g.edges }), true
      }
      if (method === "POST" && rest[0] === "sources" && rest[1] === "rescan") {
        const r = await fileSyncCommands.rescan_project_files({ projectId: project.id, projectPath: project.path })
        return ok({ projectId: project.id, result: { changed: (r.changedTasks || []).length, queueVersion: r.queue?.version ?? 0 } }), true
      }
    }
    return err(404, `Unknown API endpoint: /api/v1/${segs.join("/")}`), true
  } catch (e) {
    const status = (e && typeof e.status === "number") ? e.status : 500
    return err(status, e instanceof Error ? e.message : String(e)), true
  }
}

function parseJson(body) {
  if (!body || typeof body !== "string" || !body.trim()) return {}
  try { return JSON.parse(body) } catch { return {} }
}
