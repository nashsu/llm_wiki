import { z } from "zod"

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(100).optional().default(20),
  includeContent: z.boolean().optional().default(false),
})

export const SearchResultSchema = z.object({
  path: z.string(),
  score: z.number(),
  snippet: z.string().optional(),
  content: z.string().optional(),
})

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  mode: z.string(),
  tokenHits: z.number(),
  vectorHits: z.number(),
  graphHits: z.number(),
})
