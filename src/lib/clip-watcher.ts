import { useWikiStore } from "@/stores/wiki-store"
import { useServerIngestStore } from "@/stores/server-ingest-store"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { getRelativePath } from "@/lib/path-utils"

const POLL_INTERVAL = 3000 // Check every 3 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Start polling the clip server for new web clips.
 * When a clip is detected, triggers auto-ingest and refreshes the file tree.
 */
export function startClipWatcher() {
  if (intervalId) return // Already running
  // The clip server is a desktop-only companion (Chrome extension → native
  // HTTP server on :19827). It does not exist in the browser web build, so
  // skip polling there to avoid pointless connection-refused noise.
  if ((globalThis as { __LLM_WIKI_WEB__?: boolean }).__LLM_WIKI_WEB__) return

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
          await refreshProjectFileTree(project.path, { projectId: project.id })

          // Enqueue (not auto-ingest directly) so the task lands in the
          // server's persisted ingest queue, shows up in the activity panel,
          // and survives a UI refresh. Server-side ingest owns the run
          // (issue #14 P0 stage 9). The enqueue-by-path route takes a
          // project-relative path.
          if (hasUsableLlm(store.llmConfig)) {
            void useServerIngestStore.getState().enqueue(getRelativePath(clipFilePath, project.path))
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
