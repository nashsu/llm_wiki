// chat:* taxonomy dual emission tests (plans/sse-taxonomy.md stage 5).
//
// The agent runtime keeps `agent-event` byte-identical and ADDITIONALLY
// publishes the charter chat:* frames at the same choke points, riding the
// legacy emit() bridge (envelope projectId null; attribution — including the
// numeric projects-table id resolved from projectRow — in the payload):
//   messageDelta -> chat:delta { sessionId, runId, projectId, text }
//   toolStart    -> chat:toolStart { sessionId, runId, projectId, tool, input }
//   toolEnd      -> chat:toolEnd { sessionId, runId, projectId, tool, output }
//   done         -> chat:done { sessionId, runId, projectId, content, references }
// referenceAdded/fileChanged have no charter equivalent. The error site's
// error + companion textless done stay agent-event-only, but the site ADDS a
// terminal chat:done dual (failed: "Error: <message>"; cancelled: empty
// content) so tabs previewing the run via chat:* can leave streaming state.
//
// llm-call.js is mocked (scriptable streamCall/blockingCall) so no real LLM
// is touched; the tool executor (source.search) runs the real code path.

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { streamCallMock, blockingCallMock } = vi.hoisted(() => ({
  streamCallMock: vi.fn(),
  blockingCallMock: vi.fn(),
}))

vi.mock("../src/llm-call.js", () => ({
  streamCall: (...args) => streamCallMock(...args),
  blockingCall: (...args) => blockingCallMock(...args),
}))

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-chat-events-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const PROJECT_UUID = "chat-events-proj-uuid"
const PROJECT_PATH = path.join(DATA_DIR, "chat-events-proj")

beforeAll(() => {
  mkdirSync(path.join(PROJECT_PATH, "raw", "sources"), { recursive: true })
  // source.search keyword-matches this doc (real tool executor).
  writeFileSync(path.join(PROJECT_PATH, "raw", "sources", "doc.md"), "Hello world from the doc.\n")
  mkdirSync(path.join(DATA_DIR, "stores"), { recursive: true })
  writeFileSync(path.join(DATA_DIR, "stores", "app-state.json"), JSON.stringify({
    projectRegistry: {
      [PROJECT_UUID]: { id: PROJECT_UUID, path: PROJECT_PATH },
    },
    llmConfig: { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" },
  }))
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  streamCallMock.mockReset()
  blockingCallMock.mockReset()
})

const { agentStartTurnStream, agentStartTurn } = await import("../src/agent.js")
const { eventBus } = await import("../src/events/bus.js")
const { ensureProjectRow } = await import("../src/store/projects.js")

// The numeric projects-table id the chat:* payloads must attribute with.
// runLoop materializes the row via ensureProjectRow on first turn; do the
// same here so tests can assert against it.
let numericProjectId
beforeAll(() => {
  numericProjectId = ensureProjectRow({ uuid: PROJECT_UUID, path: PROJECT_PATH }).id
  expect(typeof numericProjectId).toBe("number")
})

const CHAT_TYPES = new Set(["chat:delta", "chat:toolStart", "chat:toolEnd", "chat:done"])

/**
 * Subscribe to the bus BEFORE the turn starts so no frame is missed.
 * Collects agent-event payloads and chat:* envelopes for one session, and
 * resolves waitDone() on the agent-event done frame (the chat:done dual is
 * emitted synchronously right after it, so it is collected by then).
 */
function watchSession(sessionId) {
  const agentEvents = []
  const chatEvents = []
  let resolveDone
  const donePromise = new Promise((resolve) => { resolveDone = resolve })
  const unsub = eventBus.subscribe((env) => {
    if (env.type === "agent-event") {
      const p = env.payload ?? {}
      if (p.sessionId !== sessionId) return
      agentEvents.push(p)
      if (p.event?.type === "done") resolveDone()
    } else if (CHAT_TYPES.has(env.type)) {
      if ((env.payload?.sessionId ?? null) !== sessionId) return
      chatEvents.push(env)
    }
  })
  return {
    agentEvents,
    chatEvents,
    async waitDone(timeoutMs = 5000) {
      await Promise.race([
        donePromise,
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`timed out waiting for done frame (got ${agentEvents.length} agent-event frames)`)),
          timeoutMs,
        )),
      ])
      unsub()
    },
    unsub,
  }
}

function turnRequest(sessionId, runId, message) {
  return {
    message,
    sessionId,
    runId,
    mode: "standard",
    tools: { wiki: false, web: false, anytxt: false },
    topK: 5,
    includeContent: false,
    skills: [],
    resume: false,
  }
}

describe("agentStartTurnStream runLoop dual emission (stage 5)", () => {
  const sessionId = "conv_dual_stream"
  const runId = "run-dual-stream"
  let watcher

  beforeAll(async () => {
    // Iteration 1: the model calls source.search (real executor). Iteration
    // 2: two deltas, then the loop ends.
    streamCallMock
      .mockImplementationOnce(async function* () {
        yield { type: "tool_call", id: "call_1", name: "source.search", args: { query: "hello" } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "delta", text: "Final " }
        yield { type: "delta", text: "answer" }
        yield { type: "finish" }
      })

    watcher = watchSession(sessionId)
    const returned = await agentStartTurnStream({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, runId, "Search the sources"),
    })
    expect(returned).toBe(runId)
    await watcher.waitDone()
  })

  afterAll(() => watcher.unsub())

  it("keeps the agent-event stream byte-identical", () => {
    // The legacy frames are untouched: tool step, reference, deltas, done.
    expect(watcher.agentEvents.map((f) => f.event.type)).toEqual([
      "toolStart", "referenceAdded", "toolEnd", "messageDelta", "messageDelta", "done",
    ])
    for (const frame of watcher.agentEvents) {
      expect(frame.sessionId).toBe(sessionId)
      expect(frame.runId).toBe(runId)
    }
  })

  it("dual-emits chat:toolStart + chat:toolEnd for the tool call", () => {
    const start = watcher.chatEvents.find((e) => e.type === "chat:toolStart")
    expect(start.projectId).toBeNull() // emit() bridge envelope
    // input is undefined for non-shell tools (agent-event parity) — toEqual
    // treats undefined-valued keys as absent.
    expect(start.payload).toEqual({ sessionId, runId, projectId: numericProjectId, tool: "source.search" })

    const end = watcher.chatEvents.find((e) => e.type === "chat:toolEnd")
    expect(end.projectId).toBeNull()
    expect(end.payload).toMatchObject({ sessionId, runId, projectId: numericProjectId, tool: "source.search" })
    expect(end.payload.output).toContain("raw/sources/doc.md")
    expect(end.payload.output).toContain("Hello world from the doc.")
  })

  it("dual-emits chat:delta per messageDelta, token-parity with agent-event", () => {
    const deltas = watcher.chatEvents.filter((e) => e.type === "chat:delta")
    expect(deltas.map((d) => d.payload.text)).toEqual(["Final ", "answer"])
    for (const d of deltas) {
      expect(d.projectId).toBeNull()
      expect(d.payload.sessionId).toBe(sessionId)
      expect(d.payload.runId).toBe(runId)
      expect(d.payload.projectId).toBe(numericProjectId)
    }
    // Token parity with the agent-event messageDelta frames.
    const agentDeltas = watcher.agentEvents.filter((f) => f.event.type === "messageDelta").map((f) => f.event.text)
    expect(deltas.map((d) => d.payload.text)).toEqual(agentDeltas)
  })

  it("dual-emits chat:done with the accumulated content + references", () => {
    const done = watcher.chatEvents.filter((e) => e.type === "chat:done")
    expect(done).toHaveLength(1)
    expect(done[0].projectId).toBeNull()
    const p = done[0].payload
    expect(p.sessionId).toBe(sessionId)
    expect(p.runId).toBe(runId)
    expect(p.projectId).toBe(numericProjectId)
    // content = the turn's accumulated full text (a tab that missed the
    // deltas can finalize from it alone).
    expect(p.content).toBe("Final answer")
    expect(p.references).toHaveLength(1)
    expect(p.references[0]).toMatchObject({ kind: "source", path: "raw/sources/doc.md", title: "doc.md" })
  })

  it("emits the chat:* frames in the charter order", () => {
    expect(watcher.chatEvents.map((e) => e.type)).toEqual([
      "chat:toolStart", "chat:toolEnd", "chat:delta", "chat:delta", "chat:done",
    ])
  })
})

describe("blocking (non-stream) turns dual-emit chat:delta only", () => {
  it("emits chat:delta for the blocking messageDelta but no chat:done (no done agent-event on this path)", async () => {
    const sessionId = "conv_dual_blocking"
    const runId = "run-dual-blocking"
    blockingCallMock.mockImplementationOnce(async () => ({ content: "Blocked answer", toolCalls: [] }))

    const watcher = watchSession(sessionId)
    try {
      const result = await agentStartTurn({
        projectId: PROJECT_UUID,
        request: turnRequest(sessionId, runId, "Blocking question"),
      })
      expect(result.message).toBe("Blocked answer")

      expect(watcher.chatEvents.map((e) => e.type)).toEqual(["chat:delta"])
      expect(watcher.chatEvents[0].payload).toEqual({
        sessionId, runId, projectId: numericProjectId, text: "Blocked answer",
      })
      // No agent-event done on the blocking path ⇒ no chat:done either.
      expect(watcher.agentEvents.map((f) => f.event.type)).toEqual(["messageDelta"])
    } finally {
      watcher.unsub()
    }
  })
})

describe("error site keeps agent-event byte-identical and duals a terminal chat:done", () => {
  // Review fix (PR #29 round 1): a tab previewing a run via chat:* frames
  // has no agent-event consumer; without a terminal chat frame its
  // isStreaming stays true forever on error/cancel and all send paths lock.
  // The error site therefore duals a terminal chat:done mirroring the owning
  // tab's catch-path outcome: failed runs finalize as "Error: <message>",
  // cancelled runs end with empty content (sse-sync resets the stream
  // without adding a message).
  it("failed run: error + companion textless done agent-events, terminal chat:done with the error text", async () => {
    const sessionId = "conv_dual_error"
    const runId = "run-dual-error"
    streamCallMock.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "partial " }
      throw new Error("llm exploded")
    })

    const watcher = watchSession(sessionId)
    try {
      await agentStartTurnStream({
        projectId: PROJECT_UUID,
        request: turnRequest(sessionId, runId, "Doomed question"),
      })
      await watcher.waitDone()

      // agent-event stream unchanged: deltas, error, companion textless done.
      expect(watcher.agentEvents.map((f) => f.event.type)).toEqual(["messageDelta", "error", "done"])
      expect(watcher.agentEvents[1].event.message).toBe("llm exploded")
      expect(watcher.agentEvents[2].event).toEqual({ type: "done" })

      // One terminal chat:done, attributed to the projects row, carrying the
      // same "Error: <message>" text the owning tab's catch path finalizes.
      const dones = watcher.chatEvents.filter((e) => e.type === "chat:done")
      expect(dones).toHaveLength(1)
      expect(dones[0].projectId).toBeNull()
      expect(dones[0].payload).toEqual({
        sessionId, runId, projectId: numericProjectId,
        content: "Error: llm exploded", references: [],
      })
      // The partial delta still dualized, so the frame order is preview → terminal.
      expect(watcher.chatEvents.map((e) => e.type)).toEqual(["chat:delta", "chat:done"])
    } finally {
      watcher.unsub()
    }
  })

  it("cancelled run: terminal chat:done carries empty content (reset, no message)", async () => {
    const sessionId = "conv_dual_cancel"
    const runId = "run-dual-cancel"
    streamCallMock.mockImplementationOnce(async function* ({ signal }) {
      yield { type: "delta", text: "partial " }
      // Block until the cancel aborts the call (the runLoop cancellation
      // checks only run between yielded events).
      await new Promise((_, reject) => {
        if (signal?.aborted) return reject(new Error("The operation was aborted"))
        signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")), { once: true })
      })
    })

    const watcher = watchSession(sessionId)
    try {
      await agentStartTurnStream({
        projectId: PROJECT_UUID,
        request: turnRequest(sessionId, runId, "Interrupted question"),
      })
      // Wait for the first delta so the run is provably in flight, then cancel.
      await vi.waitFor(() => {
        expect(watcher.chatEvents.some((e) => e.type === "chat:delta")).toBe(true)
      })
      const { agentCancelTurn } = await import("../src/agent.js")
      await agentCancelTurn({ runId })
      await watcher.waitDone()

      expect(watcher.agentEvents.map((f) => f.event.type)).toEqual(["messageDelta", "error", "done"])
      expect(watcher.agentEvents[1].event.message).toMatch(/abort|cancel/i)

      // Terminal dual with EMPTY content: sse-sync resets isStreaming without
      // adding a message (parity with the owning tab's abort-like catch path,
      // which discards the preview).
      const dones = watcher.chatEvents.filter((e) => e.type === "chat:done")
      expect(dones).toHaveLength(1)
      expect(dones[0].payload).toEqual({
        sessionId, runId, projectId: numericProjectId,
        content: "", references: [],
      })
    } finally {
      watcher.unsub()
    }
  })
})
