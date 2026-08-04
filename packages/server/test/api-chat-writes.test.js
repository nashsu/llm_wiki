// Integration tests for POST /api/v2/projects/:id/chat/writes (issue #14 P0
// stage 9) — the server port of the client's executeIngestWrites (chat
// "Write to Wiki").
//
// Covers: the happy path (streaming agent-event frames, session rows
// persisted user+assistant, FILE blocks on disk with log-append + sources
// canonicalization + wiki/sources path substitution), unsafe/app-managed
// path rejection, the LLM-not-configured guard, and the stream-error path
// (error + done frames, finalize text persisted).
//
// ingest/llm.js's streamChat is mocked with scripted tokens; the orchestrator
// is mocked so no pipeline can start. Env vars are set BEFORE importing the
// app (it reads LLM_WIKI_DATA_DIR at module load).

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { streamChatMock } = vi.hoisted(() => ({ streamChatMock: vi.fn() }))

vi.mock("../src/ingest/llm.js", () => ({
  streamChat: (...args) => streamChatMock(...args),
  USAGE_LIMIT_BACKOFF_MS: 15 * 60 * 1000,
  isUsageLimitError: vi.fn(() => false),
  IngestLlmError: class IngestLlmError extends Error {
    constructor(message, { usageLimit = false, timeout = false } = {}) {
      super(message)
      this.name = "IngestLlmError"
      this.usageLimit = usageLimit
      this.timeout = timeout
    }
  },
}))

vi.mock("../src/ingest/orchestrator.js", () => ({
  MAX_ATTEMPTS: 3,
  startIngestOrchestrator: vi.fn(),
  stopIngestOrchestrator: vi.fn(),
  kickIngestOrchestrator: vi.fn(),
  cancelIngestTask: vi.fn(async () => true),
  activeIngestTaskCount: () => 0,
  __resetOrchestratorForTests: vi.fn(),
}))

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-chatwrites-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")
const chatStore = await import("../src/store/chat-sessions.js")
const { eventBus } = await import("../src/events/bus.js")
const { writeStoreKey } = await import("../src/store.js")

const USABLE_LLM_CONFIG = { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" }

const PROJECT_DIR = path.join(DATA_DIR, "proj")
let projectId

beforeAll(async () => {
  mkdirSync(path.join(PROJECT_DIR, "raw", "sources"), { recursive: true })
  const res = await request(app)
    .post("/api/v2/projects")
    .send({ name: "Chat Writes Project", path: PROJECT_DIR })
  expect(res.status).toBe(201)
  projectId = res.body.project.id
  // Seed AFTER scaffolding (POST /projects writes its own wiki/index.md,
  // wiki/log.md and root schema.md).
  writeFileSync(path.join(PROJECT_DIR, "wiki", "schema.md"), "# Schema\nPage types: entity, concept.\n")
  writeFileSync(path.join(PROJECT_DIR, "wiki", "index.md"), "# Index\n- wiki/log.md\n")
  writeFileSync(path.join(PROJECT_DIR, "raw", "sources", "doc.md"), "# Doc\nHello world.\n")
  writeStoreKey("app-state.json", "llmConfig", USABLE_LLM_CONFIG)
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  streamChatMock.mockReset()
})

const writesUrl = () => `/api/v2/projects/${projectId}/chat/writes`

/**
 * Subscribe to the internal bus BEFORE the request so no frame is missed.
 * The legacy emit() bridge republishes "agent-event" onto the bus with the
 * payload { sessionId, runId, event } intact.
 */
function watchEvents(sessionId) {
  const frames = []        // agent-event payloads { sessionId, runId, event }
  const fileEvents = []    // { type, payload } file:created / file:modified
  let resolveDone
  const donePromise = new Promise((resolve) => { resolveDone = resolve })
  const unsub = eventBus.subscribe((env) => {
    if (env.type === "agent-event") {
      const p = env.payload ?? {}
      if (p.sessionId !== sessionId) return
      frames.push(p)
      if (p.event?.type === "done") resolveDone()
    } else if (env.type === "file:created" || env.type === "file:modified") {
      fileEvents.push({ type: env.type, payload: env.payload })
    }
  })
  return {
    frames,
    fileEvents,
    events: () => frames.map((f) => f.event),
    async waitDone(timeoutMs = 5000) {
      await Promise.race([
        donePromise,
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`timed out waiting for done frame (got ${frames.length} frames)`)),
          timeoutMs,
        )),
      ])
      unsub()
    },
    unsub,
  }
}

describe("POST /:id/chat/writes — happy path", () => {
  const sessionId = "conv_writes_happy"

  const conceptContent = [
    "---",
    "type: concept",
    "title: Test Concept",
    "created: 2026-08-04",
    "updated: 2026-08-04",
    "tags: [demo]",
    "related: []",
    "sources: []",
    "---",
    "",
    "# Test Concept",
    "",
    "Body text.",
    "",
  ].join("\n")

  const sourceContent = [
    "---",
    "type: source",
    "title: Doc",
    "created: 2026-08-04",
    "updated: 2026-08-04",
    "tags: []",
    "related: []",
    "sources: []",
    "---",
    "",
    "# Doc summary",
    "",
  ].join("\n")

  // Any wiki/sources/* FILE path substitutes to the active source summary
  // path (wiki/sources/doc.md); log.md appends; plain pages overwrite.
  const scriptedOutput = [
    "---FILE: wiki/concepts/test-concept.md---",
    conceptContent,
    "---END FILE---",
    "---FILE: wiki/log.md---",
    "## 2026-08-04 ingest | Doc",
    "---END FILE---",
    "---FILE: wiki/sources/renamed-by-model.md---",
    sourceContent,
    "---END FILE---",
  ].join("\n")

  let response
  let watcher
  const streamCalls = []

  beforeAll(async () => {
    // Pre-existing conversation: the route must load it from SQLite and feed
    // it to the model (client parity: store.messages minus system rows).
    chatStore.ensureSession(projectId, sessionId, { title: "prior chat" })
    chatStore.appendMessage(sessionId, "user", "Tell me about the doc")
    chatStore.appendMessage(sessionId, "assistant", "It says hello to the world.")

    // Pre-existing log.md exercises the append semantics.
    writeFileSync(path.join(PROJECT_DIR, "wiki", "log.md"), "## 2026-08-01 ingest | Old entry\n")

    streamChatMock.mockImplementationOnce(async (config, messages, opts = {}) => {
      streamCalls.push({ config, messages })
      const tokens = [
        scriptedOutput.slice(0, 60),
        scriptedOutput.slice(60, 200),
        scriptedOutput.slice(200),
      ]
      for (const t of tokens) {
        opts.onToken?.(t)
        await Promise.resolve()
      }
      return scriptedOutput
    })

    watcher = watchEvents(sessionId)
    response = await request(app)
      .post(writesUrl())
      .send({ sessionId, userGuidance: "Focus on concepts", sourcePath: "raw/sources/doc.md" })
  })

  afterAll(() => watcher.unsub())

  it("returns runId + sessionId + writePrompt immediately", async () => {
    expect(response.status).toBe(200)
    expect(response.body.sessionId).toBe(sessionId)
    expect(response.body.runId).toBeTypeOf("string")
    expect(response.body.runId.length).toBeGreaterThan(0)
    expect(response.body.writePrompt).toBeTypeOf("string")
  })

  it("builds the writePrompt byte-identically (schema, index, guidance, source)", () => {
    const wp = response.body.writePrompt
    expect(wp.startsWith("Based on our discussion, please generate the wiki files that should be created or updated.\n\n"))
      .toBe(true)
    expect(wp).toContain("Additional guidance: Focus on concepts")
    expect(wp).toContain("## Wiki Schema\n# Schema\nPage types: entity, concept.")
    expect(wp).toContain("## Current Wiki Index\n# Index\n- wiki/log.md")
    expect(wp).toContain("## Source File")
    expect(wp).toContain("The original source file is: **doc.md**")
    expect(wp).toContain("it MUST use this exact path: **wiki/sources/doc.md**")
    expect(wp).toContain("---FILE: wiki/path/to/file.md---")
    expect(wp).toContain("Do not include any other text outside the FILE blocks.")
  })

  it("streams messageDelta frames, then wikiWrites, then done (matching runId)", async () => {
    await watcher.waitDone()
    const runId = response.body.runId
    for (const frame of watcher.frames) {
      expect(frame.sessionId).toBe(sessionId)
      expect(frame.runId).toBe(runId)
    }
    const events = watcher.events()
    const types = events.map((e) => e.type)
    expect(types.filter((t) => t === "messageDelta").length).toBe(3)
    expect(types[types.length - 2]).toBe("wikiWrites")
    expect(types[types.length - 1]).toBe("done")

    // Token accumulation reconstructs the full output.
    const streamed = events.filter((e) => e.type === "messageDelta").map((e) => e.text).join("")
    expect(streamed).toBe(scriptedOutput)

    const wikiWrites = events.find((e) => e.type === "wikiWrites")
    expect(wikiWrites.writtenPaths).toEqual([
      "wiki/concepts/test-concept.md",
      "wiki/log.md",
      "wiki/sources/doc.md",
    ])

    const done = events[events.length - 1]
    expect(done.text).toBe(scriptedOutput)
  })

  it("persists user writePrompt + assistant output as session rows", async () => {
    await watcher.waitDone()
    const messages = chatStore.listMessages(sessionId)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(messages[2].content).toBe(response.body.writePrompt)
    expect(messages[3].content).toBe(scriptedOutput)
  })

  it("sends system prompt + loaded history + writePrompt to the LLM", async () => {
    expect(streamCalls).toHaveLength(1)
    const { config, messages } = streamCalls[0]
    expect(config).toMatchObject({ provider: "openai", model: "gpt-4o-mini" })
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(messages[0].content.startsWith("You are a wiki generation assistant.")).toBe(true)
    expect(messages[0].content).toContain("MANDATORY OUTPUT LANGUAGE")
    expect(messages[0].content).toContain("## Wiki Schema")
    expect(messages[1].content).toBe("Tell me about the doc")
    expect(messages[2].content).toBe("It says hello to the world.")
    expect(messages[3].content).toBe(response.body.writePrompt)
  })

  it("writes the files: plain write, log append, sources canonicalization", async () => {
    await watcher.waitDone()

    // canonicalizeSourcesField injects the active identity into every
    // non-log/non-listing page's `sources` field (client parity). The naive
    // client semantics write the block content AS-IS — including the
    // trailing newline captured before `---END FILE---` (only log.md is
    // trimmed).
    const expectedConcept = conceptContent.replace("sources: []", 'sources: ["doc.md"]') + "\n"
    const conceptPath = path.join(PROJECT_DIR, "wiki", "concepts", "test-concept.md")
    expect(existsSync(conceptPath)).toBe(true)
    expect(readFileSync(conceptPath, "utf8")).toBe(expectedConcept)

    // log.md: existing content (trailing newline intact) + "\n\n" + trimmed
    // block content — the client's exact append semantics.
    const logContent = readFileSync(path.join(PROJECT_DIR, "wiki", "log.md"), "utf8")
    expect(logContent).toBe("## 2026-08-01 ingest | Old entry\n\n\n## 2026-08-04 ingest | Doc")

    // wiki/sources/renamed-by-model.md was substituted to the active source
    // summary path; the model's output never lands at its own path.
    expect(existsSync(path.join(PROJECT_DIR, "wiki", "sources", "renamed-by-model.md"))).toBe(false)
    const sourcePage = readFileSync(path.join(PROJECT_DIR, "wiki", "sources", "doc.md"), "utf8")
    // canonicalizeSourcesField injected the active identity into `sources`.
    expect(sourcePage).toContain('sources: ["doc.md"]')
    expect(sourcePage).toContain("# Doc summary")
  })

  it("emits file:created / file:modified events so sse-sync refreshes trees", async () => {
    await watcher.waitDone()
    const byPath = Object.fromEntries(watcher.fileEvents.map((e) => [e.payload.path, e.type]))
    expect(byPath["wiki/concepts/test-concept.md"]).toBe("file:created")
    expect(byPath["wiki/log.md"]).toBe("file:modified")
    expect(byPath["wiki/sources/doc.md"]).toBe("file:created")
    for (const e of watcher.fileEvents) {
      expect(e.payload.projectId).toBe(projectId)
    }
  })
})

describe("POST /:id/chat/writes — unsafe and app-managed paths", () => {
  it("rejects traversal and app-managed aggregate paths with the client's warn", async () => {
    const sessionId = "conv_writes_unsafe"
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const output = [
      "---FILE: ../../../evil.md---",
      "pwn",
      "---END FILE---",
      "---FILE: wiki/index.md---",
      "pwn the index",
      "---END FILE---",
      "---FILE: wiki/concepts/safe.md---",
      "ok content",
      "---END FILE---",
    ].join("\n")
    streamChatMock.mockImplementationOnce(async (_c, _m, opts = {}) => {
      opts.onToken?.(output)
      return output
    })

    const watcher = watchEvents(sessionId)
    try {
      const res = await request(app).post(writesUrl()).send({ sessionId })
      expect(res.status).toBe(200)
      await watcher.waitDone()

      const wikiWrites = watcher.events().find((e) => e.type === "wikiWrites")
      expect(wikiWrites.writtenPaths).toEqual(["wiki/concepts/safe.md"])
      expect(existsSync(path.join(PROJECT_DIR, "..", "evil.md"))).toBe(false)
      // wiki/index.md exists from project scaffolding — the rejection must
      // leave its content untouched (app-managed aggregate guard).
      expect(readFileSync(path.join(PROJECT_DIR, "wiki", "index.md"), "utf8"))
        .toBe("# Index\n- wiki/log.md\n")
      expect(existsSync(path.join(PROJECT_DIR, "wiki", "concepts", "safe.md"))).toBe(true)
      expect(warnSpy).toHaveBeenCalledWith(
        "[executeIngestWrites] rejected unsafe or app-managed path: ../../../evil.md",
      )
      expect(warnSpy).toHaveBeenCalledWith(
        "[executeIngestWrites] rejected unsafe or app-managed path: wiki/index.md",
      )
    } finally {
      warnSpy.mockRestore()
      watcher.unsub()
    }
  })
})

describe("POST /:id/chat/writes — LLM not configured", () => {
  it("fails synchronously with the orchestrator's exact message", async () => {
    writeStoreKey("app-state.json", "llmConfig", {})
    try {
      const res = await request(app)
        .post(writesUrl())
        .send({ sessionId: "conv_writes_nollm" })
      expect(res.status).toBe(502)
      expect(res.body.error.code).toBe("UPSTREAM_ERROR")
      expect(res.body.error.message).toBe("LLM not configured — set API key in Settings")
      expect(streamChatMock).not.toHaveBeenCalled()
    } finally {
      writeStoreKey("app-state.json", "llmConfig", USABLE_LLM_CONFIG)
    }
  })

  it("validates the body (sessionId required)", async () => {
    const res = await request(app).post(writesUrl()).send({ userGuidance: "no session" })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })
})

describe("POST /:id/chat/writes — stream error path", () => {
  it("emits error + done and persists the client's finalize text", async () => {
    const sessionId = "conv_writes_error"
    streamChatMock.mockRejectedValueOnce(new Error("provider exploded"))

    const watcher = watchEvents(sessionId)
    try {
      const res = await request(app).post(writesUrl()).send({ sessionId })
      expect(res.status).toBe(200)
      await watcher.waitDone()

      const events = watcher.events()
      expect(events.map((e) => e.type)).toEqual(["error", "done"])
      expect(events[0].message).toBe("Error generating wiki files: provider exploded")
      expect(events[1]).toEqual({ type: "done" })

      // Client parity: onError finalizeStream persists the error text as the
      // assistant message, right after the user writePrompt row.
      const messages = chatStore.listMessages(sessionId)
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ["user", res.body.writePrompt],
        ["assistant", "Error generating wiki files: provider exploded"],
      ])
    } finally {
      watcher.unsub()
    }
  })
})

describe("POST /:id/chat/writes — outputLanguage parity", () => {
  // Client parity (src/lib/output-language.ts getOutputLanguage): an
  // explicitly configured outputLanguage wins; "auto" falls back to
  // detecting from the history text. The wiki-store setting mirrors into
  // app-state.json, which the route reads.
  it("honors a configured outputLanguage; auto-detects when unset", async () => {
    const systemPrompts = []
    streamChatMock.mockImplementation(async (_config, messages) => {
      systemPrompts.push(messages[0].content)
      return "" // no FILE blocks — nothing to write
    })

    try {
      writeStoreKey("app-state.json", "outputLanguage", "Chinese")
      let watcher = watchEvents("conv_writes_lang_zh")
      await request(app).post(writesUrl()).send({ sessionId: "conv_writes_lang_zh" })
      await watcher.waitDone()

      writeStoreKey("app-state.json", "outputLanguage", "auto")
      watcher = watchEvents("conv_writes_lang_auto")
      await request(app).post(writesUrl()).send({ sessionId: "conv_writes_lang_auto" })
      await watcher.waitDone()
    } finally {
      writeStoreKey("app-state.json", "outputLanguage", "auto")
    }

    expect(systemPrompts).toHaveLength(2)
    expect(systemPrompts[0]).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
    // English history ("Tell me..." style prior messages are absent here, so
    // detection falls back to the default English).
    expect(systemPrompts[1]).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })
})
