// Ingest — /api/v2/projects/:id/ingest/*

import { request } from "./client"

export type IngestStatus = "pending" | "processing" | "completed" | "failed"

export interface IngestTask {
  id: number
  project_id: number
  file_path: string
  status: string
  progress: number
  error: string | null
  created_at: number
}

export interface IngestQueueResponse {
  tasks: IngestTask[]
  count: number
}

export interface IngestUploadResponse {
  taskId: number
  filePath: string
  status: string
}

/** POST /api/v2/projects/:id/ingest/upload — multipart upload (field name: "file"). */
export function uploadForIngest(projectId: number, file: File): Promise<IngestUploadResponse> {
  const form = new FormData()
  form.append("file", file)
  return request<IngestUploadResponse>(`/api/v2/projects/${projectId}/ingest/upload`, {
    method: "POST",
    form,
  })
}

/** GET /api/v2/projects/:id/ingest/queue */
export function getQueue(
  projectId: number,
  opts: { status?: IngestStatus; limit?: number } = {},
): Promise<IngestQueueResponse> {
  return request<IngestQueueResponse>(`/api/v2/projects/${projectId}/ingest/queue`, {
    query: { status: opts.status, limit: opts.limit },
  })
}

/** POST /api/v2/projects/:id/ingest/queue/clear */
export function clearQueue(projectId: number, status?: IngestStatus): Promise<void> {
  return request<void>(`/api/v2/projects/${projectId}/ingest/queue/clear`, {
    method: "POST",
    json: { status },
  })
}
