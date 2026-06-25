import { writeFile, readFile, createDirectory } from "@/commands/fs"
import type { ReviewItem } from "@/stores/review-store"
import type { LintItem } from "@/stores/lint-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import type { ChatAgentMode } from "@/lib/chat-agent"
import { normalizePath } from "@/lib/path-utils"

async function ensureDir(projectPath: string): Promise<void> {
  await createDirectory(`${projectPath}/.llm-wiki`).catch(() => {})
  await createDirectory(`${projectPath}/.llm-wiki/chats`).catch(() => {})
}

export async function saveReviewItems(projectPath: string, items: ReviewItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFile(`${pp}/.llm-wiki/review.json`, JSON.stringify(items, null, 2))
}

export async function loadReviewItems(projectPath: string): Promise<ReviewItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/review.json`)
    return JSON.parse(content) as ReviewItem[]
  } catch {
    return []
  }
}

export async function saveLintItems(projectPath: string, items: LintItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFile(`${pp}/.llm-wiki/lint.json`, JSON.stringify(items, null, 2))
}

export async function loadLintItems(projectPath: string): Promise<LintItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/lint.json`)
    return JSON.parse(content) as LintItem[]
  } catch {
    return []
  }
}

interface PersistedChatData {
  conversations: Conversation[]
  messages: DisplayMessage[]
}

export interface ChatPreferences {
  useWebSearch: boolean
  useAnyTxtSearch: boolean
  agentMode: ChatAgentMode
}

function stripPersistedMessageImages(msg: DisplayMessage): DisplayMessage {
  if (!msg.images || msg.images.length === 0) return msg
  const { images: _images, ...rest } = msg
  return rest
}

export async function saveChatHistory(
  projectPath: string,
  conversations: Conversation[],
  messages: DisplayMessage[]
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)

  // Save conversation list
  await writeFile(
    `${pp}/.llm-wiki/conversations.json`,
    JSON.stringify(conversations, null, 2)
  )

  // Save each conversation's messages separately
  const byConversation = new Map<string, DisplayMessage[]>()
  for (const msg of messages) {
    const list = byConversation.get(msg.conversationId) ?? []
    // Images can be multi-megabyte base64 payloads. Keep them in memory for the
    // current chat turn, but don't persist them into chat JSON where they would
    // quickly bloat auto-save files and project backups.
    list.push(stripPersistedMessageImages(msg))
    byConversation.set(msg.conversationId, list)
  }

  for (const [convId, msgs] of byConversation) {
    // Keep last 100 messages per conversation
    const toSave = msgs.slice(-100)
    await writeFile(
      `${pp}/.llm-wiki/chats/${convId}.json`,
      JSON.stringify(toSave, null, 2)
    )
  }
}

export async function loadChatHistory(projectPath: string): Promise<PersistedChatData> {
  const pp = normalizePath(projectPath)
  try {
    // Try new format: separate files per conversation
    const convContent = await readFile(`${pp}/.llm-wiki/conversations.json`)
    const conversations = JSON.parse(convContent) as Conversation[]

    const allMessages: DisplayMessage[] = []
    for (const conv of conversations) {
      try {
        const msgContent = await readFile(`${pp}/.llm-wiki/chats/${conv.id}.json`)
        const msgs = JSON.parse(msgContent) as DisplayMessage[]
        allMessages.push(...msgs)
      } catch {
        // Conversation file missing, skip
      }
    }

    return { conversations, messages: allMessages }
  } catch {
    // Fall back to old format
    try {
      const content = await readFile(`${pp}/.llm-wiki/chat-history.json`)
      const parsed = JSON.parse(content)

      if (Array.isArray(parsed)) {
        // Very old format: flat array
        const legacyMessages = parsed as DisplayMessage[]
        const defaultConv: Conversation = {
          id: "default",
          title: "Previous Conversations",
          createdAt: legacyMessages[0]?.timestamp ?? Date.now(),
          updatedAt: legacyMessages[legacyMessages.length - 1]?.timestamp ?? Date.now(),
        }
        const migratedMessages = legacyMessages.map((m) => ({
          ...m,
          conversationId: "default",
        }))
        return { conversations: [defaultConv], messages: migratedMessages }
      }

      // Old combined format
      const data = parsed as PersistedChatData
      return data
    } catch {
      return { conversations: [], messages: [] }
    }
  }
}

export async function saveChatPreferences(
  projectPath: string,
  preferences: ChatPreferences,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  await writeFile(`${pp}/.llm-wiki/chat-preferences.json`, JSON.stringify(preferences, null, 2))
}

export async function loadChatPreferences(projectPath: string): Promise<ChatPreferences> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/chat-preferences.json`)
    const parsed = JSON.parse(content) as Partial<ChatPreferences>
    return {
      useWebSearch: parsed.useWebSearch === true,
      useAnyTxtSearch: parsed.useAnyTxtSearch === true,
      agentMode: normalizePersistedAgentMode(parsed.agentMode),
    }
  } catch {
    return { useWebSearch: false, useAnyTxtSearch: false, agentMode: "standard" }
  }
}

function normalizePersistedAgentMode(value: unknown): ChatAgentMode {
  switch (value) {
    case "fast":
    case "standard":
    case "deep":
    case "local_first":
      return value
    default:
      return "standard"
  }
}
