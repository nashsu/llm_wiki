import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { deleteFile, findRelatedWikiPages, readFile, listDirectory, writeFile } from "@/commands/fs"
import {
  startProjectFileWatcher,
  stopProjectFileWatcher,
  type FileSyncPayload,
} from "@/commands/file-sync"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import type { WikiProject } from "@/types/wiki"
import { enqueueBatch } from "@/lib/ingest-queue"
import type { FileChangeTask } from "@/commands/file-sync"
import { decidePageFate } from "@/lib/source-delete-decision"
import { parseSources, writeSources } from "@/lib/sources-merge"
import { removeFromIngestCache } from "@/lib/ingest-cache"
import { getFileStem } from "@/lib/path-utils"
import { removePageEmbedding } from "@/lib/embedding"
import {
  buildDeletedKeys,
  cleanIndexListing,
  stripDeletedWikilinks,
} from "@/lib/wiki-cleanup"
import {
  parseFrontmatterArray,
  writeFrontmatterArray,
} from "@/lib/sources-merge"
import type { FileNode } from "@/types/wiki"

let unlistenQueue: UnlistenFn | null = null
let unlistenChanged: UnlistenFn | null = null
let startSeq = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let pendingRefreshPaths = new Set<string>()
let pendingChangeTasks = new Map<string, FileChangeTask>()

const INGESTABLE_SOURCE_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "xls",
  "csv",
  "json",
  "html",
  "htm",
  "rtf",
  "xml",
  "yaml",
  "yml",
])

export async function startProjectFileSync(project: WikiProject): Promise<void> {
  await stopProjectFileSync()
  const seq = ++startSeq
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
    const queue = await startProjectFileWatcher(project.id, normalizePath(project.path))
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
    void refreshAfterFileChanges(project, paths)
    void enqueueRawSourceChanges(project, tasks)
    void cleanupDeletedFiles(project, tasks)
  }, 250)
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
  const files = tasks
    .filter((task) => task.projectId === project.id)
    .filter((task) => task.kind === "created" || task.kind === "modified")
    .filter((task) => isIngestableRawSource(task.path))
    .map((task) => ({
      sourcePath: task.path,
      folderContext: folderContextForRawSource(task.path),
    }))

  if (files.length === 0) return

  try {
    await enqueueBatch(project.id, files)
  } catch (err) {
    console.error("[file-sync] failed to enqueue raw source ingest:", err)
  }
}

function isIngestableRawSource(relativePath: string): boolean {
  const path = normalizePath(relativePath)
  if (!path.startsWith("raw/sources/")) return false
  const fileName = path.split("/").pop() ?? ""
  if (!fileName || fileName.startsWith(".")) return false
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : ""
  return ext ? INGESTABLE_SOURCE_EXTENSIONS.has(ext) : false
}

function folderContextForRawSource(relativePath: string): string {
  const rel = normalizePath(relativePath).slice("raw/sources/".length)
  const parts = rel.split("/")
  parts.pop()
  return parts.join(" > ")
}

async function cleanupDeletedFiles(project: WikiProject, tasks: FileChangeTask[]): Promise<void> {
  const deleted = tasks
    .filter((task) => task.projectId === project.id && task.kind === "deleted")
    .map((task) => normalizePath(task.path))

  if (deleted.length === 0) return

  const rawSources = deleted.filter(isRawSourcePathForCascade)
  const wikiPages = deleted.filter(isWikiPageForCascade)

  for (const rel of rawSources) {
    try {
      await cleanupExternallyDeletedRawSource(project.path, rel)
    } catch (err) {
      console.error(`[file-sync] failed to clean deleted raw source ${rel}:`, err)
    }
  }

  if (wikiPages.length > 0) {
    try {
      await cleanupExternallyDeletedWikiPages(project.path, wikiPages)
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
  if (!path.startsWith("wiki/") || !path.endsWith(".md")) return false
  if (path === "wiki/index.md" || path === "wiki/log.md" || path === "wiki/overview.md") {
    return false
  }
  return !path.startsWith("wiki/media/")
}

async function cleanupExternallyDeletedRawSource(
  projectPath: string,
  relativePath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const fileName = relativePath.split("/").pop() ?? ""
  if (!fileName) return

  const relatedPages = await findRelatedWikiPages(pp, fileName)
  const candidatePages = new Set(relatedPages)
  try {
    const wikiTree = await listDirectory(`${pp}/wiki`)
    for (const file of flattenMd(wikiTree)) {
      try {
        const content = await readFile(file.path)
        if (parseSources(content).some((source) => sourceMatchesDeletedFile(source, fileName))) {
          candidatePages.add(file.path)
        }
      } catch {
        // Ignore unreadable pages; the related-pages pass may still cover them.
      }
    }
  } catch (err) {
    console.warn("[file-sync] failed to scan wiki sources during source delete cleanup:", err)
  }

  const pagesToDelete: string[] = []
  let keptCount = 0

  for (const pagePath of candidatePages) {
    try {
      const content = await readFile(pagePath)
      const decision = decidePageFate(parseSources(content), fileName)
      if (decision.action === "keep") {
        await writeFile(pagePath, writeSources(content, decision.updatedSources))
        keptCount++
      } else if (decision.action === "delete") {
        pagesToDelete.push(pagePath)
      }
    } catch (err) {
      console.warn(`[file-sync] failed to process related page ${pagePath}:`, err)
    }
  }

  if (pagesToDelete.length > 0) {
    const { cascadeDeleteWikiPagesWithRefs } = await import("@/lib/wiki-page-delete")
    await cascadeDeleteWikiPagesWithRefs(pp, pagesToDelete)
  }

  try {
    await deleteFile(`${pp}/raw/sources/.cache/${fileName}.txt`)
  } catch {
    // cache may not exist
  }

  try {
    await removeFromIngestCache(pp, fileName)
  } catch {
    // non-critical
  }

  try {
    const logPath = `${pp}/wiki/log.md`
    const logContent = await readFile(logPath).catch(() => "# Wiki Log\n")
    const date = new Date().toISOString().slice(0, 10)
    const logEntry = `\n## [${date}] external delete | ${fileName}\n\nDetected deleted source file and cleaned ${pagesToDelete.length} wiki pages.${keptCount > 0 ? ` ${keptCount} shared pages kept (have other sources).` : ""}\n`
    await writeFile(logPath, logContent.trimEnd() + logEntry)
  } catch {
    // non-critical
  }
}

async function cleanupExternallyDeletedWikiPages(
  projectPath: string,
  relativePaths: string[],
): Promise<void> {
  const pp = normalizePath(projectPath)
  const deletedInfos = relativePaths
    .map((path) => ({ slug: getFileStem(path), title: "" }))
    .filter((info) => info.slug.length > 0 && !info.slug.startsWith("."))

  if (deletedInfos.length === 0) return

  for (const info of deletedInfos) {
    await removePageEmbedding(pp, info.slug)
    try {
      await deleteFile(`${pp}/wiki/media/${info.slug}`)
    } catch {
      // only source-summary pages usually own media; absence is normal
    }
  }

  const deletedKeys = buildDeletedKeys(deletedInfos)
  const deletedSlugSet = new Set(deletedInfos.map((info) => normalizeCleanupKey(info.slug)))
  const wikiTree = await listDirectory(`${pp}/wiki`)
  const allMd = flattenMd(wikiTree)

  for (const file of allMd) {
    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    let updated = content
    if (file.path === `${pp}/wiki/index.md` || file.name === "index.md") {
      updated = cleanIndexListing(updated, deletedKeys)
    }
    updated = stripDeletedWikilinks(updated, deletedKeys)

    const related = parseFrontmatterArray(updated, "related")
    if (related.length > 0) {
      const filtered = related.filter((s) => !deletedSlugSet.has(normalizeCleanupKey(s)))
      if (filtered.length !== related.length) {
        updated = writeFrontmatterArray(updated, "related", filtered)
      }
    }

    if (updated !== content) {
      try {
        await writeFile(file.path, updated)
      } catch (err) {
        console.warn(`[file-sync] failed to rewrite ${file.path}:`, err)
      }
    }
  }
}

function flattenMd(nodes: readonly FileNode[]): FileNode[] {
  const out: FileNode[] = []
  function walk(items: readonly FileNode[]): void {
    for (const item of items) {
      if (item.is_dir) {
        if (item.children) walk(item.children)
      } else if (item.name.endsWith(".md")) {
        out.push(item)
      }
    }
  }
  walk(nodes)
  return out
}

function sourceMatchesDeletedFile(source: string, fileName: string): boolean {
  const normalizedSource = normalizePath(source).split("/").pop()?.toLowerCase() ?? ""
  return normalizedSource === fileName.toLowerCase()
}

function normalizeCleanupKey(value: string): string {
  return value.toLowerCase().replace(/[\s\-_]+/g, "")
}
