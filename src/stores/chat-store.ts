import { create } from "zustand"
import type { ChatMessage } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import i18n from "@/i18n"

// ---------------------------------------------------------------------------
// Conversation-summary compression
// ---------------------------------------------------------------------------
const summaryCache = new Map<string, { messageCount: number; summary: string }>()

/**
 * Use the configured LLM to compress old messages into a short summary.
 * Best-effort — failures log a warning and fall back to a generic string.
 */
async function summarizeHistory(
  messages: Array<{ role: string; content: string }>,
  llmConfig: LlmConfig,
  conversationId: string,
): Promise<string> {
  // Return cached summary if message count hasn't changed
  const cached = summaryCache.get(conversationId)
  if (cached && cached.messageCount === messages.length) return cached.summary

  const conversationText = messages
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join("\n")

  const { streamChat } = await import("@/lib/llm-client")
  let summary = ""

  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content:
          "Summarize this conversation in 2-3 sentences, preserving key facts, decisions, and topics discussed. Be concise.",
      },
      { role: "user", content: conversationText },
    ],
    {
      onToken: (token) => {
        summary += token
      },
      onDone: () => {},
      onError: (err) => {
        console.warn("[chat] summary failed:", err.message)
      },
    },
    undefined,
    { temperature: 0, max_tokens: 256 },
  )

  const result = summary || "Previous conversation summarized."
  summaryCache.set(conversationId, { messageCount: messages.length, summary: result })
  return result
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
}

export interface QueryPage {
  title: string
  path: string
}

export interface DisplayMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: number
  conversationId: string
  references?: MessageReference[]  // pages cited in this response, saved at creation time
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
  lastQueryPages: QueryPage[]
  conversationSummaries: Record<string, string>

  // Conversation management
  createConversation: () => string
  deleteConversation: (id: string) => void
  setActiveConversation: (id: string | null) => void
  renameConversation: (id: string, title: string) => void

  // Message management
  addMessage: (role: DisplayMessage["role"], content: string) => void
  setMessages: (messages: DisplayMessage[]) => void
  setConversations: (conversations: Conversation[]) => void
  setStreaming: (streaming: boolean) => void
  appendStreamToken: (token: string) => void
  finalizeStream: (content: string, references?: MessageReference[]) => void
  setMode: (mode: ChatState["mode"]) => void
  setIngestSource: (path: string | null) => void
  clearMessages: () => void
  setMaxHistoryMessages: (n: number) => void
  setLastQueryPages: (pages: QueryPage[]) => void
  removeLastAssistantMessage: () => void  // for regenerate: remove last assistant reply
  compressHistory: () => Promise<void>

  // Helpers
  getActiveMessages: () => DisplayMessage[]
}

/**
 * Remove invalid citation markers from content.
 * Valid citations are [N] where N is within the range of referenced pages.
 * Invalid ones are converted to plain text (brackets removed).
 */
function validateCitations(content: string, pageCount: number): string {
  if (pageCount <= 0) return content
  return content.replace(/\[(\d+)\]/g, (match, numStr) => {
    const num = parseInt(numStr, 10)
    if (num >= 1 && num <= pageCount) return match
    // Invalid citation — remove brackets
    return numStr
  })
}

function nextId(): string {
  return crypto.randomUUID()
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
  lastQueryPages: [],
  conversationSummaries: {},

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

  addMessage: (role, content) =>
    set((state) => {
      const { activeConversationId, conversations } = state
      if (!activeConversationId) return state

      const newMessage: DisplayMessage = {
        id: nextId(),
        role,
        content,
        timestamp: Date.now(),
        conversationId: activeConversationId,
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

  finalizeStream: (content, references) => {
    set((state) => {
      const { activeConversationId, conversations, lastQueryPages } = state
      if (!activeConversationId) {
        return {
          isStreaming: false,
          streamingContent: "",
        }
      }

      const validatedContent = validateCitations(content, lastQueryPages.length)

      const newMessage: DisplayMessage = {
        id: nextId(),
        role: "assistant" as const,
        content: validatedContent,
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
    })
    // Trigger summary compression in the background (best-effort)
    get().compressHistory()
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

  setLastQueryPages: (lastQueryPages) => set({ lastQueryPages }),

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

  compressHistory: async () => {
    const state = get()
    const activeId = state.activeConversationId
    if (!activeId) return

    const msgs = state.messages.filter((m) => m.conversationId === activeId)
    const max = state.maxHistoryMessages
    if (msgs.length <= max * 2) return

    const oldMsgs = msgs.slice(0, msgs.length - max)
    const llmConfig = useWikiStore.getState().llmConfig

    try {
      const summary = await summarizeHistory(oldMsgs, llmConfig, activeId)
      set({ conversationSummaries: { ...state.conversationSummaries, [activeId]: summary } })
    } catch {
      // Best-effort — failures are non-fatal
    }
  },

  getActiveMessages: () => {
    const { messages, activeConversationId, maxHistoryMessages, conversationSummaries } = get()
    if (!activeConversationId) return []
    const msgs = messages.filter((m) => m.conversationId === activeConversationId)
    const max = maxHistoryMessages
    const recent = msgs.slice(-max)
    const summary = conversationSummaries[activeConversationId]
    if (summary && msgs.length > max) {
      return [
        {
          id: "__summary__",
          role: "system" as const,
          content: `[Previous conversation summary]: ${summary}`,
          timestamp: recent[0]?.timestamp ?? Date.now(),
          conversationId: activeConversationId,
        },
        ...recent,
      ]
    }
    return recent
  },
}))

export function chatMessagesToLLM(messages: DisplayMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}
