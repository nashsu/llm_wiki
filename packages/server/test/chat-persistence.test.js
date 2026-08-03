// Agent-loop persistence tests (issue #21).
//
// The chat agent runtime must read/write through the SQLite persistence
// layer instead of a client-held history round-trip:
//   - the session row is created lazily on first turn (titled from the
//     first user message, mirroring the client);
//   - the user message persists when the turn starts;
//   - the assistant message persists (with references) when the turn
//     completes;
//   - the next turn's model call receives the messages loaded from the DB;
//   - an approval-boundary re-send (resume: true) does not duplicate the
//     user message;
//   - historyLimit caps how many prior messages feed the model.
//
// llm-call.js is mocked so no real LLM is touched; everything else (store
// resolution, project registry, SQLite writers) is the real code path.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { llmCalls } = vi.hoisted(() => ({ llmCalls: [] }))

vi.mock("../src/llm-call.js", () => ({
  streamCall: async function* (opts) {
    llmCalls.push(opts)
    yield { type: "delta", text: "Mocked assistant answer" }
    yield { type: "finish" }
  },
  blockingCall: async (opts) => {
    llmCalls.push(opts)
    return { content: "Mocked assistant answer", toolCalls: [] }
  },
}))

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-chatpersist-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const PROJECT_UUID = "persist-proj-uuid"
const PROJECT_PATH = path.join(DATA_DIR, "persist-proj")
const PROJECT_B_UUID = "persist-proj-b-uuid"
const PROJECT_B_PATH = path.join(DATA_DIR, "persist-proj-b")

beforeAll(() => {
  mkdirSync(path.join(PROJECT_PATH, ".llm-wiki"), { recursive: true })
  mkdirSync(path.join(PROJECT_B_PATH, ".llm-wiki"), { recursive: true })
  mkdirSync(path.join(DATA_DIR, "stores"), { recursive: true })
  writeFileSync(path.join(DATA_DIR, "stores", "app-state.json"), JSON.stringify({
    projectRegistry: {
      [PROJECT_UUID]: { id: PROJECT_UUID, path: PROJECT_PATH },
      [PROJECT_B_UUID]: { id: PROJECT_B_UUID, path: PROJECT_B_PATH },
    },
    llmConfig: { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" },
  }))
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

const { agentStartTurn } = await import("../src/agent.js")
const chatStore = await import("../src/store/chat-sessions.js")
const projectsStore = await import("../src/store/projects.js")

function turnRequest(sessionId, message, extra = {}) {
  return {
    message,
    sessionId,
    runId: `run-${Math.random().toString(36).slice(2)}`,
    mode: "standard",
    tools: { wiki: false, web: false, anytxt: false },
    topK: 5,
    includeContent: false,
    skills: [],
    resume: false,
    ...extra,
  }
}

describe("agent loop persists sessions and messages in SQLite", () => {
  const sessionId = "conv_test_persist"

  it("creates the session lazily and persists the first turn", async () => {
    const result = await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "What is this wiki about?"),
    })
    expect(result.message).toBe("Mocked assistant answer")

    const session = chatStore.getSessionByUuid(sessionId)
    expect(session).not.toBeNull()
    expect(session.title).toBe("What is this wiki about?")

    const messages = chatStore.listMessages(sessionId)
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "What is this wiki about?"],
      ["assistant", "Mocked assistant answer"],
    ])
  })

  it("loads prior messages from the DB into the next turn's model call", async () => {
    llmCalls.length = 0
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "Follow-up question"),
    })

    expect(llmCalls).toHaveLength(1)
    const sent = llmCalls[0].messages
    // system + prior user + prior assistant + new user — loaded from SQLite,
    // not from a client-supplied history array (none was sent).
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(sent[1].content).toBe("What is this wiki about?")
    expect(sent[2].content).toBe("Mocked assistant answer")
    expect(sent[3].content).toBe("Follow-up question")

    const messages = chatStore.listMessages(sessionId)
    expect(messages).toHaveLength(4)
    expect(messages[3]).toMatchObject({ role: "assistant", content: "Mocked assistant answer" })
  })

  it("does not duplicate the user message on an approval-boundary resume", async () => {
    const before = chatStore.listMessages(sessionId).length
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "What is this wiki about?", { resume: true }),
    })
    const messages = chatStore.listMessages(sessionId)
    // Only the assistant reply was appended; the user message was already
    // persisted by the original turn.
    expect(messages.length).toBe(before + 1)
    expect(messages[messages.length - 1].role).toBe("assistant")
    const userMessages = messages.filter((m) => m.content === "What is this wiki about?")
    expect(userMessages).toHaveLength(1)
  })

  it("honors historyLimit when loading prior messages", async () => {
    llmCalls.length = 0
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "Another question", { historyLimit: 1 }),
    })
    const sent = llmCalls[0].messages
    // system + exactly 1 prior message + the new user message.
    expect(sent).toHaveLength(3)
    expect(sent[0].role).toBe("system")
    expect(sent[2].content).toBe("Another question")
  })

  it("persists assistant references alongside the message", async () => {
    const otherSession = "conv_test_refs"
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(otherSession, "Question with references"),
    })
    const messages = chatStore.listMessages(otherSession)
    expect(messages).toHaveLength(2)
    // The mocked LLM makes no tool calls, so no references are attached —
    // the refs column stays empty rather than storing "[]".
    expect(messages[1].references).toBeUndefined()

    // Store-level round-trip: references attached to an assistant message
    // survive the JSON refs column.
    const refs = [{ kind: "wiki", path: "wiki/concepts/test.md", title: "Test" }]
    chatStore.appendMessage(otherSession, "assistant", "With refs", refs)
    const after = chatStore.listMessages(otherSession)
    expect(after[after.length - 1]).toMatchObject({ role: "assistant", content: "With refs", references: refs })
  })
})

describe("regenerate + isolation (issue #21 review fixes)", () => {
  const sessionId = "conv_test_regen"

  it("regenerate replaces the last exchange instead of duplicating it", async () => {
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "Original question"),
    })
    expect(chatStore.listMessages(sessionId)).toHaveLength(2)

    llmCalls.length = 0
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "Original question", { regenerate: true }),
    })

    // DB transcript stays [user, assistant] — the old pair was dropped before
    // the re-run, not left behind as [u, a_old, u, a_new].
    const messages = chatStore.listMessages(sessionId)
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Original question"],
      ["assistant", "Mocked assistant answer"],
    ])

    // The dropped pair must not feed the model either: system + new user only.
    const sent = llmCalls[0].messages
    expect(sent.map((m) => m.role)).toEqual(["system", "user"])
    expect(sent[1].content).toBe("Original question")
  })

  it("rejects a turn that tries to adopt another project's session", async () => {
    await expect(agentStartTurn({
      projectId: PROJECT_B_UUID,
      request: turnRequest(sessionId, "intruder turn"),
    })).rejects.toThrow(/belongs to another project/)

    // The foreign session's transcript is untouched.
    expect(chatStore.listMessages(sessionId)).toHaveLength(2)
    expect(chatStore.listSessions(
      chatStore.getSessionByUuid(sessionId).projectId
    ).some((s) => s.id === sessionId)).toBe(true)
  })
})

describe("dropLastExchange store semantics (issue #21 review fixes)", () => {
  it("drops assistant+user pair, and a lone trailing user message", () => {
    const project = projectsStore.ensureProjectRow({ uuid: "drop-proj-uuid", path: PROJECT_PATH })
    const sid = "conv_test_drop"
    chatStore.createSession(project.id, { uuid: sid, title: "drop" })
    chatStore.appendMessage(sid, "user", "u1")
    chatStore.appendMessage(sid, "assistant", "a1")
    chatStore.appendMessage(sid, "user", "u2")
    chatStore.appendMessage(sid, "assistant", "a2")

    chatStore.dropLastExchange(sid)
    expect(chatStore.listMessages(sid).map((m) => m.content)).toEqual(["u1", "a1"])

    // Lone trailing user message (cancelled/errored turn) drops alone.
    chatStore.appendMessage(sid, "user", "u3")
    chatStore.dropLastExchange(sid)
    expect(chatStore.listMessages(sid).map((m) => m.content)).toEqual(["u1", "a1"])

    // The remaining pair drops too, then the session is empty and further
    // drops are no-ops (as is an unknown session uuid).
    chatStore.dropLastExchange(sid)
    expect(chatStore.listMessages(sid)).toHaveLength(0)
    expect(() => chatStore.dropLastExchange(sid)).not.toThrow()
    expect(() => chatStore.dropLastExchange("conv_missing")).not.toThrow()
  })
})
