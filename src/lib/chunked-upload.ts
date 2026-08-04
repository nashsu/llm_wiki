// Chunked-upload client (issue #14 P2, Decision 15 — charter §4.8).
//
// Files dispatch by size: ≤ MULTIPART_MAX_BYTES (10 MB) stays on the
// single-shot multipart route (uploadForIngest, which auto-enqueues); larger
// files take the chunked protocol under the files router:
//   POST /files/upload/init            → {uploadId}
//   PUT  /files/upload/:id/chunk?offset=N (octet-stream) → {received}
//   POST /files/upload/:id/complete    → {path, size}
// then the client feeds the ingest pipeline via enqueue-by-path (the server's
// complete does NOT auto-enqueue — plans/chunked-upload.md).
//
// Chunk PUTs use raw fetch with a Bearer header — the same precedent as
// downloadFile in src/api/files.ts — because request() only supports JSON and
// FormData bodies (no raw body mode).
//
// RESUME CHANNEL: the server answers an offset-mismatched PUT with 400
// VALIDATION_ERROR + details.received = its byte count. After an ambiguous
// network drop the client cannot know whether the last chunk landed, so it
// adopts the server count as the resume point and re-slices from there.

import type {
  ChunkedUploadChunkResponse,
  ChunkedUploadCompleteResponse,
  ChunkedUploadInitBody,
  ChunkedUploadInitResponse,
  IngestEnqueueResponse,
} from "@llm-wiki/api-types"
import { ApiError, getToken, parseError, request, resolveUrl } from "@/api/client"
import { enqueueByPath, uploadForIngest } from "@/api/ingest"

/** Chunk size for the chunked protocol (charter §4.8). */
export const CHUNK_SIZE = 5 * 1024 * 1024

/** Charter §4.8 threshold: ≤10 MB single-shot multipart, >10 MB chunked. */
export const MULTIPART_MAX_BYTES = 10 * 1024 * 1024

/** Per-chunk attempts before the whole upload fails. */
const MAX_CHUNK_ATTEMPTS = 3

/** Base delay between chunk retries; multiplied by the attempt number. */
const RETRY_BACKOFF_MS = 250

export interface UploadFileAutoOptions {
  /** Called with the server-confirmed byte count after each step. */
  onProgress?: (sent: number, total: number) => void
  /** Aborts in-flight requests; an aborted upload is not retried. */
  signal?: AbortSignal
}

/** POST /api/v2/projects/:id/files/upload/init — open a chunked-upload session. */
export function chunkedUploadInit(
  projectId: number | string,
  body: ChunkedUploadInitBody,
): Promise<ChunkedUploadInitResponse> {
  return request<ChunkedUploadInitResponse>(
    `/api/v2/projects/${projectId}/files/upload/init`,
    { method: "POST", json: body },
  )
}

/**
 * PUT /api/v2/projects/:id/files/upload/:uploadId/chunk?offset=N — send one
 * octet-stream chunk. Non-2xx rejects with the parsed ApiError envelope: a
 * 400 carries details.received = the server's byte count (the resume
 * channel). Raw fetch, following the files.ts download precedent.
 */
export async function chunkedUploadPutChunk(
  projectId: number | string,
  uploadId: string,
  offset: number,
  blob: Blob,
  signal?: AbortSignal,
): Promise<ChunkedUploadChunkResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(
    resolveUrl(`/api/v2/projects/${projectId}/files/upload/${uploadId}/chunk`, { offset }),
    { method: "PUT", headers, body: blob, signal },
  )
  if (!res.ok) throw await parseError(res)
  return res.json() as Promise<ChunkedUploadChunkResponse>
}

/** POST /api/v2/projects/:id/files/upload/:uploadId/complete — finalize the session. */
export function chunkedUploadComplete(
  projectId: number | string,
  uploadId: string,
): Promise<ChunkedUploadCompleteResponse> {
  return request<ChunkedUploadCompleteResponse>(
    `/api/v2/projects/${projectId}/files/upload/${uploadId}/complete`,
    { method: "POST" },
  )
}

/**
 * Upload a file, dispatching by size (charter §4.8):
 *  - ≤ MULTIPART_MAX_BYTES → the existing one-shot multipart route
 *    (uploadForIngest), which auto-enqueues into the ingest queue.
 *  - otherwise → init → CHUNK_SIZE octet-stream PUTs → complete →
 *    enqueueByPath, returning the enqueue response ({taskId, ...}).
 *
 * Per-chunk retry: up to MAX_CHUNK_ATTEMPTS attempts with short backoff. A
 * 400 whose details.received carries the server's byte count adopts that
 * count as the resume point and continues from it (resume channel).
 *
 * Note: the multipart branch resolves with an IngestUploadResponse, which is
 * structurally a subset of IngestEnqueueResponse ({taskId, filePath, status}).
 */
export async function uploadFileAuto(
  projectId: number | string,
  file: File,
  opts: UploadFileAutoOptions = {},
): Promise<IngestEnqueueResponse> {
  const { onProgress, signal } = opts

  if (file.size <= MULTIPART_MAX_BYTES) {
    const res = await uploadForIngest(projectId, file)
    onProgress?.(file.size, file.size)
    return res
  }

  const destPath = buildDestPath(file.name)
  const { uploadId } = await chunkedUploadInit(projectId, {
    fileName: file.name,
    fileSize: file.size,
    destPath,
  })

  // `offset` always equals the byte count the server has confirmed. Each
  // iteration PUTs one CHUNK_SIZE (or smaller final) slice at that offset.
  let offset = 0
  while (offset < file.size) {
    offset = await putChunkWithRetry(projectId, uploadId, file, offset, signal)
    onProgress?.(offset, file.size)
  }

  const complete = await chunkedUploadComplete(projectId, uploadId)
  // complete does not auto-enqueue — feed the ingest pipeline through the
  // existing enqueue-by-path route (plans/chunked-upload.md).
  return enqueueByPath(projectId, complete.path)
}

/**
 * PUT one chunk at `startOffset` with retry + resume. Returns the
 * server-confirmed byte count after the chunk lands (the next offset).
 */
async function putChunkWithRetry(
  projectId: number | string,
  uploadId: string,
  file: File,
  startOffset: number,
  signal?: AbortSignal,
): Promise<number> {
  let offset = startOffset
  let lastError: unknown = null
  let needsBackoff = false

  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    // Back off only after non-resume failures; a resume signal means the
    // server is healthy and the corrected offset should be tried right away.
    if (attempt > 1 && needsBackoff) {
      await sleep(RETRY_BACKOFF_MS * (attempt - 1), signal)
    }
    const end = Math.min(offset + CHUNK_SIZE, file.size)
    try {
      const { received } = await chunkedUploadPutChunk(
        projectId,
        uploadId,
        offset,
        file.slice(offset, end),
        signal,
      )
      return received
    } catch (err) {
      // An aborted upload is never retried.
      if (signal?.aborted) throw err
      lastError = err
      const serverReceived = serverReceivedFromError(err)
      if (serverReceived !== null) {
        // RESUME CHANNEL: the server's byte count is authoritative (happens
        // after ambiguous network drops). Adopt it and re-slice from there.
        offset = serverReceived
        if (offset >= file.size) {
          // The server already has every byte (e.g. the final chunk landed
          // but its response was lost): nothing left to resend — return and
          // let the loop fall through to complete.
          return offset
        }
        needsBackoff = false
      } else {
        needsBackoff = true
      }
    }
  }
  throw lastError
}

/**
 * Extract the resume byte count from an offset-mismatch error: the server
 * answers 400 VALIDATION_ERROR with details.received (uploads/chunked.js
 * appendChunk). Anything else (including other 400s) returns null.
 */
function serverReceivedFromError(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null
  const details = err.details
  if (details && typeof details === "object") {
    const received = (details as { received?: unknown }).received
    if (typeof received === "number" && Number.isInteger(received) && received >= 0) {
      return received
    }
  }
  return null
}

/** Eight random hex chars via crypto.getRandomValues (browser + node). */
function randomHex8(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Project-relative destination path for a chunked upload. Mirrors the server
 * naming of the multipart route (packages/server/src/api/ingest.js):
 * `raw/sources/<ts>_<hex8>_<sanitized basename>`.
 */
function buildDestPath(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName
  const safeName = base.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload"
  return `raw/sources/${Date.now()}_${randomHex8()}_${safeName}`
}

/** Abortable sleep for retry backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("Aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
