import { useWikiStore } from "@/stores/wiki-store"
import { enqueueIngest } from "./ingest-queue"
import { listDirectory } from "@/commands/fs"
import { hasUsableDocumentLlm } from "@/lib/has-usable-llm"

const POLL_INTERVAL = 3000 // Check every 3 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Start polling the clip server for new web clips.
 * When a clip is detected, triggers auto-ingest and refreshes the file tree.
 */
export function startClipWatcher() {
  if (intervalId) return // Already running

  intervalId = setInterval(async () => {
    try {
      const res = await fetch("http://127.0.0.1:19827/clips/pending", { method: "GET" })
      const data = await res.json()

      if (!data.ok || !data.clips || data.clips.length === 0) return

      const store = useWikiStore.getState()
      const project = store.project

      for (const clip of data.clips) {
        const clipProjectPath: string = clip.projectPath
        const clipFilePath: string = clip.filePath

        // Refresh file tree if clip is for current project
        if (project && clipProjectPath === project.path) {
          try {
            const tree = await listDirectory(project.path)
            store.setFileTree(tree)
          } catch {
            // ignore
          }

          // Enqueue (not auto-ingest directly) so the task lands in the
          // persisted queue, shows up in the activity panel, and survives
          // a UI refresh. Same path used by file imports from sources-view.
          // Pass the project's stable UUID — the queue looks up the
          // current filesystem path from the registry at run time.
          if (hasUsableDocumentLlm(store.llmConfig, store.documentLlmConfig)) {
            enqueueIngest(project.id, clipFilePath).catch((err) => {
              console.error("Failed to enqueue web clip:", err)
            })
          }
        }
      }
    } catch {
      // Server not running or network error — silently ignore
    }
  }, POLL_INTERVAL)
}

export function stopClipWatcher() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
