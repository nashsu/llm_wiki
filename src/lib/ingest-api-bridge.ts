import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { invoke } from "@tauri-apps/api/core"
import {
  getQueue,
  getQueueSummary,
  pauseProcessing,
  resumeProcessing,
  retryAllFailedTasks,
  type IngestTask,
} from "@/lib/ingest-queue"

interface IngestApiRequest {
  requestId: string
  action: "status" | "pause" | "resume" | "retry-failed"
  projectId: string
}

let unlisten: UnlistenFn | null = null

/**
 * Start listening for ingest control requests emitted by the HTTP API
 * server. The Rust backend emits `ingest-api://request` events when an
 * MCP/API client calls the ingest control endpoints. This bridge calls
 * the corresponding ingest-queue function and sends the result back via
 * the `ingest_api_response` Tauri command.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function startIngestApiBridge(): Promise<void> {
  if (unlisten) return
  unlisten = await listen<IngestApiRequest>(
    "ingest-api://request",
    async (event) => {
      const { requestId, action, projectId } = event.payload
      let result: Record<string, unknown>
      try {
        switch (action) {
          case "status": {
            const summary = getQueueSummary()
            const tasks = getQueue() as readonly IngestTask[]
            result = {
              summary,
              tasks: tasks.map((task) => ({
                id: task.id,
                sourcePath: task.sourcePath,
                folderContext: task.folderContext,
                status: task.status,
                error: task.error,
                retryCount: task.retryCount,
                addedAt: task.addedAt,
              })),
            }
            break
          }
          case "pause": {
            pauseProcessing()
            result = { paused: true, summary: getQueueSummary() }
            break
          }
          case "resume": {
            resumeProcessing()
            result = { resumed: true, summary: getQueueSummary() }
            break
          }
          case "retry-failed": {
            const requeued = await retryAllFailedTasks()
            result = { requeued, summary: getQueueSummary() }
            break
          }
          default:
            result = { error: `Unknown ingest action: ${action}` }
        }
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) }
      }
      try {
        await invoke("ingest_api_response", { requestId, result })
      } catch (err) {
        console.error("[Ingest API Bridge] Failed to send response:", err)
      }
    },
  )
  console.log("[Ingest API Bridge] Listening for ingest-api://request events")
}

/** Stop listening and clean up. */
export async function stopIngestApiBridge(): Promise<void> {
  if (unlisten) {
    unlisten()
    unlisten = null
  }
}
