// Ingest API router (Phase 2.3.8)
// Server-driven ingest foundation: multipart file upload → raw/sources/, plus
// ingest-queue management (SQLite ingest_queue table) and SSE progress events.
// The upload writes the source file and enqueues a task; the full processing
// pipeline (preprocess → LLM → wiki pages) runs on the worker pool (Phase 2.4)
// and reports progress via the shared SSE bus. Queue CRUD lets the client track
// and manage pending ingest work.

import { Router } from "express"
import multer from "multer"
import fsp from "node:fs/promises"
import path from "node:path"
import { validate } from "../middleware/validate.js"
import {
  IngestQueueQuerySchema,
  IngestTaskIdParamSchema,
  IngestClearBodySchema,
} from "../schemas/ingest.js"
import { resolveProjectRoot } from "../store/project-paths.js"
import { getProject } from "../store/projects.js"
import {
  enqueueIngestTask,
  getIngestTask,
  listIngestTasks,
  deleteIngestTask,
  clearIngestTasks,
} from "../store/ingest-queue.js"
import { emit } from "../events.js"
import { ApiError, ErrorCode } from "../errors.js"

const router = Router({ mergeParams: true })

// Multipart upload: hold the file in memory (≤50MB), write it ourselves so we
// control the destination (raw/sources/) and filename sanitization.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

// Resolve :id → project row (throws NOT_FOUND). Shared by all handlers.
function projectOrThrow(id) {
  const project = getProject(id)
  if (!project) throw new ApiError(ErrorCode.NOT_FOUND, "Project not found")
  return project
}

// POST /api/v2/projects/:id/ingest/upload — multipart field "file"
router.post("/upload", upload.single("file"), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const project = projectOrThrow(projectId)
    resolveProjectRoot(projectId) // ensure the project dir exists on disk

    if (!req.file) throw new ApiError(ErrorCode.VALIDATION_ERROR, "No file provided (field 'file')")

    const originalName = req.file.originalname || "upload"
    const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, "_") || "upload"
    const fileName = `${Date.now()}_${safeName}`

    const sourcesDir = path.join(project.path, "raw", "sources")
    await fsp.mkdir(sourcesDir, { recursive: true })
    const filePath = path.join(sourcesDir, fileName)
    await fsp.writeFile(filePath, req.file.buffer)

    const taskId = enqueueIngestTask(project.id, filePath)
    emit("ingest:queued", { projectId: project.id, taskId, filePath, fileName })

    res.status(201).json({ taskId, filePath, status: "pending" })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/ingest/queue?status=&limit=
router.get("/queue", validate({ query: IngestQueueQuerySchema }), (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    projectOrThrow(projectId)
    const { status, limit } = req.validated.query
    const tasks = listIngestTasks(projectId, { status, limit })
    res.json({ tasks, count: tasks.length })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/ingest/queue/clear — body: { status? }
// (declared before /queue/:taskId so "clear" is not captured as a taskId)
router.post("/queue/clear", validate({ body: IngestClearBodySchema }), (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    projectOrThrow(projectId)
    const { status } = req.validated.body
    const cleared = clearIngestTasks(projectId, { status })
    res.json({ cleared })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/projects/:id/ingest/queue/:taskId
router.get("/queue/:taskId", validate({ params: IngestTaskIdParamSchema }), (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    projectOrThrow(projectId)
    const { taskId } = req.validated.params
    const task = getIngestTask(taskId)
    if (!task || task.project_id !== projectId) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Ingest task ${taskId} not found`)
    }
    res.json(task)
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v2/projects/:id/ingest/queue/:taskId
router.delete("/queue/:taskId", validate({ params: IngestTaskIdParamSchema }), (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    projectOrThrow(projectId)
    const { taskId } = req.validated.params
    const task = getIngestTask(taskId)
    if (!task || task.project_id !== projectId) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Ingest task ${taskId} not found`)
    }
    deleteIngestTask(taskId)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

export default router
