import { writeFile, readFile, createDirectory, listDirectory } from "@/commands/fs"
import { normalizeReviewItems, type ReviewItem } from "@/stores/review-store"
import type { LintItem } from "@/stores/lint-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import type { ChatAgentMode, ChatRetrievalMode } from "@/lib/chat-agent-types"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

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
    return normalizeReviewItems(JSON.parse(content) as ReviewItem[])
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
  retrievalMode: ChatRetrievalMode
  selectedSkills: string[]
  disabledSkills: string[]
}

function stripPersistedMessageImages(msg: DisplayMessage): DisplayMessage {
  const withoutImages = (() => {
    if (!msg.images || msg.images.length === 0) return msg
    const { images: _images, ...rest } = msg
    return rest
  })()
  if (!withoutImages.agentFileChanges?.some((change) => "beforeContent" in change || "afterContent" in change)) {
    return withoutImages
  }
  return {
    ...withoutImages,
    agentFileChanges: withoutImages.agentFileChanges.map(({
      beforeContent: _before,
      afterContent: _after,
      ...change
    }) => change),
  }
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

    if (conversations.length > 0 || allMessages.length > 0) {
      return { conversations, messages: allMessages }
    }

    // A previous startup race could overwrite conversations.json with [] while
    // leaving .llm-wiki/chats/<id>.json intact. Rebuild a minimal conversation
    // index from those orphan message files so users do not have to recreate
    // chat sessions manually.
    const recovered = await recoverChatHistoryFromOrphanChatFiles(pp)
    if (recovered.conversations.length > 0) return recovered
    return { conversations, messages: allMessages }
  } catch {
    const recovered = await recoverChatHistoryFromOrphanChatFiles(pp)
    if (recovered.conversations.length > 0) return recovered

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

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      out.push(...flattenFiles(node.children ?? []))
    } else {
      out.push(node)
    }
  }
  return out
}

function conversationFromMessages(id: string, messages: DisplayMessage[]): Conversation | null {
  if (messages.length === 0) return null
  const timestamps = messages
    .map((message) => message.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp))
  const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : Date.now()
  const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : createdAt
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim())
  return {
    id,
    title: firstUser?.content.slice(0, 50) || "Previous Conversation",
    createdAt,
    updatedAt,
  }
}

async function recoverChatHistoryFromOrphanChatFiles(projectPath: string): Promise<PersistedChatData> {
  try {
    const chatDir = `${projectPath}/.llm-wiki/chats`
    const files = flattenFiles(await listDirectory(chatDir))
      .filter((node) => node.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
    const conversations: Conversation[] = []
    const allMessages: DisplayMessage[] = []

    for (const file of files) {
      try {
        const raw = await readFile(file.path)
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) continue
        const id = file.name.replace(/\.json$/i, "")
        const messages = (parsed as DisplayMessage[])
          .filter((message) => message && typeof message === "object")
          .map((message) => ({
            ...message,
            conversationId: typeof message.conversationId === "string" && message.conversationId
              ? message.conversationId
              : id,
          }))
        const conversation = conversationFromMessages(id, messages)
        if (!conversation) continue
        conversations.push(conversation)
        allMessages.push(...messages)
      } catch {
        // Ignore one corrupt chat file and continue recovering the others.
      }
    }

    conversations.sort((a, b) => b.updatedAt - a.updatedAt)
    return { conversations, messages: allMessages }
  } catch {
    return { conversations: [], messages: [] }
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
      retrievalMode: normalizePersistedRetrievalMode(parsed.retrievalMode),
      selectedSkills: normalizePersistedSkillList(parsed.selectedSkills),
      disabledSkills: normalizePersistedSkillList(parsed.disabledSkills),
    }
  } catch {
    return {
      useWebSearch: false,
      useAnyTxtSearch: false,
      agentMode: "standard",
      retrievalMode: "standard",
      selectedSkills: [],
      disabledSkills: [],
    }
  }
}

function normalizePersistedSkillList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  )
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

function normalizePersistedRetrievalMode(value: unknown): ChatRetrievalMode {
  return value === "smart" ? "smart" : "standard"
}
