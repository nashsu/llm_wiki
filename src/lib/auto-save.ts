import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { saveReviewItems, saveLintItems, saveChatHistory, saveChatPreferences } from "./persist"

let reviewTimer: ReturnType<typeof setTimeout> | null = null
let lintTimer: ReturnType<typeof setTimeout> | null = null
let chatTimer: ReturnType<typeof setTimeout> | null = null

// While suspended, the store subscriptions skip writing. This is essential
// during a project switch: resetProjectState() clears every store to empty,
// and without this guard the debounced callbacks would persist those empty
// arrays back to the OUTGOING project's .llm-wiki/*.json — wiping its pending
// review / deep-research items. The switch flow flushes real data to disk via
// flushAndSuspendAutoSave() first, then resumes once the new project loads.
let suspended = false

function clearTimers(): void {
  if (reviewTimer) { clearTimeout(reviewTimer); reviewTimer = null }
  if (lintTimer) { clearTimeout(lintTimer); lintTimer = null }
  if (chatTimer) { clearTimeout(chatTimer); chatTimer = null }
}

/**
 * Immediately persist the current stores to the current project, then stop
 * auto-save from firing until resumeAutoSave() is called. Must be invoked
 * before resetProjectState() clears the stores on a project switch.
 */
export async function flushAndSuspendAutoSave(): Promise<void> {
  suspended = true
  clearTimers()
  const projectPath = useWikiStore.getState().project?.path
  if (!projectPath) return
  const review = useReviewStore.getState().items
  const lint = useLintStore.getState().items
  const chat = useChatStore.getState()
  await Promise.allSettled([
    saveReviewItems(projectPath, review),
    saveLintItems(projectPath, lint),
    saveChatPreferences(projectPath, {
      useWebSearch: chat.useWebSearch,
      useAnyTxtSearch: chat.useAnyTxtSearch,
      agentMode: chat.agentMode,
      retrievalMode: chat.retrievalMode,
      selectedSkills: chat.selectedSkills,
      disabledSkills: chat.disabledSkills,
    }),
    chat.isStreaming
      ? Promise.resolve()
      : saveChatHistory(projectPath, chat.conversations, chat.messages),
  ])
}

export function resumeAutoSave(): void {
  suspended = false
}

/**
 * Run a project-switch/open operation while auto-save is suspended. If the
 * operation fails, onFailure runs before auto-save resumes so callers can clear
 * any half-loaded project path before store changes are allowed to persist.
 */
export async function runWithSuspendedAutoSave<T>(
  action: () => Promise<T>,
  onFailure?: () => void,
): Promise<T> {
  await flushAndSuspendAutoSave()
  try {
    return await action()
  } catch (err) {
    try {
      onFailure?.()
    } catch (cleanupErr) {
      console.warn("Failed to clean up after suspended auto-save operation:", cleanupErr)
    }
    throw err
  } finally {
    resumeAutoSave()
  }
}

export function setupAutoSave(): void {
  // Auto-save review items (debounced 1s)
  useReviewStore.subscribe((state) => {
    if (suspended) return
    const projectPath = useWikiStore.getState().project?.path
    if (reviewTimer) clearTimeout(reviewTimer)
    reviewTimer = setTimeout(() => {
      if (projectPath) {
        saveReviewItems(projectPath, state.items).catch(() => {})
      }
    }, 1000)
  })

  // Auto-save lint items (debounced 1s)
  useLintStore.subscribe((state) => {
    if (suspended) return
    const projectPath = useWikiStore.getState().project?.path
    if (lintTimer) clearTimeout(lintTimer)
    lintTimer = setTimeout(() => {
      if (projectPath) {
        saveLintItems(projectPath, state.items).catch(() => {})
      }
    }, 1000)
  })

  // Auto-save chat conversations and messages (debounced 2s, skip during streaming)
  useChatStore.subscribe((state) => {
    if (suspended) return
    if (state.isStreaming) return
    const projectPath = useWikiStore.getState().project?.path
    if (chatTimer) clearTimeout(chatTimer)
    chatTimer = setTimeout(() => {
      if (projectPath) {
        Promise.allSettled([
          saveChatPreferences(projectPath, {
            useWebSearch: state.useWebSearch,
            useAnyTxtSearch: state.useAnyTxtSearch,
            agentMode: state.agentMode,
            retrievalMode: state.retrievalMode,
            selectedSkills: state.selectedSkills,
            disabledSkills: state.disabledSkills,
          }),
          saveChatHistory(projectPath, state.conversations, state.messages),
        ]).catch(() => {})
      }
    }, 2000)
  })
}
