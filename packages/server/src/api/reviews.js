// Reviews API router (Phase 2.3.9)
// Review items are stored on-disk at <project>/.llm-wiki/review.json (the same
// shape the desktop and the legacy /api/v1 use), so reviews stay shared across
// clients. This router reads + normalizes + filters them, mirroring
// api-v1.js loadReviews exactly.

import { Router } from "express"
import fs from "node:fs"
import path from "node:path"
import { validate } from "../middleware/validate.js"
import { ReviewQuerySchema } from "../schemas/reviews.js"

const router = Router({ mergeParams: true })

function loadReviews(projectPath, { status, type, limit }) {
  let items = []
  try {
    items = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "review.json"), "utf-8"))
  } catch {
    items = []
  }
  if (!Array.isArray(items)) items = []

  const norm = (it) => ({
    id: String(it?.id ?? ""),
    type: String(it?.type ?? ""),
    title: String(it?.title ?? ""),
    description: String(it?.description ?? ""),
    sourcePath: typeof it?.sourcePath === "string" ? it.sourcePath : undefined,
    affectedPages: Array.isArray(it?.affectedPages) ? it.affectedPages.map(String) : undefined,
    searchQueries: Array.isArray(it?.searchQueries) ? it.searchQueries.map(String) : undefined,
    options: Array.isArray(it?.options)
      ? it.options.map((o) => ({ label: String(o?.label ?? ""), action: String(o?.action ?? "") }))
      : [],
    resolved: it?.resolved === true,
    resolvedAction: typeof it?.resolvedAction === "string" ? it.resolvedAction : undefined,
    createdAt: typeof it?.createdAt === "number" ? it.createdAt : 0,
  })

  let filtered = items.map(norm)
  if (status === "resolved") filtered = filtered.filter((r) => r.resolved)
  else if (status === "unresolved") filtered = filtered.filter((r) => !r.resolved)
  if (type) filtered = filtered.filter((r) => r.type === type)
  if (typeof limit === "number" && limit >= 0) filtered = filtered.slice(0, limit)

  return { status: status || "unresolved", reviews: filtered }
}

// GET /api/v2/projects/:id/reviews?status=&type=&limit=
router.get("/", validate({ query: ReviewQuerySchema }), async (req, res, next) => {
  try {
    const projectPath = req.projectRoot
    const { status, type, limit } = req.validated.query
    const { status: st, reviews } = loadReviews(projectPath, { status, type, limit })
    res.json({ projectId: req.projectId, status: st, count: reviews.length, reviews })
  } catch (err) {
    next(err)
  }
})

export default router
