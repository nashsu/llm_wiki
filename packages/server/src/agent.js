import { readStore } from "./store.js"
import { emit } from "./events.js"
import { EventTypes } from "./events/bus.js"
import { resolveChatConfig, normalizeEndpoint } from "./llm-resolve.js"
import { streamCall, blockingCall } from "./llm-call.js"
import { toolsForRequest, buildToolSpecs, runTool, LOOP_TOOL_REJECTIONS } from "./agent-tools.js"
import {
  isShellCommandAllowedWithoutPrompt, isSkillPreferenceProbeCommand,
  skippedSkillPreferenceProbeSummary, shellApprovalSummary, SHELL_REQUIRES_SKILL_ERROR,
} from "./shell-policy.js"
import { loadProjectSkills, renderSkillPlannerContext, listAvailableSkills } from "./skills.js"
import { ensureProjectRow, getProjectByUuid } from "./store/projects.js"
import {
  ensureSession, getSessionByUuid, listSessions, listMessages, appendMessage, dropLastExchange,
} from "./store/chat-sessions.js"

// Node port of the desktop Rust chat-agent runtime (src-tauri/src/agent).
// Runs the model<->tool loop server-side, calling the configured LLM directly
// and streaming `agent-event` payloads over SSE in the exact shape the React
// chat panel parses (see BackendAgentEventPayload in chat-panel.tsx).
//
// Issue #21: sessions and messages persist in SQLite (chat_sessions /
// chat_messages). The loop LOADS prior messages by sessionId instead of
// receiving client-held history, and APPENDS each completed message: the
// user message when its turn starts, the assistant message when the turn
// finishes (never per streamed delta).

const EVENT = "agent-event"
const MAX_ITER = 8
// How many prior messages the loop feeds the model when the request does not
// say (client setting maxHistoryMessages is passed as request.historyLimit).
const DEFAULT_HISTORY_LIMIT = 20
const runs = new Map()          // runId -> { abort, cancelled }

const fwd = (p) => p.split(path.sep).join("/")
import path from "node:path"

function projectPathFor(store, projectId) {
  const reg = store.projectRegistry ?? {}
  const entry = reg[projectId]
  if (entry?.path) return entry.path
  // Fallback: lastProject / a registry value match by id anywhere
  if (store.lastProject?.id === projectId && store.lastProject?.path) return store.lastProject.path
  const any = Object.values(reg).find((e) => e?.id === projectId)
  if (any?.path) return any.path
  return null
}

function emitEvent(sessionId, runId, event, projectId = null) {
  emit(EVENT, { sessionId, runId, event })
  // SSE taxonomy dual emission (plans/sse-taxonomy.md stage 5): the charter
  // chat:* frames ride the wire alongside agent-event (which stays
  // byte-identical for the active tab's chat panel). Attribution rides in the
  // payload — the emit() bridge keeps the envelope projectId null.
  // messageDelta/toolStart/toolEnd/done map to chat:delta/toolStart/toolEnd/
  // done; error, referenceAdded and fileChanged have NO charter equivalent
  // and stay agent-event-only, as does the error site's companion done here
  // (it carries no text). The error site ADDS a terminal chat:done dual in
  // agentStartTurnStream's catch (failed: "Error: <message>"; cancelled:
  // empty content) so previewing tabs can leave streaming state. done duals
  // only when it carries the turn's accumulated text, so chat:done content
  // can finalize a tab that missed the deltas.
  if (projectId == null || !event) return
  if (event.type === "messageDelta") {
    emit(EventTypes.CHAT_DELTA, { sessionId, runId, projectId, text: event.text })
  } else if (event.type === "toolStart") {
    emit(EventTypes.CHAT_TOOL_START, { sessionId, runId, projectId, tool: event.tool, input: event.input })
  } else if (event.type === "toolEnd") {
    emit(EventTypes.CHAT_TOOL_END, { sessionId, runId, projectId, tool: event.tool, output: event.output })
  } else if (event.type === "done" && typeof event.text === "string") {
    emit(EventTypes.CHAT_DONE, { sessionId, runId, projectId, content: event.text, references: event.references ?? [] })
  }
}

const SYSTEM_PROMPT = `You are the LLM Wiki research assistant. You help the user understand and build their personal knowledge base (a wiki compiled from imported source documents).
You have tools to search the wiki (wiki.search), read wiki pages (wiki.read_page), search raw sources (source.search), search the web (web.search), and write wiki pages or workspace outputs.
Workflow: search/read to gather evidence, then answer grounded in what you found. When you write or update wiki pages, use wiki.write_page with valid YAML frontmatter.
Be concise and cite the pages/sources you used. The system automatically attaches references from your tool results to your answer.`

function buildMessages(request, history) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }]
  const prior = Array.isArray(history) ? history : []
  for (const m of prior) {
    if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content })
    }
  }
  const images = Array.isArray(request.images) ? request.images.filter((i) => i?.dataBase64) : []
  if (images.length) {
    const content = [{ type: "text", text: request.message || "" }]
    for (const img of images) content.push({ type: "image", mediaType: img.mediaType || "image/png", data: img.dataBase64 })
    messages.push({ role: "user", content })
  } else {
    messages.push({ role: "user", content: request.message || "" })
  }
  return messages
}

async function executeToolCall(tc, ctx, emitRef, emitFile) {
  // For shell.exec, surface the command on toolStart so the running step shows it.
  const startInput = tc.name === "shell.exec" ? String(tc.args?.command ?? tc.args?.query ?? "") : undefined
  emitEvent(ctx.sessionId, ctx.runId, { type: "toolStart", tool: tc.name, input: startInput }, ctx.projectId)
  let observation, references = [], fileChanges = []
  let failed = false
  let approvalRequired = false
  let approvalSummary = null
  let detail = null
  const rejection = LOOP_TOOL_REJECTIONS[tc.name]
  if (rejection) {
    failed = true
    detail = rejection
    observation = `rejected: ${rejection}`
  } else {
    try {
      const result = await runTool(tc.name, tc.args, ctx)
      observation = result.observation ?? ""
      references = result.references ?? []
      fileChanges = result.fileChanges ?? []
      approvalRequired = !!result.approvalRequired
      approvalSummary = result.approvalSummary ?? null
    } catch (err) {
      failed = true
      observation = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  for (const ref of references) emitRef(ref)
  for (const fc of fileChanges) emitFile(fc)
  // Approval boundary: pass the EXACT "approval required: <cmd>" string through
  // UNTRUNCATED as the SSE toolEnd output — the frontend derives status
  // "available"->"skipped" from that prefix and slices the command off it.
  const out = approvalRequired
    ? observation
    : (failed ? observation : (observation.length > 300 ? observation.slice(0, 300) + "…" : observation))
  emitEvent(ctx.sessionId, ctx.runId, { type: "toolEnd", tool: tc.name, output: (failed || approvalRequired) ? observation : out }, ctx.projectId)
  return { observation, references, failed, approvalRequired, approvalSummary, detail: detail ?? out }
}

function dedupRefs(list) {
  const seen = new Set(); const out = []
  for (const r of list) {
    const key = `${r.kind ?? "wiki"}:${(r.path ?? r.url ?? "").toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key); out.push(r)
  }
  return out
}

async function runLoop({ request, projectId, stream, onDelta, attribution = null }) {
  const store = readStore("app-state.json")
  const projectPath = projectPathFor(store, projectId)
  if (!projectPath) throw new Error(`Project not found for id '${projectId}'. Open the project in the web client first.`)
  // Issue #21: persistence. Resolve/create the projects row (chat_sessions'
  // FK target) and the session row, load prior messages from SQLite, and
  // record the user message before the loop runs. `resume` marks an
  // approval-boundary re-send whose user message was already persisted.
  const projectRow = ensureProjectRow({ uuid: projectId, path: projectPath })
  // Surface the numeric projects-row id to the caller even when the loop
  // throws: the error/cancel terminal chat:done dual (below) needs it for
  // attribution, and this is the earliest point it exists.
  if (attribution) attribution.projectRowId = projectRow.id
  const session = ensureSession(projectRow.id, request.sessionId, {
    title: (request.message || "").trim().slice(0, 50) || undefined,
  })
  // Regenerate replaces the last exchange: drop the persisted pair BEFORE
  // loading history, so the model never sees the answer being replaced, and
  // the re-persisted user message + fresh answer below take their place.
  if (request.regenerate) dropLastExchange(session.id)
  const historyLimit = Number.isInteger(request.historyLimit) ? request.historyLimit : DEFAULT_HISTORY_LIMIT
  const priorMessages = listMessages(session.id).slice(-historyLimit)
  if (!request.resume) {
    appendMessage(session.id, "user", request.message || "")
  }
  const llmConfig = resolveChatConfig(store)
  const ep = normalizeEndpoint(llmConfig)
  const mode = request.mode || "standard"
  const toolNames = toolsForRequest(request, mode)
  const tools = buildToolSpecs(toolNames)
  const skills = loadProjectSkills(projectPath, request.skills)
  const messages = buildMessages(request, priorMessages)
  if (skills.length) {
    const skillBlock = renderSkillPlannerContext(skills, request.skillMode || "auto")
    messages[0] = { ...messages[0], content: `${messages[0].content}\n\n## Skills\n${skillBlock}` }
    // Mirror the desktop's startup skills.load tool event for the activity panel.
    const detail = `${skills.length} skill(s) ${(request.skillMode || "auto") === "explicit" ? "selected" : "available"}`
    emitEvent(request.sessionId, request.runId, { type: "toolStart", tool: "skills.load" }, projectRow.id)
    emitEvent(request.sessionId, request.runId, { type: "toolEnd", tool: "skills.load", output: detail }, projectRow.id)
  }

  const ctxBase = {
    // projectId is the NUMERIC projects-row id (chat:* attribution, stage 5)
    // — not the UUID the run was started with.
    sessionId: request.sessionId, runId: request.runId, projectId: projectRow.id,
    projectPath, store, llmConfig,
    topK: request.topK ?? 5, includeContent: !!request.includeContent, skills,
    approvedShellCommands: Array.isArray(request.approvedShellCommands) ? request.approvedShellCommands : [],
    signal: runs.get(request.runId)?.abort?.signal,
  }
  const allRefs = []
  const toolEvents = []
  // Runtime-orchestrated Deep Research (mirrors runtime.rs): in deep mode,
  // when at least one retrieval channel is active, bracket the retrieval
  // phase with deep_research.run start/end events. The tool is never offered
  // to the model (see toolsForRequest); deep mode does NOT force web search
  // on — web.search stays gated by request.tools.web.
  const retrievalChannelActive = request.tools?.web || request.tools?.anytxt
    || toolNames.includes("wiki.search") || toolNames.includes("source.search")
  const deepResearch = mode === "deep" && !!retrievalChannelActive
  const message = request.message || ""
  if (deepResearch) {
    toolEvents.push({ tool: "deep_research.run", status: "started", detail: message, timestamp: Date.now() })
    emitEvent(request.sessionId, request.runId, { type: "toolStart", tool: "deep_research.run", input: message }, projectRow.id)
  }
  const emitRef = (ref) => { allRefs.push(ref); emitEvent(request.sessionId, request.runId, { type: "referenceAdded", reference: ref }, projectRow.id) }
  const emitFile = (fc) => emitEvent(request.sessionId, request.runId, { type: "fileChanged", path: fc.path, tool: fc.tool, existedBefore: fc.existedBefore, previousContent: fc.previousContent }, projectRow.id)

  let finalText = ""
  let stoppedAtApproval = false
  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (runs.get(request.runId)?.cancelled) throw new Error("Agent run cancelled")
    const ctx = { ...ctxBase }
    let turnText = ""
    const turnToolCalls = []
    if (stream) {
      for await (const ev of streamCall({ ...ep, messages, tools, signal: ctx.signal })) {
        if (runs.get(request.runId)?.cancelled) throw new Error("Agent run cancelled")
        if (ev.type === "delta") { turnText += ev.text; onDelta?.(ev.text); emitEvent(request.sessionId, request.runId, { type: "messageDelta", text: ev.text }, projectRow.id) }
        else if (ev.type === "tool_call") turnToolCalls.push(ev)
      }
    } else {
      const r = await blockingCall({ ...ep, messages, tools, signal: ctx.signal })
      turnText = r.content || ""
      if (turnText) { onDelta?.(turnText); emitEvent(request.sessionId, request.runId, { type: "messageDelta", text: turnText }, projectRow.id) }
      turnToolCalls.push(...r.toolCalls)
    }
    if (turnToolCalls.length === 0) { finalText = turnText; break }
    // assistant turn with tool calls
    messages.push({ role: "assistant", content: turnText || null, toolCalls: turnToolCalls })
    let approvalBoundary = false
    let approvalMessage = ""
    for (const tc of turnToolCalls) {
      // Desktop-faithful shell.exec pre-checks (runtime.rs execute_agent_loop_tool),
      // done BEFORE the generic started/exec path so the emitted events match the
      // desktop exactly (no spurious "started" event for rejected/probe cases).
      if (tc.name === "shell.exec") {
        const command = String(tc.args?.command ?? tc.args?.query ?? "").trim()
        // (1) skills gate: shell.exec is rejected unless a skill is active for this turn.
        if (skills.length === 0) {
          const err = SHELL_REQUIRES_SKILL_ERROR
          toolEvents.push({ tool: "shell.exec", status: "failed", detail: err, timestamp: Date.now() })
          emitEvent(request.sessionId, request.runId, { type: "toolEnd", tool: "shell.exec", output: `rejected: ${err}` }, projectRow.id)
          messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: `rejected: ${err}` })
          continue
        }
        // (2) skill preference probe: skipped, never sent to shell approval.
        if (isSkillPreferenceProbeCommand(command)) {
          const summary = skippedSkillPreferenceProbeSummary(command)
          emitEvent(request.sessionId, request.runId, { type: "toolStart", tool: "shell.exec", input: command }, projectRow.id)
          toolEvents.push({ tool: "shell.exec", status: "completed", detail: "skipped optional skill preference probe", timestamp: Date.now() })
          emitEvent(request.sessionId, request.runId, { type: "toolEnd", tool: "shell.exec", output: summary }, projectRow.id)
          messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: summary })
          continue
        }
        // (3) per-command approval policy: env escape hatch OR allowlist/workspace-scope.
        const envAllowed = process.env.LLM_WIKI_ALLOW_SHELL === "1"
        if (!envAllowed && !isShellCommandAllowedWithoutPrompt(command, ctxBase.approvedShellCommands, projectPath)) {
          emitEvent(request.sessionId, request.runId, { type: "toolStart", tool: "shell.exec", input: command }, projectRow.id)
          toolEvents.push({ tool: "shell.exec", status: "available", detail: `approval required: ${command}`, timestamp: Date.now() })
          emitEvent(request.sessionId, request.runId, { type: "toolEnd", tool: "shell.exec", output: `approval required: ${command}` }, projectRow.id)
          approvalMessage = shellApprovalSummary(command)
          approvalBoundary = true
          break
        }
        // else: allowed without prompt -> fall through to the generic run path.
      }
      toolEvents.push({ tool: tc.name, status: "started", timestamp: Date.now() })
      const { observation, references, failed, approvalRequired, approvalSummary, detail } = await executeToolCall(tc, ctx, emitRef, emitFile)
      const bad = failed || (observation.startsWith("failed:") || observation.startsWith("rejected:"))
      if (approvalRequired) {
        // Defensive path: shell.exec reached the executor unapproved. Same shape as (3).
        toolEvents.push({ tool: tc.name, status: "available", detail: observation, timestamp: Date.now() })
        messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: observation })
        approvalMessage = approvalSummary || observation
        approvalBoundary = true
        break
      }
      toolEvents.push({ tool: tc.name, status: references.length || !bad ? "completed" : "failed", detail, timestamp: Date.now() })
      messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: observation })
    }
    if (approvalBoundary) {
      // Stop the turn at the approval boundary (stateless resume: the frontend
      // re-sends with approvedShellCommands). Emit the desktop's exact approval
      // text as the final message; the Approve button is driven by the
      // "available"->skipped shell_exec step (detail "approval required: <cmd>").
      if (stream) emitEvent(request.sessionId, request.runId, { type: "messageDelta", text: approvalMessage }, projectRow.id)
      finalText = approvalMessage
      stoppedAtApproval = true
      break
    }
    // loop again for the model to answer
  }

  const finalReferences = dedupRefs(allRefs)
  if (deepResearch) {
    const detail = `${finalReferences.length} reference(s)`
    toolEvents.push({ tool: "deep_research.run", status: "completed", detail, timestamp: Date.now() })
    emitEvent(request.sessionId, request.runId, { type: "toolEnd", tool: "deep_research.run", output: detail }, projectRow.id)
  }
  // Issue #21: persist the completed assistant message (with its references).
  // Runs that throw or are cancelled before this point leave only the user
  // message persisted — the assistant turn never completed. Turns that stop
  // at an approval boundary persist nothing here: the approval text is UI
  // scaffolding, not an answer, and persisting it would leave two consecutive
  // assistant rows once the resumed turn completes.
  if (finalText && !stoppedAtApproval) {
    appendMessage(session.id, "assistant", finalText, finalReferences)
  }
  // Numeric projects-table id (chat:* taxonomy attribution, stage 5). The
  // caller only knows the project UUID; the row is resolved above.
  return { finalText, references: finalReferences, toolEvents, projectRowId: projectRow.id }
}

export async function agentStartTurnStream({ projectId, request }) {
  const runId = request.runId || crypto.randomUUID()
  const abort = new AbortController()
  runs.set(runId, { abort, cancelled: false })
  // Holder so the catch below knows the numeric projects-row id even when
  // runLoop throws (terminal chat:done dual attribution).
  const attribution = {}
  // Run asynchronously; the invoke returns the runId immediately and the UI
  // awaits the "done" event on the SSE stream.
  void (async () => {
    try {
      const { finalText, references, projectRowId } = await runLoop({ request: { ...request, runId }, projectId, stream: true, attribution })
      // The done agent-event carries the turn's accumulated text; emitEvent
      // duals it as chat:done (taxonomy stage 5) so a tab that missed the
      // deltas can finalize.
      emitEvent(request.sessionId, runId, { type: "done", text: finalText, references }, projectRowId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Error site: error frames (and the companion textless done) have no
      // charter equivalent — they stay agent-event-only.
      emitEvent(request.sessionId, runId, { type: "error", message })
      emitEvent(request.sessionId, runId, { type: "done" })
      // But a tab previewing this run via chat:* frames has no agent-event
      // consumer — without a terminal dual its isStreaming stays true forever
      // and every send path is locked (review fix). Dual a terminal chat:done
      // mirroring the owning tab's catch-path outcome: cancelled runs end
      // silently (empty content ⇒ sse-sync resets the stream without adding a
      // message, parity with the owning tab's abort-like setStreaming(false));
      // failed runs finalize with the same "Error: <message>" text the owning
      // tab renders. Direct emit so the agent-event stream stays
      // byte-identical (emitEvent would add an extra done agent-event).
      const projectRowId = attribution.projectRowId ?? null
      if (projectRowId != null) {
        const cancelled = runs.get(runId)?.cancelled === true || /abort|cancel/i.test(message)
        emit(EventTypes.CHAT_DONE, {
          sessionId: request.sessionId,
          runId,
          projectId: projectRowId,
          content: cancelled ? "" : `Error: ${message}`,
          references: [],
        })
      }
    } finally {
      runs.delete(runId)
    }
  })()
  return runId
}

export async function agentStartTurn({ projectId, request }) {
  const runId = request.runId || crypto.randomUUID()
  const abort = new AbortController()
  runs.set(runId, { abort, cancelled: false })
  try {
    const { finalText, references, toolEvents } = await runLoop({ request: { ...request, runId }, projectId, stream: false })
    return { sessionId: request.sessionId, mode: request.mode, message: finalText, references, toolEvents }
  } finally {
    runs.delete(runId)
  }
}

export async function agentCancelTurn(args) {
  const runId = args?.runId ?? args?.requestId
  const r = runId ? runs.get(runId) : null
  if (r) { r.cancelled = true; try { r.abort.abort() } catch { /* noop */ } }
  return null
}

export async function agentGetSession({ sessionId } = {}) {
  // Issue #21: sessions live in SQLite, not an in-memory map.
  if (!sessionId) return null
  const session = getSessionByUuid(sessionId)
  if (!session) return null
  return { session, messages: listMessages(sessionId) }
}
export async function agentListSessions(args = {}) {
  const projectId = args?.projectId
  if (!projectId) return []
  const row = getProjectByUuid(String(projectId))
  return row ? listSessions(row.id) : []
}
export async function agentListSkills(args = {}) { return listAvailableSkills(args.projectPath ?? "") }

export const agentCommands = {
  agent_start_turn: (a) => agentStartTurn(a),
  agent_start_turn_stream: (a) => agentStartTurnStream(a),
  agent_cancel_turn: (a) => agentCancelTurn(a),
  agent_get_session: (a) => agentGetSession(a),
  agent_list_sessions: (a) => agentListSessions(a),
  agent_list_skills: (a) => agentListSkills(a),
}
