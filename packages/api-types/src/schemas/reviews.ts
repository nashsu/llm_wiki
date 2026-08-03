import { z } from "zod"

export const ReviewQuerySchema = z.object({
  status: z.enum(["resolved", "unresolved"]).optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(0).optional(),
})

export const ReviewItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  description: z.string(),
  sourcePath: z.string().optional(),
  affectedPages: z.array(z.string()).optional(),
  searchQueries: z.array(z.string()).optional(),
  options: z.array(z.object({
    label: z.string(),
    action: z.string(),
  })),
  resolved: z.boolean(),
  resolvedAction: z.string().optional(),
  createdAt: z.number(),
})

export const ReviewListResponseSchema = z.object({
  projectId: z.number(),
  status: z.string(),
  count: z.number(),
  reviews: z.array(ReviewItemSchema),
})

export type ReviewQuery = z.infer<typeof ReviewQuerySchema>
export type ReviewItem = z.infer<typeof ReviewItemSchema>
export type ReviewListResponse = z.infer<typeof ReviewListResponseSchema>
