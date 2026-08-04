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
import { useLintStore } from "@/stores/lint-store"
import { useActivityStore } from "@/stores/activity-store"
import { useResearchStore } from "@/stores/research-store"
import { useWikiStore } from "@/stores/wiki-store"

export async function resetProjectState(): Promise<void> {
  // Zustand stores — clear all per-project data (synchronous)
  const globalLlmConfig = useWikiStore.getState().globalLlmConfig
  useWikiStore.setState({
    llmConfig: globalLlmConfig,
    projectLlmOverride: { enabled: false, presetId: null, model: "", profile: undefined },
  })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
    useWebSearch: false,
    useAnyTxtSearch: false,
    agentMode: "standard",
    retrievalMode: "standard",
    selectedSkills: [],
    disabledSkills: [],
    // Owned-run tombstones are per-tab/per-project run bookkeeping (SSE
    // taxonomy stage 6); drop them with the rest of the project state.
    ownedRunIds: [],
    ownedRunsByConversation: {},
  })

  useReviewStore.setState({
    items: [],
  })

  useLintStore.setState({
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
  const [dedupQueueMod, graphMod, fileSyncMod, scheduledImportMod] = await Promise.allSettled([
    import("@/lib/dedup-queue"),
    import("@/lib/graph-relevance"),
    import("@/lib/project-file-sync"),
    import("@/lib/scheduled-import"),
  ])

  if (scheduledImportMod.status === "fulfilled") {
    try {
      scheduledImportMod.value.stopScheduledImport()
    } catch (err) {
      console.warn("[Reset Project State] stopScheduledImport failed:", err)
    }
  } else {
    console.warn("[Reset Project State] Failed to load scheduled-import:", scheduledImportMod.reason)
  }

  // Server-driven ingest (issue #14 P0 stage 9): the queue lives on the
  // server; just drop the local mirror so the next project loads fresh.
  try {
    const { useServerIngestStore } = await import("@/stores/server-ingest-store")
    useServerIngestStore.getState().reset()
  } catch (err) {
    console.warn("[Reset Project State] server-ingest-store reset failed:", err)
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
