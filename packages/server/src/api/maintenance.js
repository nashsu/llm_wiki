// Maintenance API router (Phase 2.3.12)
// Project maintenance operations: rebuild the wiki index, export/import the
// project archive, and list/restore file version history. Bridges to the
// existing maintenance + fileHistory commands.
// req.projectId, req.projectRoot, and req.project are attached by the
// projectLookup middleware (middleware/project-lookup.js).

import { Router } from "express"
import { validate } from "../middleware/validate.js"
import {
  ExportBodySchema,
  ImportBodySchema,
  FileHistoryQuerySchema,
  RestoreHistoryBodySchema,
} from "@llm-wiki/api-types"
import { safeJoin } from "../store/project-paths.js"
import { dispatch } from "../invoke.js"
import { listFileHistory, restoreFileHistory } from "../commands/fileHistory.js"

const router = Router({ mergeParams: true })

// POST /api/v2/projects/:id/maintenance/rebuild-index
router.post("/rebuild-index", async (req, res, next) => {
  try {
    const result = await dispatch("rebuild_wiki_index", { projectPath: req.projectRoot })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/maintenance/export — body: { destination }
router.post("/export", validate({ body: ExportBodySchema }), async (req, res, next) => {
  try {
    const { destination } = req.validated.body
    await dispatch("export_project_archive", { projectPath: req.projectRoot, destination })
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
    const filePath = safeJoin(req.projectRoot, req.validated.query.path)
    const entries = listFileHistory({ projectPath: req.projectRoot, filePath })
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
      const { path: relPath, entryId } = req.validated.body
      const filePath = safeJoin(req.projectRoot, relPath)
      const content = restoreFileHistory({ projectPath: req.projectRoot, filePath, entryId })
      res.json({ ok: true, content })
    } catch (err) {
      next(err)
    }
  }
)

export default router
