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
  ChunkedUploadInitBodySchema,
  ChunkedUploadChunkQuerySchema,
} from "@llm-wiki/api-types"
import { safeJoin } from "../store/project-paths.js"
import { dispatch } from "../invoke.js"
import { emit } from "../events.js"
import { EventTypes } from "../events/bus.js"
import { ApiError, ErrorCode } from "../errors.js"
import {
  createChunkedUpload,
  getChunkedUpload,
  appendChunk,
  completeChunkedUpload,
  destroyChunkedUpload,
} from "../uploads/chunked.js"

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

// ── Chunked upload protocol (issue #14 P2, Decision 15 — charter §4.8) ────
// Large files (>10MB) upload through init → per-chunk PUTs → complete. Small
// files stay on the single-shot multipart route (POST /ingest/upload). The
// charter shapes are kept verbatim: {uploadId}, {received}, {path, size} —
// complete does NOT auto-enqueue; the client feeds the ingest pipeline via
// POST /api/v2/projects/:id/ingest (enqueue-by-path) right after complete.

// Resolve :uploadId to its session. Unknown/expired uploadIds AND sessions
// belonging to another project both answer NOT_FOUND (never leak another
// project's session existence).
function requireChunkedSession(req) {
  const session = getChunkedUpload(req.params.uploadId)
  if (!session || session.projectId !== req.projectId) {
    throw new ApiError(ErrorCode.NOT_FOUND, `Upload ${req.params.uploadId} not found`)
  }
  return session
}

// Read the raw octet-stream chunk body manually — express.json only consumes
// JSON content types, so the stream reaches the handler unread. Stops
// buffering the moment the accumulated bytes would exceed the session's
// remaining bytes; the route then answers 400 and destroys the request to
// abort the unconsumed tail.
function readChunkBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let length = 0
    let settled = false
    req.on("data", (chunk) => {
      if (settled) return
      length += chunk.length
      if (length > maxBytes) {
        settled = true
        reject(new ApiError(ErrorCode.VALIDATION_ERROR, "Chunk exceeds declared file size"))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on("error", (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

// POST /api/v2/projects/:id/files/upload/init — open a chunked-upload session
router.post("/upload/init", validate({ body: ChunkedUploadInitBodySchema }), async (req, res, next) => {
  try {
    const { fileName, fileSize, destPath } = req.validated.body
    const session = await createChunkedUpload({
      projectId: req.projectId,
      fileName,
      fileSize,
      destPath,
    })
    res.status(201).json({ uploadId: session.uploadId })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v2/projects/:id/files/upload/:uploadId/chunk?offset=N — append one
// octet-stream chunk (charter §4.8). RESUME CHANNEL: a wrong offset answers
// 400 VALIDATION_ERROR with details.received = the server's byte count, and
// the client resumes from there (uploads/chunked.js appendChunk). A 0-byte
// chunk is a no-op success that still validates the offset. The session is
// never mutated on failure.
router.put("/upload/:uploadId/chunk", validate({ query: ChunkedUploadChunkQuerySchema }), async (req, res, next) => {
  try {
    const session = requireChunkedSession(req)
    const { offset } = req.validated.query
    // RESUME CHANNEL FIRST: the offset check must run BEFORE the bounded body
    // read. A resent final chunk (response lost, all bytes already on disk)
    // overflows the zero remaining-bytes bound — if readChunkBody rejected
    // first, the 400 would carry no details.received and the client could
    // never resume. A mismatched offset answers 400 + details.received
    // immediately, without buffering the body. appendChunk re-checks the
    // offset inside its per-session chain, where a racing append may have
    // moved the count since this pre-check.
    if (offset !== session.received) {
      const err = new ApiError(
        ErrorCode.VALIDATION_ERROR,
        `Chunk offset ${offset} does not match server byte count`,
        { received: session.received },
      )
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details ?? null },
      })
      req.destroy()
      return
    }
    let buffer
    try {
      buffer = await readChunkBody(req, session.fileSize - session.received)
    } catch (err) {
      if (err instanceof ApiError) {
        // Overflow: answer 400 with the standard envelope, then destroy the
        // request so the oversize tail is not consumed.
        res.status(err.status).json({
          error: { code: err.code, message: err.message, details: err.details ?? null },
        })
        req.destroy()
        return
      }
      throw err
    }
    const received = await appendChunk(session, buffer, offset)
    res.json({ received })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/files/upload/:uploadId/complete — finalize the
// upload (charter §4.8): staging file → destPath (safeJoin containment),
// file:created/file:modified emit, session teardown. Responds {path, size};
// no taskId — enqueueing is the client's next call (enqueue-by-path).
router.post("/upload/:uploadId/complete", async (req, res, next) => {
  try {
    const session = requireChunkedSession(req)
    let result
    try {
      result = await completeChunkedUpload(session, req.projectRoot)
    } catch (err) {
      // VALIDATION_ERROR here is the "upload incomplete" precondition — the
      // session can still receive its missing chunks, so it stays alive.
      // Every other finalize failure is terminal: destPath is fixed at init,
      // so a finalize that failed can never succeed on retry — drop the
      // session + staging (the client re-uploads from byte 0). Fs errors map
      // to structured codes (EISDIR → VALIDATION_ERROR, ENOENT → NOT_FOUND);
      // ApiErrors pass through unchanged.
      if (!(err instanceof ApiError && err.code === ErrorCode.VALIDATION_ERROR)) {
        destroyChunkedUpload(session)
      }
      throw mapFsError(err)
    }
    res.json(result)
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
