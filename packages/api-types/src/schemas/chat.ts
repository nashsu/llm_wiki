// Zod schemas for the chat API (issue #21: server-side session persistence).
//
// Session/message shapes are the wire contract for the chat_sessions /
// chat_messages writers (V1_CHARTERED_ARCHITECTURE.md §4.3). The session id on
// the wire is the session's UUID text — stable across client and server, so
// the client can keep its locally generated conversation ids.

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
  // Issue #21: history is no longer client-held. The server loads prior
  // messages from chat_messages by sessionId. Three knobs remain:
  // - resume: marks an approval-boundary re-send; the user message is already
  //   persisted from the original turn, so the server must not persist it again.
  // - regenerate: the client is re-running the last user turn. The server
  //   drops the session's last user/assistant exchange before running, so the
  //   re-persisted user message and the fresh answer replace the old pair.
  // - historyLimit: how many prior messages the agent loop feeds the model.
  resume: z.boolean().optional().default(false),
  regenerate: z.boolean().optional().default(false),
  historyLimit: z.number().int().min(1).max(100).optional(),
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

// ── session management ──────────────────────────────────────────────────

export const ChatSessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.number().int(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const ChatMessageSchema = z.object({
  id: z.number().int(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  references: z.array(z.record(z.string(), z.unknown())).optional(),
  createdAt: z.number(),
})

export const ChatSessionListResponseSchema = z.object({
  sessions: z.array(ChatSessionSchema),
})

export const ChatSessionDetailResponseSchema = z.object({
  session: ChatSessionSchema,
  messages: z.array(ChatMessageSchema),
})

export const ChatCreateSessionBodySchema = z.object({
  title: z.string().min(1).max(255).optional(),
})

export const ChatRenameSessionBodySchema = z.object({
  title: z.string().min(1).max(255),
})

export type ChatRequest = z.infer<typeof ChatRequestSchema>
export type ChatStartResponse = z.infer<typeof ChatStartResponseSchema>
export type ChatCancelParams = z.infer<typeof ChatCancelParamsSchema>
export type ChatSessionParams = z.infer<typeof ChatSessionParamsSchema>
export type ChatSession = z.infer<typeof ChatSessionSchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type ChatSessionListResponse = z.infer<typeof ChatSessionListResponseSchema>
export type ChatSessionDetailResponse = z.infer<typeof ChatSessionDetailResponseSchema>
export type ChatCreateSessionBody = z.infer<typeof ChatCreateSessionBodySchema>
export type ChatRenameSessionBody = z.infer<typeof ChatRenameSessionBodySchema>
