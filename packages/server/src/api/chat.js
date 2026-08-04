import { Router } from "express"
import crypto from "node:crypto"
import { validate } from "../middleware/validate.js"
import {
  ChatRequestSchema,
  ChatCancelParamsSchema,
  ChatSessionParamsSchema,
  ChatCreateSessionBodySchema,
  ChatRenameSessionBodySchema,
  ChatWritesBodySchema,
} from "@llm-wiki/api-types"
import { agentStartTurnStream, agentCancelTurn } from "../agent.js"
import * as chatStore from "../store/chat-sessions.js"
import { getProject, getProjectByUuid, ensureProjectRow } from "../store/projects.js"
import { safeJoin } from "../store/project-paths.js"
import { readStore } from "../store.js"
import { emit } from "../events.js"
import { EventTypes } from "../events/bus.js"
import { resolveChatConfig, hasUsableLlmConfig } from "../llm-resolve.js"
import { streamChat } from "../ingest/llm.js"
import { languageRule } from "../ingest/prompts.js"
import {
  FILE_BLOCK_REGEX,
  isSafeIngestPath,
  isAppManagedAggregatePath,
  canonicalizeSourcesField,
} from "../ingest/parse.js"
import {
  tryReadFile,
  writeFileEnsuringDirs,
  isLogPath,
  isListingPath,
} from "../ingest/write.js"
import { sourceIdentityForPath, sourceSummarySlugFromIdentity } from "../ingest/identity.js"
import {
  imageExtractionKey,
  extractSourceImagesOnceByKey,
  injectImagesIntoSourceSummary,
} from "../ingest/images.js"
import { ApiError, ErrorCode } from "../errors.js"
import fs from "node:fs"
import path from "node:path"

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
    const { message, sessionId, mode, tools, topK, includeContent, skills, resume, regenerate, historyLimit } = req.validated.body
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
      regenerate,
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

// ── chat "Write to Wiki" (issue #14 P0: server port of executeIngestWrites) ─
//
// Server port of the client's executeIngestWrites (src/lib/ingest.ts
// ~3217-3428). The write prompt text, system prompt composition, FILE-block
// handling and chat message bookkeeping stay byte-identical to the client;
// streaming follows the agentStartTurnStream SSE contract (agent-event
// frames with messageDelta / done / error), so the chat panel renders this
// run exactly like a normal agent turn. The extra "wikiWrites" frame type is
// ignored by the main stream listener and consumed by the writes handler.

const AGENT_EVENT = "agent-event"

function emitAgentEvent(sessionId, runId, event) {
  emit(AGENT_EVENT, { sessionId, runId, event })
}

// Byte-identical port of the writePrompt assembly in
// executeIngestWritesImpl (ingest.ts ~3257-3286), including the
// filter(line => line !== undefined) that KEEPS empty lines.
function buildWritePrompt({ userGuidance, schema, index, activeSourceIdentity, activeSourceSummaryPath }) {
  return [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    userGuidance ? `Additional guidance: ${userGuidance}` : "",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    activeSourceIdentity && activeSourceSummaryPath
      ? [
          `## Source File`,
          `The original source file is: **${activeSourceIdentity}**`,
          `If you generate a source summary page, it MUST use this exact path: **${activeSourceSummaryPath}**.`,
          `Every page generated from this source MUST include "${activeSourceIdentity}" in its frontmatter \`sources\` field.`,
        ].join("\n")
      : "",
    "",
    "Output ONLY the file contents in this exact format for each file:",
    "```",
    "---FILE: wiki/path/to/file.md---",
    "(file content here)",
    "---END FILE---",
    "```",
    "",
    "For wiki/log.md, include a log entry to append. For all other files, output the complete file content.",
    "Do not generate wiki/index.md or wiki/overview.md. The application owns those aggregate files.",
    "Use relative paths from the project root (e.g., wiki/sources/topic.md).",
    "Do not include any other text outside the FILE blocks.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

// FILE-block writes with the client's NAIVE executeIngestWrites semantics
// (NOT writeFileBlocks: no merge, no truncation repair, no sanitization
// beyond the path guards — byte-identical to ingest.ts ~3330-3374).
// Returns { writtenPaths, existedBefore }: written project-relative paths
// plus whether each target existed before the write (the server-only bit —
// it drives the file:created vs file:modified event below).
async function writeChatWikiBlocks({ pp, accumulated, activeSourceIdentity, activeSourceSummaryPath }) {
  const writtenPaths = []
  const existedBefore = new Map()
  const matches = accumulated.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    let relativePath = match[1].trim()
    let content = match[2]

    if (!relativePath) continue
    if (
      activeSourceSummaryPath &&
      relativePath.startsWith("wiki/sources/")
    ) {
      relativePath = activeSourceSummaryPath
    }

    if (!isSafeIngestPath(relativePath) || isAppManagedAggregatePath(relativePath)) {
      console.warn(`[executeIngestWrites] rejected unsafe or app-managed path: ${relativePath}`)
      continue
    }

    if (
      activeSourceIdentity &&
      !isLogPath(relativePath) &&
      !isListingPath(relativePath)
    ) {
      content = canonicalizeSourcesField(content, activeSourceIdentity)
    }

    const fullPath = `${pp}/${relativePath}`

    try {
      existedBefore.set(relativePath, fs.existsSync(fullPath))
      if (isLogPath(relativePath)) {
        const existing = await tryReadFile(fullPath)
        const appended = existing
          ? `${existing}\n\n${content.trim()}`
          : content.trim()
        await writeFileEnsuringDirs(fullPath, appended)
      } else {
        await writeFileEnsuringDirs(fullPath, content)
      }
      writtenPaths.push(relativePath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  return { writtenPaths, existedBefore }
}

// POST /api/v2/projects/:id/chat/writes - run the chat "Write to Wiki" flow.
// Returns { runId, sessionId, writePrompt } immediately; the generation runs
// in a void async and streams agent-event frames (agentStartTurnStream
// pattern). The user writePrompt row is persisted BEFORE streaming starts.
router.post(
  "/:id/chat/writes",
  chatProjectLookup(),
  validate({ body: ChatWritesBodySchema }),
  async (req, res, next) => {
    try {
      const { sessionId, userGuidance, sourcePath } = req.validated.body

      const store = readStore("app-state.json")
      const llmConfig = resolveChatConfig(store)
      if (!hasUsableLlmConfig(llmConfig)) {
        // Same message the ingest orchestrator fails with (desktop parity).
        throw new ApiError(ErrorCode.UPSTREAM_ERROR, "LLM not configured — set API key in Settings")
      }

      // normalizePath parity (ingest.ts): forward-slash project path.
      const pp = req.project.path.replace(/\\/g, "/")

      // The client pulls ingestSource from the chat store; on the wire it
      // arrives as sourcePath. Resolve it against the project: absolute
      // paths pass through, relative paths are safeJoin'ed (traversal →
      // FORBIDDEN).
      let absSourcePath = null
      let activeSourceIdentity = null
      let activeSourceSummaryPath = null
      if (sourcePath) {
        absSourcePath = path.isAbsolute(sourcePath)
          ? sourcePath
          : safeJoin(req.project.path, sourcePath)
        activeSourceIdentity = sourceIdentityForPath(pp, absSourcePath)
        const activeSourceSummarySlug = sourceSummarySlugFromIdentity(activeSourceIdentity)
        activeSourceSummaryPath = `wiki/sources/${activeSourceSummarySlug}.md`
      }

      // NOTE: the client reads wiki/schema.md here, NOT the root schema.md.
      const [schema, index] = await Promise.all([
        tryReadFile(`${pp}/wiki/schema.md`),
        tryReadFile(`${pp}/wiki/index.md`),
      ])

      const writePrompt = buildWritePrompt({
        userGuidance,
        schema,
        index,
        activeSourceIdentity,
        activeSourceSummaryPath,
      })

      // Session ensure/load exactly like the POST /:id/chat flow: lazy
      // creation titled from the first user message (the write prompt).
      const session = chatStore.ensureSession(req.projectId, sessionId, {
        title: writePrompt.trim().slice(0, 50) || undefined,
      })
      // There is no system role in chat_messages; the role filter mirrors
      // the client's store.messages.filter(m => m.role !== "system").
      const conversationHistory = chatStore.listMessages(session.id)
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }))

      conversationHistory.push({ role: "user", content: writePrompt })

      // Persist BEFORE streaming (client: store.addMessage("user", writePrompt)).
      chatStore.appendMessage(session.id, "user", writePrompt)

      // historyText = history contents + writePrompt joined, sliced to 2000
      // chars (ingest.ts ~3298-3301). The client's languageRule delegates to
      // buildLanguageDirective → getOutputLanguage (src/lib/output-language.ts),
      // which honors the configured outputLanguage and only auto-detects when
      // it is "auto" — the server languageRule has identical semantics, so
      // pass the store setting through (app-state.json mirrors the wiki-store
      // outputLanguage setting).
      const historyText = conversationHistory
        .map((m) => m.content)
        .join("\n")
        .slice(0, 2000)

      const systemPrompt = [
        "You are a wiki generation assistant. Your task is to produce structured wiki file contents.",
        "",
        languageRule(store.outputLanguage ?? "auto", historyText),
        schema ? `## Wiki Schema\n${schema}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")

      const runId = crypto.randomUUID()

      // Run asynchronously; the route returns the runId immediately and the
      // UI awaits the "done" event on the SSE stream (agentStartTurnStream
      // pattern).
      void (async () => {
        let accumulated = ""
        try {
          await streamChat(
            llmConfig,
            [{ role: "system", content: systemPrompt }, ...conversationHistory],
            {
              onToken: (token) => {
                accumulated += token
                emitAgentEvent(sessionId, runId, { type: "messageDelta", text: token })
              },
            },
          )
        } catch (err) {
          // Parity with the client's onError finalize text; the finalized
          // text also lands as the assistant message (client
          // finalizeStream), so the persisted bookkeeping matches.
          const message = err instanceof Error ? err.message : String(err)
          const finalText = `Error generating wiki files: ${message}`
          try { chatStore.appendMessage(session.id, "assistant", finalText) } catch { /* best effort */ }
          emitAgentEvent(sessionId, runId, { type: "error", message: finalText })
          emitAgentEvent(sessionId, runId, { type: "done" })
          return
        }

        // Persist the completed assistant message (client finalizeStream).
        chatStore.appendMessage(session.id, "assistant", accumulated)

        const { writtenPaths, existedBefore } = await writeChatWikiBlocks({
          pp,
          accumulated,
          activeSourceIdentity,
          activeSourceSummaryPath,
        })

        emitAgentEvent(sessionId, runId, { type: "wikiWrites", writtenPaths })

        // File events so sse-sync refreshes file trees. chat/writes writes
        // its FILE blocks itself (writeChatWikiBlocks, not via the
        // /files/upload route), so it emits its own frames; the stable file
        // event names live on the bus (EventTypes.FILE_CREATED /
        // FILE_MODIFIED) and sse-sync's handleFileEvent refreshes the
        // project tree for both.
        for (const rel of writtenPaths) {
          emit(existedBefore.get(rel) ? EventTypes.FILE_MODIFIED : EventTypes.FILE_CREATED, {
            projectId: req.projectId,
            path: rel,
          })
        }

        // Image cascade (client tail of executeIngestWritesImpl): only when
        // a source is active AND multimodal captioning is enabled.
        const mmCfgWrites = store.multimodalConfig
        if (absSourcePath && mmCfgWrites?.enabled) {
          try {
            const sourceIdentity = sourceIdentityForPath(pp, absSourcePath)
            const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
            const extractionKey = await imageExtractionKey(pp, absSourcePath, sourceSummarySlug)
            const savedImages = await extractSourceImagesOnceByKey(
              extractionKey,
              pp,
              absSourcePath,
              sourceSummarySlug,
            )
            if (savedImages.length > 0) {
              await injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages)
            }
            // DEVIATION from the client: it deletes the extraction promise
            // from its module map in `finally` here. The server's images.js
            // exposes rememberImageExtractionByKey but no forget/delete
            // helper (entries are evicted on rejection or via the 32-entry
            // LRU), so only the cache-delete is skipped.
          } catch (err) {
            console.warn(
              `[executeIngestWrites:images] post-write injection failed:`,
              err instanceof Error ? err.message : err,
            )
          }
        }

        emitAgentEvent(sessionId, runId, { type: "done", text: accumulated })
      })()

      res.json({ runId, sessionId, writePrompt })
    } catch (err) {
      next(err)
    }
  }
)

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
