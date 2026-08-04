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

// ── Chunked upload protocol (issue #14 P2, Decision 15, §4.8) ─────────────
// Large files (>10MB) take the charter's chunked protocol under the files
// router: init → per-chunk octet-stream PUTs → complete. Charter shapes are
// kept verbatim ({uploadId}, {received}, {path, size}).

export const ChunkedUploadInitBodySchema = z.object({
  fileName: z.string().min(1),
  fileSize: z.number().int().positive(),
  destPath: z.string().min(1),
})

export const ChunkedUploadInitResponseSchema = z.object({
  uploadId: z.string(),
})

export const ChunkedUploadChunkQuerySchema = z.object({
  offset: z.coerce.number().int().min(0),
})

export const ChunkedUploadChunkResponseSchema = z.object({
  received: z.number().int().min(0),
})

export const ChunkedUploadCompleteResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().min(0),
})

export type FileTreeQuery = z.infer<typeof FileTreeQuerySchema>
export type FileContentQuery = z.infer<typeof FileContentQuerySchema>
export type FileUploadBody = z.infer<typeof FileUploadBodySchema>
export type FileDownloadQuery = z.infer<typeof FileDownloadQuerySchema>
export type FileRawQuery = z.infer<typeof FileRawQuerySchema>
export type ChunkedUploadInitBody = z.infer<typeof ChunkedUploadInitBodySchema>
export type ChunkedUploadInitResponse = z.infer<typeof ChunkedUploadInitResponseSchema>
export type ChunkedUploadChunkQuery = z.infer<typeof ChunkedUploadChunkQuerySchema>
export type ChunkedUploadChunkResponse = z.infer<typeof ChunkedUploadChunkResponseSchema>
export type ChunkedUploadCompleteResponse = z.infer<typeof ChunkedUploadCompleteResponseSchema>
