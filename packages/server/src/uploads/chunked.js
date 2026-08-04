// Chunked-upload session store (issue #14 P2, Decision 15 — charter §4.8).
//
// Large files (>10MB) upload through init → chunk PUTs → complete. Sessions
// live in an in-memory Map keyed by a random uploadId; chunk bytes accumulate
// in a staging file under DATA_DIR/upload-staging/ so half-written bytes never
// appear in the project tree (and never sit whole-file in process memory).
//
// Known accepted degradations (plans/chunked-upload.md):
//   - Server restart drops in-flight sessions; the client re-uploads from 0.
//   - No abort/cancel endpoint; abandoned sessions die with the 24h TTL sweep.

import crypto from "node:crypto"
import path from "node:path"
import fsp from "node:fs/promises"
import { createReadStream, createWriteStream } from "node:fs"
import { pipeline } from "node:stream/promises"
import { DATA_DIR, MAX_UPLOAD_BYTES } from "../config.js"
import { safeJoin } from "../store/project-paths.js"
import { emit } from "../events.js"
import { EventTypes } from "../events/bus.js"
import { ApiError, ErrorCode } from "../errors.js"

/** Sessions idle longer than this are swept (TTL runs off last activity). */
export const CHUNKED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

/** How often the sweeper drops expired sessions + unlinks their staging. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/** uploadId → session (in-memory only; restarts drop sessions by design). */
const sessions = new Map()

let sweepTimer = null

/**
 * Directory holding `<uploadId>.part` staging files. Created lazily on the
 * first init so a server that never sees a chunked upload touches nothing.
 */
function stagingDir() {
  return path.join(DATA_DIR, "upload-staging")
}

/**
 * Open a new chunked-upload session.
 * @param {object} opts
 * @param {number} opts.projectId projects-table id the upload belongs to
 * @param {string} opts.fileName client-reported original file name
 * @param {number} opts.fileSize total declared size in bytes
 * @param {string} opts.destPath project-relative destination path
 * @returns {Promise<object>} the created session
 */
export async function createChunkedUpload({ projectId, fileName, fileSize, destPath }) {
  if (fileSize > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      ErrorCode.FILE_TOO_LARGE,
      `File exceeds the maximum upload size (${MAX_UPLOAD_BYTES} bytes)`,
    )
  }
  await fsp.mkdir(stagingDir(), { recursive: true })
  const uploadId = crypto.randomUUID()
  const now = Date.now()
  const session = {
    uploadId,
    projectId,
    fileName,
    fileSize,
    destPath,
    received: 0,
    stagingPath: path.join(stagingDir(), `${uploadId}.part`),
    createdAt: now,
    lastActivityAt: now,
  }
  sessions.set(uploadId, session)
  return session
}

/**
 * Look up a session by uploadId.
 * @param {string} uploadId
 * @returns {object|undefined} the session, or undefined when unknown/expired
 */
export function getChunkedUpload(uploadId) {
  return sessions.get(uploadId)
}

/**
 * Append one chunk to the session's staging file (strictly sequential).
 *
 * RESUME CHANNEL: an offset that does not equal the server's byte count
 * answers 400 VALIDATION_ERROR with `details: { received }` — the client
 * resumes from that byte count. This covers reconnect-after-ambiguity and
 * plain offset bugs without an un-chartered status endpoint.
 *
 * @param {object} session
 * @param {Buffer} buffer raw chunk bytes (may be empty — a no-op success)
 * @param {number} offset client-reported byte offset of this chunk
 * @returns {Promise<number>} total bytes received after this chunk
 */
export async function appendChunk(session, buffer, offset) {
  if (offset !== session.received) {
    throw new ApiError(
      ErrorCode.VALIDATION_ERROR,
      `Chunk offset ${offset} does not match server byte count`,
      { received: session.received },
    )
  }
  if (session.received + buffer.length > session.fileSize) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, "Chunk exceeds declared file size")
  }
  if (buffer.length > 0) {
    const handle = await fsp.open(session.stagingPath, "a")
    try {
      await handle.write(buffer)
    } finally {
      await handle.close()
    }
  }
  session.received += buffer.length
  session.lastActivityAt = Date.now()
  return session.received
}

/**
 * Finalize a fully-received upload: resolve destPath inside the project,
 * copy staging → same-dir tmp → rename onto dest (atomic write; copy, not
 * rename, because DATA_DIR may be another device), emit file:created /
 * file:modified, then drop the session and its staging file.
 *
 * @param {object} session
 * @param {string} projectRoot absolute project root for containment
 * @returns {Promise<{path: string, size: number}>} project-relative path + size
 */
export async function completeChunkedUpload(session, projectRoot) {
  if (session.received !== session.fileSize) {
    throw new ApiError(
      ErrorCode.VALIDATION_ERROR,
      `Upload incomplete: received ${session.received} of ${session.fileSize} bytes`,
    )
  }
  const absDest = safeJoin(projectRoot, session.destPath) // FORBIDDEN on escape
  await fsp.mkdir(path.dirname(absDest), { recursive: true })
  // Pre-write existence check decides created vs modified (plans/sse-taxonomy.md
  // pattern). A directory here fails the rename below, so only an existing
  // FILE counts as "existed".
  const existed = await fsp.stat(absDest).then((s) => s.isFile(), () => false)

  const tmpPath = `${absDest}.${process.pid}.${Date.now()}.tmp`
  try {
    // Stream copy (rename across devices would fail — DATA_DIR may live on
    // another filesystem), then rename onto dest in the same directory.
    await pipeline(createReadStream(session.stagingPath), createWriteStream(tmpPath))
    await fsp.rename(tmpPath, absDest)
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {})
    throw err
  }

  // Attribution rides in the payload (emit() bridge envelope keeps projectId
  // null — same shape as the other file:* sites).
  emit(existed ? EventTypes.FILE_MODIFIED : EventTypes.FILE_CREATED, {
    projectId: session.projectId,
    path: session.destPath,
    size: session.fileSize,
  })

  destroyChunkedUpload(session)
  return { path: session.destPath, size: session.fileSize }
}

/**
 * Drop a session and best-effort unlink its staging file (cleanup helper —
 * used by complete, the TTL sweep, and tests).
 * @param {object} session
 */
export function destroyChunkedUpload(session) {
  sessions.delete(session.uploadId)
  fsp.unlink(session.stagingPath).catch(() => {})
}

/** Drop sessions idle past the TTL and unlink their staging files. */
export function sweepExpiredChunkedUploads() {
  const now = Date.now()
  for (const session of sessions.values()) {
    if (now - session.lastActivityAt > CHUNKED_UPLOAD_TTL_MS) {
      destroyChunkedUpload(session)
    }
  }
}

/**
 * Start the TTL sweep timer (idempotent). Called ONLY from the index-v2 boot
 * block, like startIngestOrchestrator — test imports of `app` never start it.
 */
export function startChunkedUploadSweeper() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => sweepExpiredChunkedUploads(), SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

/** Test hook: drop every session + staging file and stop the sweeper. */
export function __resetChunkedUploadsForTests() {
  for (const session of sessions.values()) {
    destroyChunkedUpload(session)
  }
  sessions.clear()
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
