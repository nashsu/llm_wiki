import { Router } from "express"
import crypto from "node:crypto"
import { validate } from "../middleware/validate.js"
import { projectLookup } from "../middleware/project-lookup.js"
import { ChatRequestSchema, ChatCancelParamsSchema, ChatSessionParamsSchema } from "@llm-wiki/api-types"
import { agentStartTurnStream, agentCancelTurn, agentGetSession } from "../agent.js"
import { ApiError, ErrorCode } from "../errors.js"

const router = Router()

// POST /api/v2/projects/:id/chat - start a chat turn (streaming)
router.post("/:id/chat", projectLookup(), validate({ body: ChatRequestSchema }), async (req, res, next) => {
  try {
    const { message, sessionId, mode, tools, topK, includeContent, skills, history } = req.validated.body
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
      history,
    }

    const runId = await agentStartTurnStream({ projectId: req.project.id, request })

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

// GET /api/v2/projects/:id/chat/sessions/:sessionId - get session state
router.get("/:id/chat/sessions/:sessionId", validate({ params: ChatSessionParamsSchema }), async (req, res, next) => {
  try {
    const { sessionId } = req.validated.params
    const session = await agentGetSession({ sessionId })
    if (!session) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Session ${sessionId} not found`)
    }
    res.json(session)
  } catch (err) {
    next(err)
  }
})

export default router
