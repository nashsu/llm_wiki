import { create } from "zustand"
import type { ChatMessage, ContentBlock } from "@/lib/llm-client"
import i18n from "@/i18n"
import type { ChatAgentMode, ChatAgentStep } from "@/lib/chat-agent"

/**
 * An image attached to a user message. Field names mirror the
 * `image` variant of `ContentBlock` (see llm-providers.ts) so
 * converting a DisplayMessage into a wire ContentBlock is a no-op
 * spread — no remapping, no `data:` framing here (the provider
 * translators own that).
 */
export interface MessageImage {
  mediaType: string
  dataBase64: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
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
  agentSteps?: ChatAgentStep[]  // agent tool calls and routing decisions saved with assistant replies
  images?: MessageImage[]  // images attached to a user message (vision input)
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: DisplayMessage[]
  isStreaming: boolean
  streamingContent: string
  mode: "chat" | "ingest"
  ingestSource: string | null
  maxHistoryMessages: number
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  agentMode: ChatAgentMode

  // Conversation management
  createConversation: () => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  renameConversation: (id: string, title: string) => void

  // Message management
  addMessage: (role: DisplayMessage["role"], content: string, images?: MessageImage[]) => void
  setMessages: (messages: DisplayMessage[]) => void
  setConversations: (conversations: Conversation[]) => void
  setStreaming: (streaming: boolean) => void
  appendStreamToken: (token: string) => void
  finalizeStream: (content: string, references?: MessageReference[], agentSteps?: ChatAgentStep[]) => void
  setMode: (mode: ChatState["mode"]) => void
  setIngestSource: (path: string | null) => void
  clearMessages: () => void
  setMaxHistoryMessages: (n: number) => void
  setUseWebSearch: (enabled: boolean) => void
  setUseAnyTxtSearch: (enabled: boolean) => void
  setAgentMode: (mode: ChatAgentMode) => void
  removeLastAssistantMessage: () => void  // for regenerate: remove last assistant reply

  // Helpers
  getActiveMessages: () => DisplayMessage[]
}

let messageCounter = 0

function nextId(): string {
  messageCounter += 1
  return String(messageCounter)
}

function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
  useWebSearch: false,
  useAnyTxtSearch: false,
  agentMode: "standard",

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

  addMessage: (role, content, images) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) return state

      const newMessage: DisplayMessage = {
        id: nextId(),
        role,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
        ...(images && images.length > 0 ? { images } : {}),
      }

      // Auto-set title from first user message (first 50 chars)
      const convMessages = state.messages.filter(
        (m) => m.conversationId === activeConversationId && m.role === "user"
      )
      const updatedConversations =
        role === "user" && convMessages.length === 0
          ? conversations.map((c) =>
              c.id === activeConversationId
                ? {
                    ...c,
                    // Image-only first message has empty text; fall
                    // back to a generic title so the sidebar entry
                    // isn't blank.
                    title: content.slice(0, 50) || (images && images.length > 0 ? i18n.t("chat.imageMessage") : c.title),
                    updatedAt: Date.now(),
                  }
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

  finalizeStream: (content, references, agentSteps) =>
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
        agentSteps,
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

  setMode: (mode) => set({ mode }),

  setIngestSource: (ingestSource) => set({ ingestSource }),

  clearMessages: () =>
    set((state) => ({
      messages: state.messages.filter(
        (m) => m.conversationId !== state.activeConversationId
      ),
    })),

  setMaxHistoryMessages: (maxHistoryMessages) => set({ maxHistoryMessages }),

  setUseWebSearch: (useWebSearch) => set({ useWebSearch }),

  setUseAnyTxtSearch: (useAnyTxtSearch) => set({ useAnyTxtSearch }),

  setAgentMode: (agentMode) => set({ agentMode }),

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
  return messages.map((m) => {
    // No images → keep the legacy string shape. Providers and the
    // single-string fast paths in the translators stay unchanged,
    // and existing tests that assert `content: "..."` keep passing.
    if (!m.images || m.images.length === 0) {
      return { role: m.role, content: m.content }
    }
    // Images present → emit a ContentBlock[]. Text first (so the
    // model reads the prompt before the images), then one image
    // block per attachment. An empty text (image-only message)
    // still gets a text block — harmless, and keeps the shape
    // uniform.
    const blocks: ContentBlock[] = [
      { type: "text", text: m.content },
      ...m.images.map((img): ContentBlock => ({
        type: "image",
        mediaType: img.mediaType,
        dataBase64: img.dataBase64,
      })),
    ]
    return { role: m.role, content: blocks }
  })
}
