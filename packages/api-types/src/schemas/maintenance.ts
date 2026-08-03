import { z } from "zod"

// POST /maintenance/rebuild-index — no body
export const RebuildIndexResponseSchema = z.object({
  pages: z.number(),
  groups: z.number(),
})

// POST /maintenance/export — body: { destination }
export const ExportBodySchema = z.object({
  destination: z.string().min(1),
})

// POST /maintenance/import — body: { archivePath, destination }
export const ImportBodySchema = z.object({
  archivePath: z.string().min(1),
  destination: z.string().min(1),
})

// GET /maintenance/file-history?path=
export const FileHistoryQuerySchema = z.object({
  path: z.string().min(1),
})

// POST /maintenance/file-history/restore — body: { path, entryId }
export const RestoreHistoryBodySchema = z.object({
  path: z.string().min(1),
  entryId: z.string().min(1),
})

export type RebuildIndexResponse = z.infer<typeof RebuildIndexResponseSchema>
export type ExportBody = z.infer<typeof ExportBodySchema>
export type ImportBody = z.infer<typeof ImportBodySchema>
export type FileHistoryQuery = z.infer<typeof FileHistoryQuerySchema>
export type RestoreHistoryBody = z.infer<typeof RestoreHistoryBodySchema>
