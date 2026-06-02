import { beforeEach, describe, expect, it } from "vitest"
import { chatMessagesToLLM, useChatStore, type DisplayMessage } from "./chat-store"

function resetChatStore(): void {
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: [],
    isStreaming: false,
    streamingContent: "",
    mode: "chat",
    ingestSource: null,
    maxHistoryMessages: 10,
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
})
