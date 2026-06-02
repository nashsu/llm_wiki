import { create } from "zustand"
import type { ChatMessage } from "@/lib/llm-client"
import type {
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
  agentBlocks?: SDKContentBlock[]
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

/** Runtime-only Agent permission request shown in the approval dialog. */
export interface AgentPermissionRequestRecord extends AgentPermissionRequestPayload {
  receivedAt: number
  expiresAt: number
  timeoutMs: number
}

interface AddMessageOptions {
  mode?: DisplayMessage["mode"]
  agentSessionId?: string
  references?: MessageReference[]
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

  // Conversation management
  createConversation: () => string
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
  setAgentToolCalls: (messageId: string, toolCalls: AgentToolCallRecord[]) => void
  updateAgentProgress: (messageId: string, event: AgentToolCallRecord) => void
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

  deleteConversation: (id) =>
    set((state) => {
      const remaining = state.conversations.filter((c) => c.id !== id)
      const newActiveId =
        state.activeConversationId === id
          ? (remaining[0]?.id ?? null)
          : state.activeConversationId
      return {
        conversations: remaining,
        messages: state.messages.filter((m) => m.conversationId !== id),
        activeConversationId: newActiveId,
      }
    }),

  setActiveConversation: (id) => set({ activeConversationId: id }),

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
