import { writeFile, readFile, createDirectory } from "@/commands/fs"
import type { ReviewItem } from "@/stores/review-store"
import type { DisplayMessage, Conversation } from "@/stores/chat-store"
import { normalizePath } from "@/lib/path-utils"

async function ensureDir(projectPath: string): Promise<void> {
  await createDirectory(`${projectPath}/.llm-wiki`).catch(() => {})
  await createDirectory(`${projectPath}/.llm-wiki/chats`).catch(() => {})
}

export async function saveReviewItems(projectPath: string, items: ReviewItem[]): Promise<void> {
  const pp = normalizePath(projectPath)
  await ensureDir(pp)
  const scoped = items.filter((item) => normalizePath(item.projectPath) === pp)
  await writeFile(`${pp}/.llm-wiki/review.json`, JSON.stringify(scoped, null, 2))
}

export async function loadReviewItems(projectPath: string): Promise<ReviewItem[]> {
  const pp = normalizePath(projectPath)
  try {
    const content = await readFile(`${pp}/.llm-wiki/review.json`)
    const parsed = JSON.parse(content) as Array<Partial<ReviewItem>>
    return parsed.map((item) => ({
      id: item.id ?? `review-legacy-${Math.random().toString(36).slice(2, 10)}`,
      projectId: item.projectId ?? pp,
      projectPath: normalizePath(item.projectPath ?? pp),
      type: item.type ?? "confirm",
      title: item.title ?? "",
      description: item.description ?? "",
      sourcePath: item.sourcePath,
      affectedPages: item.affectedPages,
      searchQueries: item.searchQueries,
      options: item.options ?? [],
      resolved: item.resolved ?? false,
      resolvedAction: item.resolvedAction,
      createdAt: item.createdAt ?? 0,
    }))
  } catch {
    return []
  }
}

interface PersistedChatData {
  conversations: Conversation[]
  messages: DisplayMessage[]
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
    list.push(msg)
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
