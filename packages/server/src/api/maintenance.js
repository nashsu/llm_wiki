// Maintenance API router (Phase 2.3.12)
// Project maintenance operations: rebuild the wiki index, export/import the
// project archive, and list/restore file version history. Bridges to the
// existing maintenance + fileHistory commands, resolving the project id to its
// on-disk root. File-history paths are containment-checked via safeJoin.

import { Router } from "express"
import { validate } from "../middleware/validate.js"
import {
  ExportBodySchema,
  ImportBodySchema,
  FileHistoryQuerySchema,
  RestoreHistoryBodySchema,
} from "../schemas/maintenance.js"
import { resolveProjectRoot, safeJoin } from "../store/project-paths.js"
import { dispatch } from "../invoke.js"
import { listFileHistory, restoreFileHistory } from "../commands/fileHistory.js"

const router = Router({ mergeParams: true })

// POST /api/v2/projects/:id/maintenance/rebuild-index
router.post("/rebuild-index", async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const projectPath = resolveProjectRoot(projectId)
    const result = await dispatch("rebuild_wiki_index", { projectPath })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/maintenance/export — body: { destination }
router.post("/export", validate({ body: ExportBodySchema }), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const projectPath = resolveProjectRoot(projectId)
    const { destination } = req.validated.body
    await dispatch("export_project_archive", { projectPath, destination })
    res.json({ ok: true, destination })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/maintenance/import — body: { archivePath, destination }
router.post("/import", validate({ body: ImportBodySchema }), async (req, res, next) => {
  try {
    const { archivePath, destination } = req.validated.body
    const root = await dispatch("import_project_archive", { archivePath, destination })
    res.json({ ok: true, root })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/maintenance/file-history?path=
router.get("/file-history", validate({ query: FileHistoryQuerySchema }), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const projectPath = resolveProjectRoot(projectId)
    const filePath = safeJoin(projectPath, req.validated.query.path)
    const entries = listFileHistory({ projectPath, filePath })
    res.json({ history: entries })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/maintenance/file-history/restore — body: { path, entryId }
router.post(
  "/file-history/restore",
  validate({ body: RestoreHistoryBodySchema }),
  async (req, res, next) => {
    try {
      const projectId = parseInt(req.params.id, 10)
      const projectPath = resolveProjectRoot(projectId)
      const { path: relPath, entryId } = req.validated.body
      const filePath = safeJoin(projectPath, relPath)
      const content = restoreFileHistory({ projectPath, filePath, entryId })
      res.json({ ok: true, content })
    } catch (err) {
      next(err)
    }
  }
)

export default router
