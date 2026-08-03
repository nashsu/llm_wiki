import { Router } from "express"
import crypto from "node:crypto"
import { validate } from "../middleware/validate.js"
import {
  ChatRequestSchema,
  ChatCancelParamsSchema,
  ChatSessionParamsSchema,
  ChatCreateSessionBodySchema,
  ChatRenameSessionBodySchema,
} from "@llm-wiki/api-types"
import { agentStartTurnStream, agentCancelTurn } from "../agent.js"
import * as chatStore from "../store/chat-sessions.js"
import { getProject, getProjectByUuid, ensureProjectRow } from "../store/projects.js"
import { readStore } from "../store.js"
import { ApiError, ErrorCode } from "../errors.js"

const router = Router()

// Resolve the :id param for every chat route. Accepts EITHER the integer
// projects-table id (v2 convention) or the client's project UUID
// (WikiProject.id from .llm-wiki/project.json). The web client only knows
// the UUID, so UUID resolution falls back to the plugin-store registry —
// the same mapping the chat agent loop already uses — and materializes the
// projects row chat_sessions' FK requires (issue #21).
function resolveChatProject(rawId) {
  const raw = String(rawId ?? "").trim()
  if (/^\d+$/.test(raw)) {
    const project = getProject(Number.parseInt(raw, 10))
    if (project) return project
  }
  const byUuid = getProjectByUuid(raw)
  if (byUuid) return byUuid
  const store = readStore("app-state.json")
  const reg = store.projectRegistry ?? {}
  const entry = reg[raw]
  const path = entry?.path
    ?? (store.lastProject?.id === raw ? store.lastProject?.path : null)
    ?? Object.values(reg).find((e) => e?.id === raw)?.path
  if (!path) throw new ApiError(ErrorCode.PROJECT_NOT_FOUND, `Project ${raw} not found`)
  return ensureProjectRow({ uuid: raw, path })
}

function chatProjectLookup() {
  return (req, _res, next) => {
    try {
      req.project = resolveChatProject(req.params.id)
      req.projectId = req.project.id
      next()
    } catch (err) {
      next(err)
    }
  }
}

// POST /api/v2/projects/:id/chat - start a chat turn (streaming).
// Issue #21: the request no longer carries history. The agent loop loads
// prior messages for sessionId from chat_messages and persists each
// completed message as it lands.
router.post("/:id/chat", chatProjectLookup(), validate({ body: ChatRequestSchema }), async (req, res, next) => {
  try {
    const { message, sessionId, mode, tools, topK, includeContent, skills, resume, historyLimit } = req.validated.body
    const request = {
      message,
      sessionId: sessionId || crypto.randomUUID(),
      runId: crypto.randomUUID(),
      mode,
      retrievalMode: "standard",
      tools: tools || { wiki: true, web: false, anytxt: false },
      topK,
      includeContent,
      skills,
      resume,
      ...(historyLimit !== undefined ? { historyLimit } : {}),
    }

    const runId = await agentStartTurnStream({ projectId: req.project.uuid ?? String(req.project.id), request })

    res.json({
      runId,
      sessionId: request.sessionId,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/projects/:id/chat/:runId/cancel - cancel a running turn
router.post("/:id/chat/:runId/cancel", validate({ params: ChatCancelParamsSchema }), async (req, res, next) => {
  try {
    const { runId } = req.validated.params
    await agentCancelTurn({ runId })
    res.json({ cancelled: true })
  } catch (err) {
    next(err)
  }
})

// ── session management (issue #21) ──────────────────────────────────────

// GET /api/v2/projects/:id/chat/sessions - list sessions, most recent first
router.get("/:id/chat/sessions", chatProjectLookup(), (req, res) => {
  res.json({ sessions: chatStore.listSessions(req.projectId) })
})

// POST /api/v2/projects/:id/chat/sessions - create an empty session
router.post(
  "/:id/chat/sessions",
  chatProjectLookup(),
  validate({ body: ChatCreateSessionBodySchema }),
  (req, res) => {
    const session = chatStore.createSession(req.projectId, req.validated.body)
    res.status(201).json({ session })
  }
)

// GET /api/v2/projects/:id/chat/sessions/:sessionId - session + messages
router.get(
  "/:id/chat/sessions/:sessionId",
  chatProjectLookup(),
  validate({ params: ChatSessionParamsSchema }),
  (req, res) => {
    const { sessionId } = req.validated.params
    const session = chatStore.getSessionByUuid(sessionId)
    if (!session || session.projectId !== req.projectId) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Session ${sessionId} not found`)
    }
    res.json({ session, messages: chatStore.listMessages(sessionId) })
  }
)

// PATCH /api/v2/projects/:id/chat/sessions/:sessionId - rename
router.patch(
  "/:id/chat/sessions/:sessionId",
  chatProjectLookup(),
  validate({ params: ChatSessionParamsSchema, body: ChatRenameSessionBodySchema }),
  (req, res) => {
    const { sessionId } = req.validated.params
    const existing = chatStore.getSessionByUuid(sessionId)
    if (!existing || existing.projectId !== req.projectId) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Session ${sessionId} not found`)
    }
    const session = chatStore.renameSession(sessionId, req.validated.body.title)
    res.json({ session })
  }
)

// DELETE /api/v2/projects/:id/chat/sessions/:sessionId - delete (messages cascade)
router.delete(
  "/:id/chat/sessions/:sessionId",
  chatProjectLookup(),
  validate({ params: ChatSessionParamsSchema }),
  (req, res) => {
    const { sessionId } = req.validated.params
    const existing = chatStore.getSessionByUuid(sessionId)
    if (!existing || existing.projectId !== req.projectId) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Session ${sessionId} not found`)
    }
    chatStore.deleteSession(sessionId)
    res.status(204).end()
  }
)

export default router
