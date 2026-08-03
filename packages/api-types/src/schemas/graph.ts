import { z } from "zod"

export const GraphQuerySchema = z.object({
  q: z.string().optional(),
  nodeType: z.string().optional(),
  limit: z.coerce.number().int().min(0).optional(),
})

export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  nodeType: z.string(),
  path: z.string(),
  linkCount: z.number(),
  weight: z.number(),
})

export const GraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  weight: z.number(),
})

export const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
})

export type GraphQuery = z.infer<typeof GraphQuerySchema>
export type GraphNode = z.infer<typeof GraphNodeSchema>
export type GraphEdge = z.infer<typeof GraphEdgeSchema>
export type GraphResponse = z.infer<typeof GraphResponseSchema>
