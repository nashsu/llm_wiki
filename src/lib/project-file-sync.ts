import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { readFile } from "@/commands/fs"
import {
  invalidateProjectFileSnapshotPaths,
  rescanProjectFiles,
  startProjectFileWatcher,
  stopProjectFileWatcher,
  type FileSyncPayload,
} from "@/commands/file-sync"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { wikiPageIdFromPath } from "@/lib/embedding"
import type { WikiProject } from "@/types/wiki"
import type { SourceWatchConfig } from "@/stores/wiki-store"
import type { FileChangeTask } from "@/commands/file-sync"
import {
  cleanupDeletedWikiPages,
  deleteSourceFiles,
  enqueueSourceIngest,
  folderContextForSourcePath,
  isIngestableSourcePath,
  migrateSourcePath,
} from "@/lib/source-lifecycle"
import {
  discardInactiveProjectTasksForSources,
  enqueueInactiveProjectBatch,
} from "@/lib/ingest-queue"
import { isPathAllowedBySourceWatch, normalizeSourceWatchConfig } from "@/lib/source-watch-config"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { getRecentProjects, loadSourceWatchConfig } from "@/lib/project-store"

let unlistenQueue: UnlistenFn | null = null
let unlistenChanged: UnlistenFn | null = null
let startSeq = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let pendingRefreshPaths = new Set<string>()
let pendingChangeTasks = new Map<string, FileChangeTask>()
let activeSourceWatchConfig = normalizeSourceWatchConfig()
let handledChangeTaskKeys = new Set<string>()
let allProjectsTimer: ReturnType<typeof setInterval> | null = null
let allProjectsRunId = 0
let allProjectsScanning = false
let allProjectsActiveProject: WikiProject | null = null
const ALL_PROJECTS_SCAN_INTERVAL_MS = 60_000

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
    const result = await startProjectFileWatcher(project.id, normalizePath(project.path), activeSourceWatchConfig)
    if (seq !== startSeq || project.id !== useWikiStore.getState().project?.id) return
    const startupChangedTasks = mergeChangeTasks([
      ...result.changedTasks,
      ...pendingChangeTasks.values(),
    ].filter((task) => task.projectId === project.id))
      .filter((task) => !handledChangeTaskKeys.has(changeTaskKey(task)))
    pendingRefreshPaths.clear()
    pendingChangeTasks.clear()
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    useFileSyncStore.getState().setTasks(result.queue.tasks)
    if (startupChangedTasks.length > 0) {
      const paths = [...new Set(startupChangedTasks.map((task) => task.path))]
      await processFileChangeBatch(project, paths, startupChangedTasks)
    }
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
  handledChangeTaskKeys.clear()
  useFileSyncStore.getState().clear()
  try {
    await stopProjectFileWatcher()
  } catch {
    // App startup/project switching should not fail just because a stale
    // watcher has already been dropped by the backend.
  }
}

export function startAllProjectFileSync(activeProject: WikiProject): void {
  stopAllProjectFileSync()
  allProjectsActiveProject = activeProject
  const runId = ++allProjectsRunId
  void scanInactiveProjects(activeProject, runId)
  allProjectsTimer = setInterval(() => {
    void scanInactiveProjects(activeProject, runId)
  }, ALL_PROJECTS_SCAN_INTERVAL_MS)
}

export function stopAllProjectFileSync(): void {
  allProjectsRunId += 1
  allProjectsActiveProject = null
  if (allProjectsTimer) {
    clearInterval(allProjectsTimer)
    allProjectsTimer = null
  }
}

async function scanInactiveProjects(activeProject: WikiProject, runId: number): Promise<void> {
  if (allProjectsScanning || runId !== allProjectsRunId) return
  allProjectsScanning = true
  try {
    const recents = await getRecentProjects()
    const seen = new Set<string>([activeProject.id])
    const seenPaths = new Set<string>([normalizePath(activeProject.path)])
    for (const project of recents) {
      if (runId !== allProjectsRunId) return
      const projectPath = normalizePath(project.path)
      if (seen.has(project.id) || seenPaths.has(projectPath)) continue
      seen.add(project.id)
      seenPaths.add(projectPath)
      try {
        const config = normalizeSourceWatchConfig(await loadSourceWatchConfig(project.id))
        if (!config.enabled) continue
        const result = await rescanProjectFiles(
          project.id,
          projectPath,
          config,
          true,
        )
        if (runId !== allProjectsRunId) return
        if (result.changedTasks.length > 0) {
          const paths = [...new Set(result.changedTasks.map((task) => task.path))]
          await processFileChangeBatch(project, paths, result.changedTasks, config, false)
        }
      } catch (err) {
        console.warn(`[file-sync] failed to scan inactive project ${project.path}:`, err)
      }
    }
  } finally {
    allProjectsScanning = false
    const latestProject = allProjectsActiveProject
    const latestRunId = allProjectsRunId
    if (runId !== latestRunId && latestProject && allProjectsTimer) {
      void scanInactiveProjects(latestProject, latestRunId)
    }
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
    const tasks = mergeChangeTasks([...pendingChangeTasks.values()])
      .filter((task) => !handledChangeTaskKeys.has(changeTaskKey(task)))
    const paths = tasks.length > 0
      ? [...new Set(tasks.map((task) => task.path))]
      : [...pendingRefreshPaths]
    pendingRefreshPaths.clear()
    pendingChangeTasks.clear()
    void processFileChangeBatch(project, paths, tasks)
  }, 250)
}

function mergeChangeTasks(tasks: FileChangeTask[]): FileChangeTask[] {
  const byKey = new Map<string, FileChangeTask>()
  for (const task of tasks) {
    byKey.set(changeTaskKey(task), task)
  }
  return [...byKey.values()]
}

function changeTaskKey(task: FileChangeTask): string {
  const version = task.updatedAt ?? task.createdAt ?? 0
  return task.id
    ? `${task.id}:${version}`
    : `${task.projectId}:${task.path}:${task.kind}:${version}`
}

async function processFileChangeBatch(
  project: WikiProject,
  paths: string[],
  tasks: FileChangeTask[],
  sourceWatchConfig: SourceWatchConfig = activeSourceWatchConfig,
  refreshActiveProject = true,
): Promise<void> {
  for (const task of tasks) {
    handledChangeTaskKeys.add(changeTaskKey(task))
  }
  if (handledChangeTaskKeys.size > 4096) {
    handledChangeTaskKeys = new Set([...handledChangeTaskKeys].slice(-2048))
  }
  if (!refreshActiveProject) {
    const deletedSources = tasks
      .filter((task) => task.kind === "deleted" && isRawSourcePathForCascade(task.path))
      .map((task) => task.path)
    await discardInactiveProjectTasksForSources(project.id, project.path, deletedSources)
  }
  const movedTaskIds = await migrateUnchangedSourceMoves(project, tasks)
  const remainingTasks = tasks.filter((task) => !movedTaskIds.has(task.id))
  await cleanupDeletedFiles(project, remainingTasks)
  await enqueueRawSourceChanges(project, remainingTasks, sourceWatchConfig, refreshActiveProject)
  if (refreshActiveProject) await refreshAfterFileChanges(project, paths)
}

async function migrateUnchangedSourceMoves(
  project: WikiProject,
  tasks: FileChangeTask[],
): Promise<Set<string>> {
  const moved = new Set<string>()
  const createdByHash = new Map<string, FileChangeTask[]>()
  const deletedByHash = new Map<string, FileChangeTask[]>()
  for (const task of tasks) {
    if (!isRawSourcePathForCascade(task.path)) continue
    if (task.kind === "created" && task.hashAfter && (task.size ?? 0) >= 32) {
      const matches = createdByHash.get(task.hashAfter) ?? []
      matches.push(task)
      createdByHash.set(task.hashAfter, matches)
    } else if (task.kind === "deleted" && task.hashBefore && (task.size ?? 0) >= 32) {
      const matches = deletedByHash.get(task.hashBefore) ?? []
      matches.push(task)
      deletedByHash.set(task.hashBefore, matches)
    }
  }

  for (const [hash, deletedMatches] of deletedByHash) {
    const createdMatches = createdByHash.get(hash)
    // Content identity only proves a move when both sides are unique.
    if (deletedMatches.length !== 1 || createdMatches?.length !== 1) continue
    const deleted = deletedMatches[0]
    const created = createdMatches[0]
    try {
      await migrateSourcePath(project.path, deleted.path, created.path)
      moved.add(deleted.id)
      moved.add(created.id)
    } catch (err) {
      console.error("[file-sync] failed to migrate unchanged source move:", err)
      // The hash pair still proves this is a move. Suppress destructive
      // delete/create fallback after a transactional migration rollback;
      // surface the failure so the user can retry with a manual rescan.
      moved.add(deleted.id)
      moved.add(created.id)
      useFileSyncStore.getState().setLastError(
        `Failed to migrate moved source metadata: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return moved
}

async function refreshAfterFileChanges(project: WikiProject, relativePaths: string[]): Promise<void> {
  const pp = normalizePath(project.path)
  const store = useWikiStore.getState()
  await refreshProjectFileTree(pp, {
    projectId: project.id,
    bumpDataVersion: true,
  })

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

async function enqueueRawSourceChanges(
  project: WikiProject,
  tasks: FileChangeTask[],
  sourceWatchConfig: SourceWatchConfig,
  activeProject: boolean,
): Promise<void> {
  const config = normalizeSourceWatchConfig(sourceWatchConfig)
  if (!config.enabled || !config.autoIngest) return

  const candidates = tasks
    .filter((task) => task.projectId === project.id)
    .filter((task) => task.kind === "created" || task.kind === "modified")
    .map((task) => task.path)
    .filter(isIngestableRawSource)

  const paths = candidates.filter((rel) => isPathAllowedBySourceWatch(rel, config))

  if (paths.length === 0) return

  try {
    if (activeProject) {
      await enqueueSourceIngest(project, paths, useWikiStore.getState().llmConfig, {
        parsingConcurrency: config.parsingConcurrency,
      })
    } else {
      await enqueueInactiveProjectBatch(
        project.id,
        project.path,
        paths.map((sourcePath) => ({
          sourcePath,
          folderContext: folderContextForSourcePath(sourcePath),
        })),
      )
    }
  } catch (err) {
    console.error("[file-sync] failed to enqueue raw source ingest:", err)
    if (!activeProject) {
      try {
        await invalidateProjectFileSnapshotPaths(project.path, paths)
      } catch (invalidateErr) {
        console.error("[file-sync] failed to schedule background ingest retry:", invalidateErr)
      }
    }
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

  let deletedWikiIds = new Set<string>()
  if (rawSources.length > 0) {
    try {
      const result = await deleteSourceFiles(project.path, rawSources, {
        fileAlreadyDeleted: true,
        logReason: rawSources.length === 1 ? "external delete" : "external batch delete",
      })
      deletedWikiIds = new Set(
        result.deletedWikiPaths.map((path) => wikiPageIdFromPath(project.path, path)),
      )
    } catch (err) {
      console.error("[file-sync] failed to clean deleted raw sources:", err)
    }
  }

  const wikiPagesToClean = wikiPages.filter(
    (path) => !deletedWikiIds.has(wikiPageIdFromPath(project.path, path)),
  )
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
