import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chatMessagesToLLM, useChatStore, type DisplayMessage } from "./chat-store"

function resetChatStore(): void {
  useChatStore.getState().clearAgentPermissionRequests()
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    streamingContent: "",
    mode: "chat",
    ingestSource: null,
    maxHistoryMessages: 10,
    activeAgentPermissionRequest: null,
    queuedAgentPermissionRequests: [],
  })
}

function makeAssistantMessage(id: string, conversationId: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    content: "working",
    timestamp: 0,
    conversationId,
    mode: "agent",
  }
}

describe("chat store agent data model", () => {
  beforeEach(() => {
    resetChatStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetChatStore()
  })

  it("defaults to chat mode and accepts agent mode", () => {
    expect(useChatStore.getState().mode).toBe("chat")

    useChatStore.getState().setMode("agent")

    expect(useChatStore.getState().mode).toBe("agent")
  })

  it("keeps addMessage backward compatible for ordinary messages", () => {
    const convId = useChatStore.getState().createConversation()

    useChatStore.getState().addMessage("user", "hello")

    expect(useChatStore.getState().messages).toMatchObject([
      {
        role: "user",
        content: "hello",
        conversationId: convId,
      },
    ])
    expect(useChatStore.getState().messages[0].mode).toBeUndefined()
  })

  it("stores agent metadata when addMessage receives options", () => {
    const convId = useChatStore.getState().createConversation()

    useChatStore.getState().addMessage("user", "run task", {
      mode: "agent",
      agentSessionId: "session-1",
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "user",
      content: "run task",
      conversationId: convId,
      mode: "agent",
      agentSessionId: "session-1",
    })
  })

  it("keeps finalizeStream ordinary assistant output free of agent metadata", () => {
    useChatStore.getState().createConversation()
    useChatStore.setState({ isStreaming: true, streamingContent: "partial" })

    useChatStore.getState().finalizeStream("done")

    const message = useChatStore.getState().messages[0]
    expect(message).toMatchObject({
      role: "assistant",
      content: "done",
    })
    expect(message.mode).toBeUndefined()
    expect(message.agentSessionId).toBeUndefined()
    expect(message.costUsd).toBeUndefined()
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("finalizeAgentStream stores stats and updates conversation session", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({ isStreaming: true, streamingContent: "partial" })

    useChatStore.getState().finalizeAgentStream("agent done", {
      agentSessionId: "agent-session-1",
      costUsd: 0.12,
      inputTokens: 100,
      outputTokens: 40,
      durationMs: 2500,
      numTurns: 3,
    })

    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "assistant",
      content: "agent done",
      conversationId: convId,
      mode: "agent",
      agentSessionId: "agent-session-1",
      costUsd: 0.12,
      inputTokens: 100,
      outputTokens: 40,
      durationMs: 2500,
      numTurns: 3,
    })
    expect(useChatStore.getState().conversations[0].agentSessionId).toBe("agent-session-1")
    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingContent).toBe("")
  })

  it("setAgentToolCalls replaces one message's tool calls only", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [
        makeAssistantMessage("m1", convId),
        makeAssistantMessage("m2", convId),
      ],
    })

    useChatStore.getState().setAgentToolCalls("m1", [
      {
        toolName: "wiki_read",
        toolUseId: "tool-1",
        phase: "pre",
      },
    ])

    expect(useChatStore.getState().messages[0].toolCalls).toEqual([
      {
        toolName: "wiki_read",
        toolUseId: "tool-1",
        phase: "pre",
      },
    ])
    expect(useChatStore.getState().messages[1].toolCalls).toBeUndefined()
  })

  it("updateAgentProgress upserts by toolUseId and overwrites status fields", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().updateAgentProgress("m1", {
      toolName: "wiki_read",
      toolUseId: "tool-1",
      phase: "pre",
      inputPreview: { path: "wiki/index.md" },
    })
    useChatStore.getState().updateAgentProgress("m1", {
      toolName: "wiki_read",
      toolUseId: "tool-1",
      phase: "post",
      ok: true,
      durationMs: 25,
    })

    expect(useChatStore.getState().messages[0].toolCalls).toEqual([
      {
        toolName: "wiki_read",
        toolUseId: "tool-1",
        phase: "post",
        inputPreview: { path: "wiki/index.md" },
        ok: true,
        durationMs: 25,
      },
    ])
  })

  it("updateAgentProgress falls back to toolName when toolUseId is missing", () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.setState({
      messages: [makeAssistantMessage("m1", convId)],
    })

    useChatStore.getState().updateAgentProgress("m1", {
      toolName: "wiki_search",
      phase: "pre",
    })
    useChatStore.getState().updateAgentProgress("m1", {
      toolName: "wiki_search",
      phase: "failure",
      error: "boom",
    })

    expect(useChatStore.getState().messages[0].toolCalls).toEqual([
      {
        toolName: "wiki_search",
        phase: "failure",
        ok: false,
        error: "boom",
      },
    ])
  })

  it("chatMessagesToLLM drops agent metadata", () => {
    const messages: DisplayMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "answer",
        timestamp: 0,
        conversationId: "conv-1",
        mode: "agent",
        agentSessionId: "session-1",
        agentBlocks: [
          { type: "tool_use", id: "tool-1", name: "wiki_read", input: { path: "wiki/index.md" } },
        ],
        toolCalls: [{ toolName: "wiki_read", phase: "post", ok: true }],
        costUsd: 0.1,
      },
    ]

    expect(chatMessagesToLLM(messages)).toEqual([
      {
        role: "assistant",
        content: "answer",
      },
    ])
  })

  it("starts with no pending agent permission request", () => {
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
    expect(useChatStore.getState().queuedAgentPermissionRequests).toEqual([])
  })

  it("resolves the active agent permission request", async () => {
    const promise = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: { command: "pwd" },
      toolUseID: "tool-1",
    })

    expect(useChatStore.getState().activeAgentPermissionRequest).toMatchObject({
      requestId: "permission-1",
      toolName: "Bash",
    })

    useChatStore.getState().resolveAgentPermission("permission-1", {
      behavior: "allow",
      decisionClassification: "user_temporary",
    })

    await expect(promise).resolves.toEqual({
      behavior: "allow",
      decisionClassification: "user_temporary",
    })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
  })

  it("queues concurrent agent permission requests serially", async () => {
    const first = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    })
    const second = useChatStore.getState().requestAgentPermission({
      requestId: "permission-2",
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-2",
    })

    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-1")
    expect(useChatStore.getState().queuedAgentPermissionRequests).toHaveLength(1)

    useChatStore.getState().resolveAgentPermission("permission-1", {
      behavior: "deny",
      message: "no",
    })

    await expect(first).resolves.toMatchObject({ behavior: "deny" })
    expect(useChatStore.getState().activeAgentPermissionRequest?.requestId).toBe("permission-2")

    useChatStore.getState().resolveAgentPermission("permission-2", {
      behavior: "allow",
    })
    await expect(second).resolves.toMatchObject({ behavior: "allow" })
  })

  it("auto-denies an active agent permission request after the timeout", async () => {
    vi.useFakeTimers()
    const promise = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    }, 1_000)

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(promise).resolves.toMatchObject({
      behavior: "deny",
      decisionClassification: "user_reject",
    })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
  })

  it("clears active and queued permission requests without touching chat data", async () => {
    const convId = useChatStore.getState().createConversation()
    useChatStore.getState().addMessage("user", "hello")
    const first = useChatStore.getState().requestAgentPermission({
      requestId: "permission-1",
      toolName: "Bash",
      inputPreview: {},
      toolUseID: "tool-1",
    })
    const second = useChatStore.getState().requestAgentPermission({
      requestId: "permission-2",
      toolName: "Edit",
      inputPreview: {},
      toolUseID: "tool-2",
    })

    useChatStore.getState().clearAgentPermissionRequests({
      behavior: "deny",
      interrupt: true,
      message: "stopped",
    })

    await expect(first).resolves.toMatchObject({ behavior: "deny", interrupt: true })
    await expect(second).resolves.toMatchObject({ behavior: "deny", interrupt: true })
    expect(useChatStore.getState().activeAgentPermissionRequest).toBeNull()
    expect(useChatStore.getState().queuedAgentPermissionRequests).toEqual([])
    expect(useChatStore.getState().conversations[0].id).toBe(convId)
    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    })
  })
})
