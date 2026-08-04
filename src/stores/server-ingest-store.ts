// Server-driven ingest queue state (issue #14 P0 stage 9).
//
// The browser pipeline (src/lib/ingest.ts + ingest-queue.ts) is gone: the
// Node server owns scheduling, retries and concurrency (ingest/orchestrator).
// This store is a thin REST mirror of the server's ingest_queue table for
// the CURRENT project, kept live by sse-sync (ingest:* events) and by the
// explicit refresh every action performs. There is deliberately NO
// pause/resume — the server owns scheduling; users cancel or retry tasks.
// Pattern follows file-sync-store.ts.

import { create } from "zustand"
import {
  getQueue,
  enqueueByPath,
  cancelTask,
  retryTask,
  clearQueue,
  type IngestEnqueueResponse,
  type IngestStatus,
  type IngestTask,
} from "@/api/ingest"
import { useWikiStore } from "@/stores/wiki-store"

/** Statuses that mean "the server is still working on this project". */
function isQueueRunning(tasks: IngestTask[]): boolean {
  return tasks.some((t) => t.status === "pending" || t.status === "processing")
}

/** The most recent failed task's error, for surfacing in the activity panel. */
function lastFailedError(tasks: IngestTask[]): string | null {
  let latest: IngestTask | null = null
  for (const task of tasks) {
    if (task.status !== "failed") continue
    if (!latest || (task.updated_at ?? 0) >= (latest.updated_at ?? 0)) latest = task
  }
  return latest?.error ?? null
}

interface ServerIngestState {
  tasks: IngestTask[]
  running: boolean
  lastError: string | null
  /** Project UUID the task list was loaded for; null when idle/reset. */
  loadedFor: string | null

  loadQueue: (projectId: string) => Promise<void>
  enqueue: (path: string, folderContext?: string) => Promise<IngestEnqueueResponse | null>
  cancel: (taskId: number) => Promise<void>
  retry: (taskId: number) => Promise<void>
  retryAllFailed: () => Promise<number>
  clearFinished: (status?: IngestStatus) => Promise<void>
  /** Project switch / reset: drop all state without touching the server. */
  reset: () => void

  // ── SSE feed (called by sse-sync for the current project only) ────────
  /** Merge a progress frame into the matching task. */
  patchTask: (taskId: number, patch: Partial<IngestTask>) => void
  setRunning: (running: boolean) => void
  setLastError: (error: string | null) => void
}

/**
 * The project the store currently serves. The wiki-store's active project is
 * authoritative; `loadedFor` is the fallback for the brief window before the
 * active project is set (and keeps SSE-fed refreshes scoped correctly).
 */
function currentProjectId(state: { loadedFor: string | null }): string | null {
  return useWikiStore.getState().project?.id ?? state.loadedFor
}

export const useServerIngestStore = create<ServerIngestState>((set, get) => ({
  tasks: [],
  running: false,
  lastError: null,
  loadedFor: null,

  loadQueue: async (projectId: string) => {
    try {
      const { tasks } = await getQueue(projectId, { limit: 200 })
      // A project switch may have completed while the request was in flight.
      const current = useWikiStore.getState().project?.id
      if (current && current !== projectId && get().loadedFor !== projectId) return
      set({
        tasks,
        loadedFor: projectId,
        running: isQueueRunning(tasks),
        lastError: lastFailedError(tasks),
      })
    } catch (err) {
      // Server unreachable — keep whatever we had; the next event or
      // action retries.
      console.warn("[server-ingest-store] failed to load queue:", err)
    }
  },

  enqueue: async (path: string, folderContext?: string) => {
    const projectId = currentProjectId(get())
    if (!projectId) return null
    try {
      const res = await enqueueByPath(projectId, path, folderContext)
      await get().loadQueue(projectId)
      return res
    } catch (err) {
      console.error("[server-ingest-store] enqueue failed:", err)
      return null
    }
  },

  cancel: async (taskId: number) => {
    const projectId = currentProjectId(get())
    if (!projectId) return
    try {
      await cancelTask(projectId, taskId)
    } catch (err) {
      console.warn("[server-ingest-store] cancel failed:", err)
    }
    await get().loadQueue(projectId)
  },

  retry: async (taskId: number) => {
    const projectId = currentProjectId(get())
    if (!projectId) return
    try {
      await retryTask(projectId, taskId)
    } catch (err) {
      console.warn("[server-ingest-store] retry failed:", err)
    }
    await get().loadQueue(projectId)
  },

  retryAllFailed: async () => {
    const projectId = currentProjectId(get())
    if (!projectId) return 0
    const failed = get().tasks.filter((t) => t.status === "failed")
    let requeued = 0
    for (const task of failed) {
      try {
        await retryTask(projectId, task.id)
        requeued++
      } catch (err) {
        console.warn(`[server-ingest-store] retry of task ${task.id} failed:`, err)
      }
    }
    await get().loadQueue(projectId)
    return requeued
  },

  clearFinished: async (status?: IngestStatus) => {
    const projectId = currentProjectId(get())
    if (!projectId) return
    const statuses: IngestStatus[] = status ? [status] : ["completed", "failed"]
    for (const s of statuses) {
      try {
        await clearQueue(projectId, s)
      } catch (err) {
        console.warn(`[server-ingest-store] clear(${s}) failed:`, err)
      }
    }
    await get().loadQueue(projectId)
  },

  reset: () => set({ tasks: [], running: false, lastError: null, loadedFor: null }),

  patchTask: (taskId: number, patch: Partial<IngestTask>) => {
    // A frame for an unknown task (e.g. enqueued server-side by the file
    // watcher while the list was stale) triggers a full refresh instead.
    if (!get().tasks.some((t) => t.id === taskId)) {
      const projectId = get().loadedFor
      if (projectId) void get().loadQueue(projectId)
      return
    }
    const tasks = get().tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t))
    set({ tasks, running: isQueueRunning(tasks) })
  },

  setRunning: (running: boolean) => set({ running }),
  setLastError: (lastError: string | null) => set({ lastError }),
}))
