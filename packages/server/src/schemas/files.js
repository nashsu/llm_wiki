import { z } from "zod"

export const FileTreeQuerySchema = z.object({
  path: z.string().optional().default(""),
  includeHidden: z.coerce.boolean().optional().default(false),
  maxDepth: z.coerce.number().int().min(1).max(30).optional().default(30),
})

export const FileContentQuerySchema = z.object({
  path: z.string().min(1),
})

export const FileUploadBodySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf-8", "base64"]).optional().default("utf-8"),
})

export const FileDownloadQuerySchema = z.object({
  path: z.string().min(1),
})

export const FileRawQuerySchema = z.object({
  path: z.string().min(1),
})
