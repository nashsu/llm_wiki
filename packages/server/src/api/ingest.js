// Ingest API router (Phase 2.3.8 + issue #14 P0 stage 8)
// Server-driven ingest: multipart file upload → raw/sources/, enqueue-by-path
// (re-ingest / clip-watcher / scheduled-import / chat Save-to-Wiki), and
// ingest-queue management (SQLite ingest_queue table) with SSE progress
// events. Every mutation kicks the orchestrator (ingest/orchestrator.js),
// which claims rows and runs the pipeline.
// req.projectId, req.projectRoot, and req.project are attached by the
// projectLookup middleware.

import { Router } from "express"
import multer from "multer"
import crypto from "node:crypto"
import fsp from "node:fs/promises"
import path from "node:path"
import { validate } from "../middleware/validate.js"
import {
  IngestQueueQuerySchema,
  IngestTaskIdParamSchema,
  IngestClearBodySchema,
  IngestEnqueueBodySchema,
} from "@llm-wiki/api-types"
import {
  enqueueIngestTask,
  getIngestTask,
  listIngestTasks,
  clearIngestTasks,
  retryIngestTask,
  findLiveIngestTask,
} from "../store/ingest-queue.js"
import { safeJoin } from "../store/project-paths.js"
import { kickIngestOrchestrator, cancelIngestTask } from "../ingest/orchestrator.js"
import { emit } from "../events.js"
import { ApiError, ErrorCode } from "../errors.js"

const router = Router({ mergeParams: true })

// Multipart upload: hold the file in memory (≤50MB), write it ourselves so we
// control the destination (raw/sources/) and filename sanitization.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

// POST /api/v2/projects/:id/ingest/upload — multipart field "file"
router.post("/upload", upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(ErrorCode.VALIDATION_ERROR, "No file provided (field 'file')")

    const originalName = req.file.originalname || "upload"
    const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, "_") || "upload"
    // Timestamp + crypto-random suffix: two uploads of the same file within
    // the same millisecond must not collide (desktop parity).
    const fileName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safeName}`

    const sourcesDir = path.join(req.project.path, "raw", "sources")
    await fsp.mkdir(sourcesDir, { recursive: true })
    const filePath = path.join(sourcesDir, fileName)
    await fsp.writeFile(filePath, req.file.buffer)

    const taskId = enqueueIngestTask(req.project.id, filePath)
    emit("ingest:queued", { projectId: req.project.id, taskId, filePath, fileName })
    kickIngestOrchestrator()

    res.status(201).json({ taskId, filePath, status: "pending" })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/ingest — enqueue a file that already exists in
// the project by path (re-ingest button, clip-watcher, scheduled-import,
// chat Save-to-Wiki). Dedupes against a live (pending/processing) task for
// the same project + resolved path. Relative paths resolve against the
// project root; anything escaping it is rejected (api/files.js pattern).
router.post("/", validate({ body: IngestEnqueueBodySchema }), async (req, res, next) => {
  try {
    const { filePath, folderContext } = req.validated.body
    const absPath = safeJoin(req.projectRoot, filePath) // FORBIDDEN on traversal
    let stat
    try {
      stat = await fsp.stat(absPath)
    } catch {
      throw new ApiError(ErrorCode.NOT_FOUND, `File not found: ${filePath}`)
    }
    if (!stat.isFile()) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, "Path is not a file")
    }

    const live = findLiveIngestTask(req.project.id, absPath)
    if (live) {
      return res.json({ taskId: live.id, deduplicated: true })
    }

    const taskId = enqueueIngestTask(req.project.id, absPath, { folderContext })
    emit("ingest:queued", {
      projectId: req.project.id,
      taskId,
      filePath: absPath,
      fileName: path.basename(absPath),
    })
    kickIngestOrchestrator()

    res.status(201).json({ taskId, filePath: absPath, status: "pending" })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/ingest/queue?status=&limit=
router.get("/queue", validate({ query: IngestQueueQuerySchema }), (req, res, next) => {
  try {
    const { status, limit } = req.validated.query
    const tasks = listIngestTasks(req.projectId, { status, limit })
    res.json({ tasks, count: tasks.length })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/ingest/queue/clear — body: { status? }
// (declared before /queue/:taskId so "clear" is not captured as a taskId)
router.post("/queue/clear", validate({ body: IngestClearBodySchema }), (req, res, next) => {
  try {
    const { status } = req.validated.body
    const cleared = clearIngestTasks(req.projectId, { status })
    res.json({ cleared })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/ingest/queue/:taskId/retry — manual retry of a
// FAILED task (resets attempts + error, re-kicks the orchestrator).
router.post("/queue/:taskId/retry", validate({ params: IngestTaskIdParamSchema }), (req, res, next) => {
  try {
    const { taskId } = req.validated.params
    const task = getIngestTask(taskId)
    if (!task || task.project_id !== req.projectId) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Ingest task ${taskId} not found`)
    }
    if (!retryIngestTask(taskId)) {
      // Semantically a conflict (only failed tasks are retryable), surfaced
      // with the VALIDATION_ERROR code + the message the client expects.
      const err = new ApiError(ErrorCode.VALIDATION_ERROR, "Task is not failed")
      err.status = 409
      throw err
    }
    kickIngestOrchestrator()
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/ingest/queue/:taskId
router.get("/queue/:taskId", validate({ params: IngestTaskIdParamSchema }), (req, res, next) => {
  try {
    const { taskId } = req.validated.params
    const task = getIngestTask(taskId)
    if (!task || task.project_id !== req.projectId) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Ingest task ${taskId} not found`)
    }
    res.json(task)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v2/projects/:id/ingest/queue/:taskId — cancel: abort in-flight
// runs, clean up written files + vector chunks, delete the row.
router.delete("/queue/:taskId", validate({ params: IngestTaskIdParamSchema }), async (req, res, next) => {
  try {
    const { taskId } = req.validated.params
    const task = getIngestTask(taskId)
    if (!task || task.project_id !== req.projectId) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Ingest task ${taskId} not found`)
    }
    const cancelled = await cancelIngestTask(taskId)
    if (!cancelled) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Ingest task ${taskId} not found`)
    }
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

export default router
