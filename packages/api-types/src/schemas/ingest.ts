import { z } from "zod"

export const IngestQueueQuerySchema = z.object({
  status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

export const IngestTaskIdParamSchema = z.object({
  taskId: z.coerce.number().int().positive(),
})

export const IngestClearBodySchema = z.object({
  status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
})

export const IngestTaskSchema = z.object({
  id: z.number(),
  project_id: z.number(),
  file_path: z.string(),
  status: z.string(),
  progress: z.number(),
  error: z.string().nullable(),
  created_at: z.number(),
  // Migration 013 (server-driven ingest, issue #14 P0): lifecycle accounting.
  attempt_count: z.number().default(0),
  started_at: z.number().nullable().optional(),
  updated_at: z.number().nullable().optional(),
  not_before: z.number().default(0),
  folder_context: z.string().default(""),
})

export const IngestQueueResponseSchema = z.object({
  tasks: z.array(IngestTaskSchema),
  count: z.number(),
})

export const IngestUploadResponseSchema = z.object({
  taskId: z.number(),
  filePath: z.string(),
  status: z.string(),
})

// POST /api/v2/projects/:id/ingest — enqueue a file that already exists in the
// project (re-ingest, clip-watcher, scheduled import, chat Save-to-Wiki).
export const IngestEnqueueBodySchema = z.object({
  filePath: z.string().min(1),
  folderContext: z.string().optional().default(""),
})

export const IngestEnqueueResponseSchema = z.object({
  taskId: z.number(),
  filePath: z.string(),
  status: z.string(),
  deduplicated: z.boolean().optional(),
})

export type IngestQueueQuery = z.infer<typeof IngestQueueQuerySchema>
export type IngestTaskIdParam = z.infer<typeof IngestTaskIdParamSchema>
export type IngestClearBody = z.infer<typeof IngestClearBodySchema>
export type IngestTask = z.infer<typeof IngestTaskSchema>
export type IngestQueueResponse = z.infer<typeof IngestQueueResponseSchema>
export type IngestUploadResponse = z.infer<typeof IngestUploadResponseSchema>
export type IngestEnqueueBody = z.infer<typeof IngestEnqueueBodySchema>
export type IngestEnqueueResponse = z.infer<typeof IngestEnqueueResponseSchema>
