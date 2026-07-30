// Files API router (Phase 2.3.4)
// Bridges v2 API to existing fs commands with project-relative paths.

import { Router } from "express"
import { validate } from "../middleware/validate.js"
import {
  FileTreeQuerySchema,
  FileContentQuerySchema,
  FileUploadBodySchema,
  FileDownloadQuerySchema,
  FileRawQuerySchema,
} from "../schemas/files.js"
import { resolveProjectRoot, safeJoin } from "../store/project-paths.js"
import { dispatch } from "../invoke.js"
import { ApiError, ErrorCode } from "../errors.js"

const router = Router({ mergeParams: true })

// Map low-level fs errors to structured API errors. A missing file/dir is a
// NOT_FOUND (not a 500); everything else is re-thrown for the global handler.
function mapFsError(err) {
  if (err instanceof ApiError) return err
  const code = err && err.code
  if (code === "ENOENT" || /no such file|does not exist/i.test(err?.message || "")) {
    return new ApiError(ErrorCode.NOT_FOUND, "File not found", { cause: err.message })
  }
  if (code === "EISDIR") {
    return new ApiError(ErrorCode.VALIDATION_ERROR, "Path is a directory", { cause: err.message })
  }
  return err
}

// GET /api/v2/projects/:id/files/tree?path=&includeHidden=&maxDepth=
router.get("/tree", validate({ query: FileTreeQuerySchema }), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const root = resolveProjectRoot(projectId)
    const { path: relPath, includeHidden, maxDepth } = req.validated.query
    const absPath = safeJoin(root, relPath)
    const tree = await dispatch("list_directory", { path: absPath, includeHidden, maxDepth })
    res.json({ tree })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/files/content?path=
router.get("/content", validate({ query: FileContentQuerySchema }), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const root = resolveProjectRoot(projectId)
    const absPath = safeJoin(root, req.validated.query.path)
    const content = await dispatch("read_file", { path: absPath })
    res.json({ content })
  } catch (err) {
    next(mapFsError(err))
  }
})

// POST /api/v2/projects/:id/files/upload
router.post("/upload", validate({ body: FileUploadBodySchema }), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const root = resolveProjectRoot(projectId)
    const { path: relPath, content, encoding } = req.validated.body
    const absPath = safeJoin(root, relPath)
    if (encoding === "base64") {
      await dispatch("write_file_base64", { path: absPath, base64: content })
    } else {
      await dispatch("write_file", { path: absPath, contents: content })
    }
    res.json({ success: true, path: relPath })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/files/download?path=
router.get("/download", validate({ query: FileDownloadQuerySchema }), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const root = resolveProjectRoot(projectId)
    const absPath = safeJoin(root, req.validated.query.path)
    const content = await dispatch("read_file", { path: absPath })
    const filename = req.validated.query.path.split("/").pop()
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.setHeader("Content-Type", "application/octet-stream")
    res.send(content)
  } catch (err) {
    next(mapFsError(err))
  }
})

// GET /api/v2/projects/:id/files/raw?path=
router.get("/raw", validate({ query: FileRawQuerySchema }), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const root = resolveProjectRoot(projectId)
    const absPath = safeJoin(root, req.validated.query.path)
    const content = await dispatch("read_file", { path: absPath })
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.send(content)
  } catch (err) {
    next(mapFsError(err))
  }
})

export default router
