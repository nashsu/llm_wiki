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
