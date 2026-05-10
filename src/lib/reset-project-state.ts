/**
 * Centralized reset of all per-project state.
 * MUST be called (and AWAITED) both when leaving a project and when opening a
 * new one, to prevent cross-project data contamination.
 *
 * Returns once every store/cache has actually been cleared — the caller can
 * trust that downstream project-opening steps will not race with lingering
 * cleanup.
 */

import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useResearchStore } from "@/stores/research-store"

export async function resetProjectState(): Promise<void> {
  // Zustand stores — clear all per-project data (synchronous)
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })

  useReviewStore.setState({
    items: [],
  })

  useActivityStore.setState({
    items: [],
  })

  useResearchStore.setState({
    tasks: [],
    panelOpen: false,
  })

  // Module-level caches — load in parallel and clear each, surfacing any
  // failure instead of swallowing it.
  const [queueMod, dedupQueueMod, graphMod, fileSyncMod] = await Promise.allSettled([
    import("@/lib/ingest-queue"),
    import("@/lib/dedup-queue"),
    import("@/lib/graph-relevance"),
    import("@/lib/project-file-sync"),
  ])

  if (queueMod.status === "fulfilled") {
    try {
      // pauseQueue flushes the active project's state to disk (reverting
      // any processing task to pending) before clearing in-memory state.
      // Awaiting is required — the disk write must complete before the
      // new project's restoreQueue reads its own file.
      await queueMod.value.pauseQueue()
    } catch (err) {
      console.warn("[Reset Project State] pauseQueue failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load ingest-queue:", queueMod.reason)
  }

  if (dedupQueueMod.status === "fulfilled") {
    try {
      await dedupQueueMod.value.pauseQueue()
    } catch (err) {
      console.warn("[Reset Project State] dedup pauseQueue failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load dedup-queue:", dedupQueueMod.reason)
  }

  if (graphMod.status === "fulfilled") {
    try {
      graphMod.value.clearGraphCache()
    } catch (err) {
      console.warn("[Reset Project State] clearGraphCache failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load graph-relevance:", graphMod.reason)
  }

  if (fileSyncMod.status === "fulfilled") {
    try {
      await fileSyncMod.value.stopProjectFileSync()
    } catch (err) {
      console.warn("[Reset Project State] stopProjectFileSync failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load project-file-sync:", fileSyncMod.reason)
  }
}
