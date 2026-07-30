// Chat — /api/v2/projects/:id/chat (streaming runs over the SSE event bus)

import { request } from "./client"

export interface ChatTools {
  wiki?: boolean
  web?: boolean
  anytxt?: boolean
}

export interface ChatHistoryEntry {
  role: string
  content: string
}

export interface ChatOptions {
  sessionId?: string
  mode?: "standard" | "deep"
  tools?: ChatTools
  topK?: number
  includeContent?: boolean
  skills?: string[]
  history?: ChatHistoryEntry[]
}

export interface ChatStartResponse {
  runId: string
  sessionId: string
}

export interface ChatCancelResponse {
  success: boolean
  [key: string]: unknown
}

/**
 * POST /api/v2/projects/:id/chat — starts a chat run. Token deltas and status
 * events arrive on the SSE event stream (see events.ts), keyed by runId.
 */
export function startChat(
  projectId: number,
  message: string,
  opts: ChatOptions = {},
): Promise<ChatStartResponse> {
  return request<ChatStartResponse>(`/api/v2/projects/${projectId}/chat`, {
    method: "POST",
    json: {
      message,
      sessionId: opts.sessionId,
      mode: opts.mode,
      tools: opts.tools,
      topK: opts.topK,
      includeContent: opts.includeContent,
      skills: opts.skills,
      history: opts.history,
    },
  })
}

/** POST /api/v2/projects/:id/chat/:runId/cancel */
export function cancelChat(projectId: number, runId: string): Promise<ChatCancelResponse> {
  return request<ChatCancelResponse>(
    `/api/v2/projects/${projectId}/chat/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  )
}
