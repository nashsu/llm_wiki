// Files API router (Phase 2.3.4)
// Bridges v2 API to existing fs commands with project-relative paths.
// req.projectId, req.projectRoot, and req.project are attached by the
// projectLookup middleware (middleware/project-lookup.js).

import { Router } from "express"
import fsp from "node:fs/promises"
import { validate } from "../middleware/validate.js"
import {
  FileTreeQuerySchema,
  FileContentQuerySchema,
  FileUploadBodySchema,
  FileDownloadQuerySchema,
  FileRawQuerySchema,
} from "@llm-wiki/api-types"
import { safeJoin } from "../store/project-paths.js"
import { dispatch } from "../invoke.js"
import { emit } from "../events.js"
import { EventTypes } from "../events/bus.js"
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
    const { path: relPath, includeHidden, maxDepth } = req.validated.query
    const absPath = safeJoin(req.projectRoot, relPath)
    const tree = await dispatch("list_directory", { path: absPath, includeHidden, maxDepth })
    res.json({ tree })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/files/content?path=
router.get("/content", validate({ query: FileContentQuerySchema }), async (req, res, next) => {
  try {
    const absPath = safeJoin(req.projectRoot, req.validated.query.path)
    const content = await dispatch("read_file", { path: absPath })
    res.json({ content })
  } catch (err) {
    next(mapFsError(err))
  }
})

// POST /api/v2/projects/:id/files/upload
router.post("/upload", validate({ body: FileUploadBodySchema }), async (req, res, next) => {
  try {
    const { path: relPath, content, encoding } = req.validated.body
    const absPath = safeJoin(req.projectRoot, relPath)
    // Pre-write existence check decides created vs modified
    // (plans/sse-taxonomy.md). A directory here fails the write below, so
    // only an existing FILE counts as "existed".
    const existed = await fsp.stat(absPath).then((s) => s.isFile(), () => false)
    // suppressFileEvents: this route emits its own frame below (project-
    // relative path + size + req.projectId), and the stage-3 writer-level
    // emit must not duplicate it (plans/sse-taxonomy.md stage 3).
    if (encoding === "base64") {
      await dispatch("write_file_base64", { path: absPath, base64: content, suppressFileEvents: true })
    } else {
      await dispatch("write_file", { path: absPath, contents: content, suppressFileEvents: true })
    }
    // Attribution rides in the payload (emit() bridge envelope keeps
    // projectId null — same shape as ingest:*).
    emit(existed ? EventTypes.FILE_MODIFIED : EventTypes.FILE_CREATED, {
      projectId: req.projectId,
      path: relPath,
      size: Buffer.byteLength(content, encoding === "base64" ? "base64" : "utf-8"),
    })
    res.json({ success: true, path: relPath })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/files/download?path=
router.get("/download", validate({ query: FileDownloadQuerySchema }), async (req, res, next) => {
  try {
    const absPath = safeJoin(req.projectRoot, req.validated.query.path)
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
    const absPath = safeJoin(req.projectRoot, req.validated.query.path)
    const content = await dispatch("read_file", { path: absPath })
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.send(content)
  } catch (err) {
    next(mapFsError(err))
  }
})

export default router
