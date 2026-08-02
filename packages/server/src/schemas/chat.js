import { z } from "zod"

export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  sessionId: z.string().optional(),
  mode: z.enum(["standard", "deep"]).optional().default("standard"),
  tools: z.object({
    wiki: z.boolean().optional().default(true),
    web: z.boolean().optional().default(false),
    anytxt: z.boolean().optional().default(false),
  }).optional(),
  topK: z.number().int().min(1).max(50).optional().default(5),
  includeContent: z.boolean().optional().default(false),
  skills: z.array(z.string()).optional().default([]),
  history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).optional().default([]),
})

export const ChatStartResponseSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
})

export const ChatCancelParamsSchema = z.object({
  runId: z.string().min(1),
})

export const ChatSessionParamsSchema = z.object({
  sessionId: z.string().min(1),
})
