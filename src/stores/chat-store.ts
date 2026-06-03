import { create } from "zustand"
import type { ChatMessage } from "@/lib/llm-client"
import type {
  AgentWikiChangedPayload,
  AgentPermissionDecision,
  AgentPermissionRequestPayload,
  SDKContentBlock,
} from "@/lib/agent/agent-types"
import i18n from "@/i18n"

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  agentSessionId?: string
  agentForkSessionPending?: boolean
}

export interface MessageReference {
  title: string
  path: string
  kind?: "wiki" | "external"
  source?: string
  url?: string
  snippet?: string
}

export interface DisplayMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  conversationId: string
  references?: MessageReference[]  // pages cited in this response, saved at creation time
  mode?: "chat" | "agent"
  agentSessionId?: string
  agentUserMessageId?: string
  agentAssistantMessageId?: string
  agentBlocks?: SDKContentBlock[]
  wikiChanges?: AgentWikiChangeRecord[]
  toolCalls?: AgentToolCallRecord[]
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  numTurns?: number
}

/** Agent tool-call event snapshot persisted on an assistant message. */
export interface AgentToolCallRecord {
  toolName: string
  toolUseId?: string
  phase: "pre" | "post" | "failure" | "batch"
  ok?: boolean
  durationMs?: number
  inputPreview?: Record<string, unknown>
  error?: string
}

/** Final per-message Agent run statistics emitted by the sidecar result event. */
export interface AgentStreamStats {
  agentSessionId?: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  numTurns?: number
}

/** Wiki file change emitted during an Agent run and persisted with the message. */
export interface AgentWikiChangeRecord extends AgentWikiChangedPayload {
  timestamp: number
}

/** Runtime-only Agent permission request shown in the approval dialog. */
export interface AgentPermissionRequestRecord extends AgentPermissionRequestPayload {
  receivedAt: number
  expiresAt: number
  timeoutMs: number
}

/** Runtime-only rewind target; live stream ids are intentionally not persisted. */
export interface AgentRewindRequestRecord {
  chatMessageId: string
  streamId: string
  userMessageId: string
  assistantMessageId?: string
  requestedAt: number
}

interface AddMessageOptions {
  mode?: DisplayMessage["mode"]
  agentSessionId?: string
  references?: MessageReference[]
}

interface StartAgentStreamMessageOptions {
  agentSessionId?: string
}

interface AgentStreamMessagePatch {
  content?: string
  agentBlocks?: SDKContentBlock[]
  toolCalls?: AgentToolCallRecord[]
  agentUserMessageId?: string
  agentAssistantMessageId?: string
  wikiChanges?: AgentWikiChangeRecord[]
}

interface AgentRewindablePatch {
  streamId?: string
  userMessageId?: string
  assistantMessageId?: string
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingContent: string
  mode: "chat" | "agent" | "ingest"
  ingestSource: string | null
  maxHistoryMessages: number
  activeAgentPermissionRequest: AgentPermissionRequestRecord | null
  queuedAgentPermissionRequests: AgentPermissionRequestRecord[]
  agentRewindTargets: Record<string, AgentRewindRequestRecord>
  activeAgentRewindRequest: AgentRewindRequestRecord | null

  // Conversation management
  createConversation: () => string
  forkAgentConversation: (sourceId: string) => string | null
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  renameConversation: (id: string, title: string) => void

  // Message management
  addMessage: (role: DisplayMessage["role"], content: string, options?: AddMessageOptions) => void
  setMessages: (messages: DisplayMessage[]) => void
  setConversations: (conversations: Conversation[]) => void
  setStreaming: (streaming: boolean) => void
  appendStreamToken: (token: string) => void
  finalizeStream: (content: string, references?: MessageReference[]) => void
  finalizeAgentStream: (content: string, stats?: AgentStreamStats) => void
  startAgentStreamMessage: (options?: StartAgentStreamMessageOptions) => string | null
  updateAgentStreamMessage: (messageId: string, patch: AgentStreamMessagePatch) => void
  finishAgentStreamMessage: (messageId: string, content: string, stats?: AgentStreamStats) => void
  setAgentToolCalls: (messageId: string, toolCalls: AgentToolCallRecord[]) => void
  updateAgentProgress: (messageId: string, event: AgentToolCallRecord) => void
  appendAgentWikiChange: (messageId: string, payload: AgentWikiChangedPayload) => void
  markAgentMessageRewindable: (messageId: string, payload: AgentRewindablePatch) => void
  requestAgentRewind: (messageId: string) => void
  clearAgentRewindRequest: () => void
  /** Queue an Agent permission request and resolve when the user decides or timeout denies it. */
  requestAgentPermission: (
    payload: AgentPermissionRequestPayload,
    timeoutMs?: number
  ) => Promise<AgentPermissionDecision>
  /** Resolve one pending Agent permission request and promote the next queued request. */
  resolveAgentPermission: (requestId: string, decision: AgentPermissionDecision) => void
  /** Deny and clear all active/queued Agent permission requests. */
  clearAgentPermissionRequests: (decision?: AgentPermissionDecision) => void
  setMode: (mode: ChatState["mode"]) => void
  setIngestSource: (path: string | null) => void
  clearMessages: () => void
  setMaxHistoryMessages: (n: number) => void
  removeLastAssistantMessage: () => void  // for regenerate: remove last assistant reply

  // Helpers
  getActiveMessages: () => DisplayMessage[]
}

function nextId(): string {
  return crypto.randomUUID()
}

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

const DEFAULT_AGENT_PERMISSION_TIMEOUT_MS = 60_000

const pendingAgentPermissionResolvers = new Map<
  string,
  {
    resolve: (decision: AgentPermissionDecision) => void
    timer: ReturnType<typeof setTimeout> | null
  }
>()

function defaultDenyPermissionDecision(message: string): AgentPermissionDecision {
  return {
    behavior: "deny",
    message,
    decisionClassification: "user_reject",
  }
}

function startAgentPermissionTimer(request: AgentPermissionRequestRecord): AgentPermissionRequestRecord {
  const pending = pendingAgentPermissionResolvers.get(request.requestId)
  if (pending?.timer) clearTimeout(pending.timer)
  const expiresAt = Date.now() + request.timeoutMs
  const activeRequest = { ...request, expiresAt }
  if (pending) {
    pending.timer = setTimeout(() => {
      useChatStore.getState().resolveAgentPermission(
        request.requestId,
        defaultDenyPermissionDecision(i18n.t("agent.permission.timeoutDenied"))
      )
    }, request.timeoutMs)
  }
  return activeRequest
}

export const useChatStore = create<ChatState>((set, get) => ({
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
  agentRewindTargets: {},
  activeAgentRewindRequest: null,

  createConversation: () => {
    const id = generateConversationId()
    const now = Date.now()
    const newConversation: Conversation = {
      id,
      title: i18n.t("chat.newConversation"),
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      conversations: [newConversation, ...state.conversations],
      activeConversationId: id,
    }))
    return id
  },

  forkAgentConversation: (sourceId) => {
    const source = get().conversations.find((conversation) => conversation.id === sourceId)
    if (!source?.agentSessionId) return null
    const id = generateConversationId()
    const now = Date.now()
    const newConversation: Conversation = {
      id,
      title: `${i18n.t("agent.session.forkPrefix")} ${source.title}`,
      createdAt: now,
      updatedAt: now,
      agentSessionId: source.agentSessionId,
      agentForkSessionPending: true,
    }
    set((state) => ({
      conversations: [newConversation, ...state.conversations],
      activeConversationId: id,
      activeAgentRewindRequest: null,
    }))
    return id
  },

  deleteConversation: (id) =>
    set((state) => {
      const remaining = state.conversations.filter((c) => c.id !== id)
      const removedMessageIds = new Set(
        state.messages
          .filter((m) => m.conversationId === id)
          .map((m) => m.id)
      )
      const nextRewindTargets = Object.fromEntries(
        Object.entries(state.agentRewindTargets).filter(
          ([messageId]) => !removedMessageIds.has(messageId)
        )
      )
      const newActiveId =
        state.activeConversationId === id
          ? (remaining[0]?.id ?? null)
          : state.activeConversationId
      return {
        conversations: remaining,
        messages: state.messages.filter((m) => m.conversationId !== id),
        activeConversationId: newActiveId,
        agentRewindTargets: nextRewindTargets,
        activeAgentRewindRequest:
          state.activeAgentRewindRequest &&
          removedMessageIds.has(state.activeAgentRewindRequest.chatMessageId)
            ? null
            : state.activeAgentRewindRequest,
      }
    }),

  setActiveConversation: (id) =>
    set({ activeConversationId: id, activeAgentRewindRequest: null }),

  renameConversation: (id, title) =>
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    })),

  addMessage: (role, content, options) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) return state

      const newMessage: DisplayMessage = {
        id: nextId(),
        role,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
        references: options?.references,
        mode: options?.mode,
        agentSessionId: options?.agentSessionId,
      }

      // Auto-set title from first user message (first 50 chars)
      const convMessages = state.messages.filter(
        (m) => m.conversationId === activeConversationId && m.role === "user"
      )
      const updatedConversations =
        role === "user" && convMessages.length === 0
          ? conversations.map((c) =>
              c.id === activeConversationId
                ? { ...c, title: content.slice(0, 50), updatedAt: Date.now() }
                : c
            )
          : conversations.map((c) =>
              c.id === activeConversationId
                ? { ...c, updatedAt: Date.now() }
                : c
            )

      return {
        messages: [...state.messages, newMessage],
        conversations: updatedConversations,
      }
    }),

  setMessages: (messages) => set({ messages }),

  setConversations: (conversations) => set({ conversations }),

  setStreaming: (isStreaming) => set({ isStreaming }),

  appendStreamToken: (token) =>
    set((state) => ({
      streamingContent: state.streamingContent + token,
    })),

  finalizeStream: (content, references) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) {
        return {
          isStreaming: false,
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant" as const,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
        references,
      }

      return {
        isStreaming: false,
        streamingContent: "",
        messages: [...state.messages, newMessage],
        conversations: conversations.map((c) =>
          c.id === activeConversationId
            ? { ...c, updatedAt: Date.now() }
            : c
        ),
      }
    }),

  finalizeAgentStream: (content, stats) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) {
        return {
          isStreaming: false,
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant" as const,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
        mode: "agent",
        agentSessionId: stats?.agentSessionId,
        costUsd: stats?.costUsd,
        inputTokens: stats?.inputTokens,
        outputTokens: stats?.outputTokens,
        durationMs: stats?.durationMs,
        numTurns: stats?.numTurns,
      }

      return {
        isStreaming: false,
        streamingContent: "",
        messages: [...state.messages, newMessage],
        conversations: conversations.map((c) =>
          c.id === activeConversationId
            ? {
                ...c,
                agentSessionId: stats?.agentSessionId ?? c.agentSessionId,
                agentForkSessionPending: stats?.agentSessionId
                  ? undefined
                  : c.agentForkSessionPending,
                updatedAt: Date.now(),
              }
            : c
        ),
      }
    }),

  startAgentStreamMessage: (options) => {
    const messageId = nextId()
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) {
        return {
          isStreaming: false,
          streamingContent: "",
        }
      }

      const newMessage: DisplayMessage = {
        id: messageId,
        role: "assistant" as const,
        content: "",
        timestamp: Date.now(),
        conversationId: activeConversationId,
        mode: "agent",
        agentSessionId: options?.agentSessionId,
      }

      return {
        isStreaming: true,
        streamingContent: "",
        messages: [...state.messages, newMessage],
        conversations: conversations.map((c) =>
          c.id === activeConversationId
            ? { ...c, updatedAt: Date.now() }
            : c
        ),
      }
    })
    return get().messages.some((message) => message.id === messageId) ? messageId : null
  },

  updateAgentStreamMessage: (messageId, patch) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, ...patch } : m
      ),
    })),

  finishAgentStreamMessage: (messageId, content, stats) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      return {
        isStreaming: false,
        streamingContent: "",
        messages: state.messages.map((m) =>
          m.id === messageId
            ? {
                ...m,
                content,
                mode: "agent" as const,
                agentSessionId: stats?.agentSessionId ?? m.agentSessionId,
                costUsd: stats?.costUsd,
                inputTokens: stats?.inputTokens,
                outputTokens: stats?.outputTokens,
                durationMs: stats?.durationMs,
                numTurns: stats?.numTurns,
              }
            : m
        ),
        conversations: conversations.map((c) =>
          c.id === activeConversationId
            ? {
                ...c,
                agentSessionId: stats?.agentSessionId ?? c.agentSessionId,
                agentForkSessionPending: stats?.agentSessionId
                  ? undefined
                  : c.agentForkSessionPending,
                updatedAt: Date.now(),
              }
            : c
        ),
      }
    }),

  setAgentToolCalls: (messageId, toolCalls) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, toolCalls } : m
      ),
    })),

  updateAgentProgress: (messageId, event) =>
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== messageId) return m
        const toolCalls = m.toolCalls ?? []
        const normalizedEvent =
          event.phase === "failure" && event.ok === undefined
            ? { ...event, ok: false }
            : event
        const eventKey = normalizedEvent.toolUseId ?? normalizedEvent.toolName
        const idx = toolCalls.findIndex(
          (call) => (call.toolUseId ?? call.toolName) === eventKey
        )
        if (idx === -1) {
          return { ...m, toolCalls: [...toolCalls, normalizedEvent] }
        }
        const nextToolCalls = [...toolCalls]
        nextToolCalls[idx] = { ...nextToolCalls[idx], ...normalizedEvent }
        return { ...m, toolCalls: nextToolCalls }
      }),
    })),

  appendAgentWikiChange: (messageId, payload) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              wikiChanges: [
                ...(m.wikiChanges ?? []),
                {
                  ...payload,
                  timestamp: Date.now(),
                },
              ],
            }
          : m
      ),
    })),

  markAgentMessageRewindable: (messageId, payload) =>
    set((state) => {
      const existingMessage = state.messages.find((m) => m.id === messageId)
      const userMessageId = payload.userMessageId ?? existingMessage?.agentUserMessageId
      const assistantMessageId =
        payload.assistantMessageId ?? existingMessage?.agentAssistantMessageId
      const nextMessages = state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              agentUserMessageId: userMessageId ?? m.agentUserMessageId,
              agentAssistantMessageId: assistantMessageId ?? m.agentAssistantMessageId,
            }
          : m
      )
      if (!payload.streamId || !userMessageId) {
        return { messages: nextMessages }
      }
      const target: AgentRewindRequestRecord = {
        chatMessageId: messageId,
        streamId: payload.streamId,
        userMessageId,
        assistantMessageId,
        requestedAt: Date.now(),
      }
      return {
        messages: nextMessages,
        agentRewindTargets: {
          ...state.agentRewindTargets,
          [messageId]: target,
        },
      }
    }),

  requestAgentRewind: (messageId) =>
    set((state) => ({
      activeAgentRewindRequest: state.agentRewindTargets[messageId] ?? null,
    })),

  clearAgentRewindRequest: () => set({ activeAgentRewindRequest: null }),

  requestAgentPermission: (payload, timeoutMs = DEFAULT_AGENT_PERMISSION_TIMEOUT_MS) =>
    new Promise<AgentPermissionDecision>((resolve) => {
      const now = Date.now()
      const request: AgentPermissionRequestRecord = {
        ...payload,
        receivedAt: now,
        expiresAt: 0,
        timeoutMs,
      }
      pendingAgentPermissionResolvers.set(request.requestId, { resolve, timer: null })

      if (!get().activeAgentPermissionRequest) {
        set({ activeAgentPermissionRequest: startAgentPermissionTimer(request) })
        return
      }

      set((state) => ({
        queuedAgentPermissionRequests: [
          ...state.queuedAgentPermissionRequests,
          request,
        ],
      }))
    }),

  resolveAgentPermission: (requestId, decision) => {
    const pending = pendingAgentPermissionResolvers.get(requestId)
    if (pending) {
      pendingAgentPermissionResolvers.delete(requestId)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(decision)
    }

    const state = get()
    const activeMatches = state.activeAgentPermissionRequest?.requestId === requestId
    const remainingQueue = state.queuedAgentPermissionRequests.filter(
      (request) => request.requestId !== requestId
    )
    if (!activeMatches) {
      set({ queuedAgentPermissionRequests: remainingQueue })
      return
    }
    const [nextRequest, ...nextQueue] = remainingQueue
    set({
      activeAgentPermissionRequest: nextRequest
        ? startAgentPermissionTimer(nextRequest)
        : null,
      queuedAgentPermissionRequests: nextQueue,
    })
  },

  clearAgentPermissionRequests: (decision) => {
    const fallbackDecision =
      decision ??
      {
        behavior: "deny" as const,
        message: i18n.t("agent.permission.timeoutDenied"),
        interrupt: true,
        decisionClassification: "user_reject" as const,
      }

    for (const [requestId, pending] of pendingAgentPermissionResolvers) {
      pendingAgentPermissionResolvers.delete(requestId)
      if (pending.timer) clearTimeout(pending.timer)
      pending.resolve(fallbackDecision)
    }
    set({
      activeAgentPermissionRequest: null,
      queuedAgentPermissionRequests: [],
    })
  },

  setMode: (mode) => set({ mode }),

  setIngestSource: (ingestSource) => set({ ingestSource }),

  clearMessages: () =>
    set((state) => ({
      messages: state.messages.filter(
        (m) => m.conversationId !== state.activeConversationId
      ),
    })),

  setMaxHistoryMessages: (maxHistoryMessages) => set({ maxHistoryMessages }),

  removeLastAssistantMessage: () =>
    set((state) => {
      const activeId = state.activeConversationId
      if (!activeId) return state
      const activeMessages = state.messages.filter((m) => m.conversationId === activeId)
      // Find last assistant message
      const lastAssistantIdx = [...activeMessages].reverse().findIndex((m) => m.role === "assistant")
      if (lastAssistantIdx === -1) return state
      const msgToRemove = activeMessages[activeMessages.length - 1 - lastAssistantIdx]
      return {
        messages: state.messages.filter((m) => m.id !== msgToRemove.id),
      }
    }),

  getActiveMessages: () => {
    const { messages, activeConversationId } = get()
    if (!activeConversationId) return []
    return messages.filter((m) => m.conversationId === activeConversationId)
  },
}))

export function chatMessagesToLLM(messages: DisplayMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}
