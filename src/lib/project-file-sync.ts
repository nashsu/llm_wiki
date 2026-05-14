import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { readFile, listDirectory } from "@/commands/fs"
import {
  rescanProjectFiles,
  startProjectFileWatcher,
  stopProjectFileWatcher,
  type FileSyncPayload,
} from "@/commands/file-sync"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { useWikiStore } from "@/stores/wiki-store"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import type { WikiProject } from "@/types/wiki"
import type { SourceWatchConfig } from "@/stores/wiki-store"
import type { FileChangeTask } from "@/commands/file-sync"
import {
  cleanupDeletedWikiPages,
  deleteSourceFiles,
  enqueueSourceIngest,
  isIngestableSourcePath,
} from "@/lib/source-lifecycle"
import { isPathAllowedBySourceWatch, normalizeSourceWatchConfig } from "@/lib/source-watch-config"

let unlistenQueue: UnlistenFn | null = null
let unlistenChanged: UnlistenFn | null = null
let startSeq = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let pendingRefreshPaths = new Set<string>()
let pendingChangeTasks = new Map<string, FileChangeTask>()
let activeSourceWatchConfig = normalizeSourceWatchConfig()

export async function startProjectFileSync(
  project: WikiProject,
  sourceWatchConfig?: SourceWatchConfig,
): Promise<void> {
  await stopProjectFileSync()
  const seq = ++startSeq
  activeSourceWatchConfig = normalizeSourceWatchConfig(sourceWatchConfig)
  useFileSyncStore.getState().setRunning(true)
  useFileSyncStore.getState().setLastError(null)

  unlistenQueue = await listen<FileSyncPayload>("file-sync://queue-updated", (event) => {
    if (event.payload.projectId !== useWikiStore.getState().project?.id) return
    useFileSyncStore.getState().setTasks(event.payload.tasks)
  })

  unlistenChanged = await listen<FileSyncPayload>("file-sync://changed", (event) => {
    const current = useWikiStore.getState().project
    if (!current || event.payload.projectId !== current.id) return
    scheduleRefreshAfterFileChanges(event.payload.tasks)
  })

  try {
    const queue = await startProjectFileWatcher(project.id, normalizePath(project.path), activeSourceWatchConfig)
    if (seq !== startSeq || project.id !== useWikiStore.getState().project?.id) return
    useFileSyncStore.getState().setTasks(queue.tasks)
  } catch (err) {
    unlistenQueue?.()
    unlistenChanged?.()
    unlistenQueue = null
    unlistenChanged = null
    useFileSyncStore.getState().setLastError(String(err))
    throw err
  } finally {
    if (seq === startSeq) {
      useFileSyncStore.getState().setRunning(false)
    }
  }
}

export async function stopProjectFileSync(): Promise<void> {
  startSeq++
  unlistenQueue?.()
  unlistenChanged?.()
  unlistenQueue = null
  unlistenChanged = null
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  pendingRefreshPaths.clear()
  pendingChangeTasks.clear()
  useFileSyncStore.getState().clear()
  try {
    await stopProjectFileWatcher()
  } catch {
    // App startup/project switching should not fail just because a stale
    // watcher has already been dropped by the backend.
  }
}

export async function rescanProjectFileSync(
  project: WikiProject,
  sourceWatchConfig?: SourceWatchConfig,
): Promise<void> {
  const config = normalizeSourceWatchConfig(sourceWatchConfig ?? useWikiStore.getState().sourceWatchConfig)
  activeSourceWatchConfig = config

  const result = await rescanProjectFiles(project.id, normalizePath(project.path), config)
  if (useWikiStore.getState().project?.id !== project.id) return
  useFileSyncStore.getState().setTasks(result.queue.tasks)

  if (useWikiStore.getState().project?.id !== project.id) return
  if (result.changedTasks.length > 0) {
    const paths = [...new Set(result.changedTasks.map((task) => task.path))]
    await processFileChangeBatch(project, paths, result.changedTasks)
  } else {
    await refreshAfterFileChanges(project, [])
  }
}

function scheduleRefreshAfterFileChanges(tasks: FileChangeTask[]): void {
  for (const task of tasks) {
    pendingRefreshPaths.add(task.path)
    pendingChangeTasks.set(task.path, task)
  }
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    const project = useWikiStore.getState().project
    if (!project) {
      pendingRefreshPaths.clear()
      pendingChangeTasks.clear()
      return
    }
    const paths = [...pendingRefreshPaths]
    const tasks = [...pendingChangeTasks.values()]
    pendingRefreshPaths.clear()
    pendingChangeTasks.clear()
    void processFileChangeBatch(project, paths, tasks)
  }, 250)
}

async function processFileChangeBatch(
  project: WikiProject,
  paths: string[],
  tasks: FileChangeTask[],
): Promise<void> {
  await cleanupDeletedFiles(project, tasks)
  await enqueueRawSourceChanges(project, tasks)
  await refreshAfterFileChanges(project, paths)
}

async function refreshAfterFileChanges(project: WikiProject, relativePaths: string[]): Promise<void> {
  const pp = normalizePath(project.path)
  const store = useWikiStore.getState()
  try {
    const tree = await listDirectory(pp)
    useWikiStore.getState().setFileTree(tree)
  } catch (err) {
    console.warn("[file-sync] failed to refresh file tree:", err)
  }

  store.bumpDataVersion()

  const selected = store.selectedFile ? normalizePath(store.selectedFile) : null
  if (!selected) return

  const selectedRel = selected.startsWith(`${pp}/`) ? selected.slice(pp.length + 1) : selected
  if (!relativePaths.includes(selectedRel)) return

  try {
    const content = await readFile(selected)
    useWikiStore.getState().setFileContent(content)
  } catch {
    useWikiStore.getState().setSelectedFile(null)
    useWikiStore.getState().setFileContent("")
  }
}

async function enqueueRawSourceChanges(project: WikiProject, tasks: FileChangeTask[]): Promise<void> {
  const config = normalizeSourceWatchConfig(activeSourceWatchConfig)
  if (!config.enabled || !config.autoIngest) return

  const candidates = tasks
    .filter((task) => task.projectId === project.id)
    .filter((task) => task.kind === "created" || task.kind === "modified")
    .map((task) => task.path)
    .filter(isIngestableRawSource)

  const paths = candidates.filter((rel) => isPathAllowedBySourceWatch(rel, config))

  if (paths.length === 0) return

  try {
    await enqueueSourceIngest(project, paths, useWikiStore.getState().llmConfig)
  } catch (err) {
    console.error("[file-sync] failed to enqueue raw source ingest:", err)
  }
}

function isIngestableRawSource(relativePath: string): boolean {
  const path = normalizePath(relativePath)
  if (!path.startsWith("raw/sources/")) return false
  return isIngestableSourcePath(path)
}

async function cleanupDeletedFiles(project: WikiProject, tasks: FileChangeTask[]): Promise<void> {
  const deleted = tasks
    .filter((task) => task.projectId === project.id && task.kind === "deleted")
    .map((task) => normalizePath(task.path))

  if (deleted.length === 0) return

  const rawSources = deleted.filter(isRawSourcePathForCascade)
  const wikiPages = deleted.filter(isWikiPageForCascade)

  let deletedWikiSlugs = new Set<string>()
  if (rawSources.length > 0) {
    try {
      const result = await deleteSourceFiles(project.path, rawSources, {
        fileAlreadyDeleted: true,
        logReason: rawSources.length === 1 ? "external delete" : "external batch delete",
      })
      deletedWikiSlugs = new Set(result.deletedWikiPaths.map((path) => getFileStem(path)))
    } catch (err) {
      console.error("[file-sync] failed to clean deleted raw sources:", err)
    }
  }

  const wikiPagesToClean = wikiPages.filter((path) => !deletedWikiSlugs.has(getFileStem(path)))
  if (wikiPagesToClean.length > 0) {
    try {
      await cleanupDeletedWikiPages(project.path, wikiPagesToClean)
    } catch (err) {
      console.error("[file-sync] failed to clean deleted wiki pages:", err)
    }
  }
}

function isRawSourcePathForCascade(relativePath: string): boolean {
  const path = normalizePath(relativePath)
  if (!path.startsWith("raw/sources/")) return false
  if (path.includes("/.cache/")) return false
  const fileName = path.split("/").pop() ?? ""
  return Boolean(fileName && !fileName.startsWith("."))
}

function isWikiPageForCascade(relativePath: string): boolean {
  const path = normalizePath(relativePath)
  const lower = path.toLowerCase()
  if (!lower.startsWith("wiki/") || !lower.endsWith(".md")) return false
  const name = lower.split("/").pop()
  if (name === "index.md" || name === "log.md" || name === "overview.md") {
    return false
  }
  return !lower.startsWith("wiki/media/")
}
