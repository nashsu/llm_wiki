// Chat — /api/v2/projects/:id/chat (streaming runs over the SSE event bus)
//
// Issue #21: sessions and messages persist server-side (chat_sessions /
// chat_messages). The session endpoints below are the client's interface to
// that persistence: the web build lists/creates/renames/deletes sessions and
// loads a session's messages from the server instead of re-sending history.
// The `projectId` segment accepts either the integer projects-table id or
// the client project UUID (WikiProject.id), so callers pass whatever they
// hold — the web client passes the UUID.

import { request } from "./client"

export interface ChatTools {
  wiki?: boolean
  web?: boolean
  anytxt?: boolean
}

export interface ChatOptions {
  sessionId?: string
  mode?: "standard" | "deep"
  tools?: ChatTools
  topK?: number
  includeContent?: boolean
  skills?: string[]
  /** Approval/continuation re-send: the server must not re-persist the user message. */
  resume?: boolean
  /** How many prior messages the agent loop feeds the model. */
  historyLimit?: number
}

export interface ChatStartResponse {
  runId: string
  sessionId: string
}

export interface ChatCancelResponse {
  success: boolean
  [key: string]: unknown
}

export interface ChatSessionInfo {
  id: string
  projectId: number
  title: string
  createdAt: number
  updatedAt: number
}

export interface ChatMessageInfo {
  id: number
  role: "user" | "assistant"
  content: string
  references?: Record<string, unknown>[]
  createdAt: number
}

export interface ChatSessionDetail {
  session: ChatSessionInfo
  messages: ChatMessageInfo[]
}

/**
 * POST /api/v2/projects/:id/chat — starts a chat run. Token deltas and status
 * events arrive on the SSE event stream (see events.ts), keyed by runId.
 * History is server-owned (issue #21): the server loads prior messages for
 * `sessionId` from SQLite; callers no longer send a history array.
 */
export function startChat(
  projectId: number | string,
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
      resume: opts.resume,
      historyLimit: opts.historyLimit,
    },
  })
}

/** POST /api/v2/projects/:id/chat/:runId/cancel */
export function cancelChat(projectId: number | string, runId: string): Promise<ChatCancelResponse> {
  return request<ChatCancelResponse>(
    `/api/v2/projects/${projectId}/chat/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  )
}

/** GET /api/v2/projects/:id/chat/sessions — list sessions, most recent first */
export function listChatSessions(
  projectId: number | string,
): Promise<{ sessions: ChatSessionInfo[] }> {
  return request<{ sessions: ChatSessionInfo[] }>(`/api/v2/projects/${projectId}/chat/sessions`)
}

/** POST /api/v2/projects/:id/chat/sessions — create an empty session */
export function createChatSession(
  projectId: number | string,
  title?: string,
): Promise<{ session: ChatSessionInfo }> {
  return request<{ session: ChatSessionInfo }>(`/api/v2/projects/${projectId}/chat/sessions`, {
    method: "POST",
    json: title !== undefined ? { title } : {},
  })
}

/** GET /api/v2/projects/:id/chat/sessions/:sessionId — session + messages */
export function getChatSession(
  projectId: number | string,
  sessionId: string,
): Promise<ChatSessionDetail> {
  return request<ChatSessionDetail>(
    `/api/v2/projects/${projectId}/chat/sessions/${encodeURIComponent(sessionId)}`,
  )
}

/** PATCH /api/v2/projects/:id/chat/sessions/:sessionId — rename */
export function renameChatSession(
  projectId: number | string,
  sessionId: string,
  title: string,
): Promise<{ session: ChatSessionInfo }> {
  return request<{ session: ChatSessionInfo }>(
    `/api/v2/projects/${projectId}/chat/sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", json: { title } },
  )
}

/** DELETE /api/v2/projects/:id/chat/sessions/:sessionId — delete (messages cascade) */
export function deleteChatSession(
  projectId: number | string,
  sessionId: string,
): Promise<void> {
  return request<void>(
    `/api/v2/projects/${projectId}/chat/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  )
}
