// Ingest — /api/v2/projects/:id/ingest/*
//
// Issue #14 P0 stage 9: ingest is server-driven. The client only enqueues
// files, manages the queue over REST, and watches SSE (src/lib/sse-sync.ts).
// The :id segment accepts either the integer projects-table id or the client
// project UUID (WikiProject.id) — the web client passes the UUID.

import type {
  IngestTask,
  IngestQueueResponse,
  IngestUploadResponse,
  IngestEnqueueResponse,
} from "@llm-wiki/api-types"
import { request } from "./client"

export type IngestStatus = "pending" | "processing" | "completed" | "failed"

export type { IngestTask, IngestQueueResponse, IngestUploadResponse, IngestEnqueueResponse }

/** POST /api/v2/projects/:id/ingest/upload — multipart upload (field name: "file"). */
export function uploadForIngest(
  projectId: number | string,
  file: File,
): Promise<IngestUploadResponse> {
  const form = new FormData()
  form.append("file", file)
  return request<IngestUploadResponse>(`/api/v2/projects/${projectId}/ingest/upload`, {
    method: "POST",
    form,
  })
}

/**
 * POST /api/v2/projects/:id/ingest — enqueue a file that already exists in
 * the project by path. Server-side dedupe: when a pending/processing task
 * for the same file exists, its id is returned with `deduplicated: true`.
 * `filePath` is project-relative (e.g. "raw/sources/paper.pdf").
 */
export function enqueueByPath(
  projectId: number | string,
  filePath: string,
  folderContext?: string,
): Promise<IngestEnqueueResponse> {
  return request<IngestEnqueueResponse>(`/api/v2/projects/${projectId}/ingest`, {
    method: "POST",
    json: { filePath, folderContext },
  })
}

/** GET /api/v2/projects/:id/ingest/queue */
export function getQueue(
  projectId: number | string,
  opts: { status?: IngestStatus; limit?: number } = {},
): Promise<IngestQueueResponse> {
  return request<IngestQueueResponse>(`/api/v2/projects/${projectId}/ingest/queue`, {
    query: { status: opts.status, limit: opts.limit },
  })
}

/** POST /api/v2/projects/:id/ingest/queue/clear */
export function clearQueue(
  projectId: number | string,
  status?: IngestStatus,
): Promise<{ cleared: number }> {
  return request<{ cleared: number }>(`/api/v2/projects/${projectId}/ingest/queue/clear`, {
    method: "POST",
    json: { status },
  })
}

/** POST /api/v2/projects/:id/ingest/queue/:taskId/retry — manual retry of a failed task. */
export function retryTask(
  projectId: number | string,
  taskId: number,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/v2/projects/${projectId}/ingest/queue/${taskId}/retry`,
    { method: "POST" },
  )
}

/** DELETE /api/v2/projects/:id/ingest/queue/:taskId — cancel (abort + cleanup). */
export function cancelTask(projectId: number | string, taskId: number): Promise<void> {
  return request<void>(`/api/v2/projects/${projectId}/ingest/queue/${taskId}`, {
    method: "DELETE",
  })
}
