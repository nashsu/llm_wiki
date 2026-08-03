// Graph API router (Phase 2.3.6)
// Returns the knowledge graph (nodes + edges) for a project, bridging to
// graph.js buildSnapshot. Node type is derived from frontmatter and link count
// from adjacency degree, exactly mirroring api-v1.js buildGraph so the two
// backends produce identical graphs.
// req.projectId, req.projectRoot, and req.project are attached by the
// projectLookup middleware (middleware/project-lookup.js).

import { Router } from "express"
import { validate } from "../middleware/validate.js"
import { GraphQuerySchema } from "@llm-wiki/api-types"
import { buildSnapshot } from "../graph.js"

const router = Router({ mergeParams: true })

const fwd = (p) => p.split("/").join("/")

// Derive a node type from YAML frontmatter `type:` (mirrors api-v1.js fmType).
function fmType(content) {
  const m = /^---\n[\s\S]*?\n---/.exec(String(content || ""))
  if (!m) return ""
  const t = /^type:\s*["']?([^"'\n]+?)\s*["']?\s*$/m.exec(m[0])
  return t ? t[1].trim().toLowerCase() : ""
}

// GET /api/v2/projects/:id/graph?q=&nodeType=&limit=
router.get("/", validate({ query: GraphQuerySchema }), async (req, res, next) => {
  try {
    const { q, nodeType, limit } = req.validated.query

    const { pages, adjacency } = buildSnapshot(req.projectRoot, null)
    let nodes = pages.map((p) => {
      const deg = adjacency.get(p.path)?.size || 0
      return {
        id: fwd(p.path),
        label: p.title || p.stem,
        nodeType: fmType(p.content) || p.type || "other",
        path: fwd(p.path),
        linkCount: deg,
        weight: 1,
      }
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

    if (nodeType) {
      const t = String(nodeType).toLowerCase()
      nodes = nodes.filter((n) => String(n.nodeType).toLowerCase() === t)
    }
    if (q) {
      const ql = String(q).toLowerCase()
      nodes = nodes.filter((n) => n.label.toLowerCase().includes(ql) || n.id.toLowerCase().includes(ql))
    }
    const keep = new Set(nodes.map((n) => n.id))
    const fEdges = edges.filter((e) => keep.has(e.source) && keep.has(e.target))
    if (typeof limit === "number" && limit >= 0) nodes = nodes.slice(0, limit)

    res.json({ nodes, edges: fEdges })
  } catch (err) {
    next(err)
  }
})

export default router
