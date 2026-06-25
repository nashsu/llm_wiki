import { readFile, writeFile } from "@/commands/fs"
import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { hasUsableLlm } from "@/lib/has-usable-llm"

// ── Types ─────────────────────────────────────────────────────────────────

export interface IngestTask {
  id: string
  /** Stable project UUID (see project-identity.ts). Prefer this to
   *  `projectPath` because the filesystem location can change — tasks
   *  look up the current path via the registry at run time. */
  projectId: string
  sourcePath: string  // relative to project: "raw/sources/folder/file.pdf"
  folderContext: string  // e.g. "AI-Research > papers" or ""
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────

let queue: IngestTask[] = []
let activeCount = 0
/** Active abort controllers, keyed by task id. Each concurrent ingest
 *  gets its own so cancelTask can target a specific one. */
const abortControllers = new Map<string, AbortController>()
/** Written files per active task, keyed by task id. Needed so
 *  cancelTask can clean up files from the correct task. */
const writtenFilesByTask = new Map<string, string[]>()
/** UUID of the currently-active project. Used as a stale-context guard
 *  in processNext: if this changes mid-ingest (user switched projects),
 *  the orphaned runner bails instead of writing to the old project. */
let currentProjectId = ""
/** Cached filesystem path of the currently-active project. Kept in lock-
 *  step with `currentProjectId` by pauseQueue / restoreQueue so sync
 *  callers (saveQueue, cancelTask, etc.) don't need a registry lookup. */
let currentProjectPath = ""
let completedSinceIdle = 0
// Track whether any task has been processed since the last drain.
// Prevents the sweep from running on every idle/no-op call.
let processedSinceDrain = false
// Abort controller for the review-sweep LLM call so switching projects
// cancels a long-running judgment instead of burning tokens.
let sweepAbortController: AbortController | null = null

function resetQueueAccounting(): void {
  completedSinceIdle = 0
}

/** Read the configured max concurrency from the user's settings.
 *  Defaults to 1 (strictly sequential, original behavior). */
function getMaxConcurrency(): number {
  const gc = useWikiStore.getState().generalConfig
  const n = typeof gc?.ingestConcurrency === "number" ? gc.ingestConcurrency : 1
  return Math.max(1, Math.min(16, Math.round(n)))
}

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  try {
    // Only save pending and failed tasks (done tasks are removed)
    const toSave = queue.filter((t) => t.status !== "done")
    await writeFile(queueFilePath(projectPath), JSON.stringify(toSave, null, 2))
  } catch {
    // non-critical
  }
}

async function loadQueue(projectPath: string, projectId: string): Promise<IngestTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    const tasks = JSON.parse(raw) as IngestTask[]
    // Backfill projectId for tasks persisted before the field existed.
    // Files live inside a specific project, so every task in this file
    // belongs to `projectId` regardless of what's on disk.
    return tasks.map((t) => ({
      ...t,
      projectId: t.projectId ?? projectId,
    }))
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────

function generateId(): string {
  return `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeSourcePathForQueue(sourcePath: string): string {
  const normalized = normalizePath(sourcePath)
  if (currentProjectPath && normalized.startsWith(`${currentProjectPath}/`)) {
    return normalized.slice(currentProjectPath.length + 1)
  }
  return normalized
}

function sameQueuedSourcePath(a: string, b: string): boolean {
  return normalizeSourcePathForQueue(a) === normalizeSourcePathForQueue(b)
}

function upsertQueuedIngestTask(
  projectId: string,
  sourcePath: string,
  folderContext: string,
): string {
  if (queue.length === 0 && activeCount === 0) {
    resetQueueAccounting()
  }
  const normalizedSourcePath = normalizeSourcePathForQueue(sourcePath)
  const pendingOrFailed = queue.find((t) =>
    t.projectId === projectId &&
    (t.status === "pending" || t.status === "failed") &&
    sameQueuedSourcePath(t.sourcePath, normalizedSourcePath)
  )

  if (pendingOrFailed) {
    pendingOrFailed.sourcePath = normalizedSourcePath
    pendingOrFailed.folderContext = folderContext || pendingOrFailed.folderContext
    pendingOrFailed.status = "pending"
    pendingOrFailed.error = null
    pendingOrFailed.retryCount = 0
    return pendingOrFailed.id
  }

  const processingTask = queue.find((t) =>
    t.projectId === projectId &&
    t.status === "processing" &&
    sameQueuedSourcePath(t.sourcePath, normalizedSourcePath)
  )
  const pendingRerun = processingTask
    ? queue.find((t) =>
        t.projectId === projectId &&
        t.status === "pending" &&
        sameQueuedSourcePath(t.sourcePath, normalizedSourcePath)
      )
    : null

  if (pendingRerun) {
    return pendingRerun.id
  }

  const task: IngestTask = {
    id: generateId(),
    projectId,
    sourcePath: normalizedSourcePath,
    folderContext,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
  }
  queue.push(task)
  return task.id
}

/**
 * Delete files written by a cancelled / failed ingest, AND drop the
 * matching pages' chunks from LanceDB. Called from the cancel paths
 * (cancelTask, cancelAllTasks).
 *
 * Per-file errors are swallowed (best-effort cleanup) — a missing
 * file or LanceDB unavailable shouldn't abort the cancel flow.
 * Structural pages (index/log/overview) aren't embedded, so the
 * cascade no-ops for them.
 */
export async function cleanupWrittenFiles(
  projectPath: string,
  filePaths: string[],
): Promise<void> {
  const { cascadeDeleteWikiPage } = await import("@/lib/wiki-page-delete")
  for (const filePath of filePaths) {
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${projectPath}/${filePath}`
    try {
      await cascadeDeleteWikiPage(projectPath, fullPath)
    } catch {
      // file may not exist / lancedb unavailable — non-critical
    }
  }
}

/**
 * Add a file to the ingest queue. The project MUST be the currently-
 * active project — switching first is a prerequisite. Returns the new
 * task's id.
 */
export async function enqueueIngest(
  projectId: string,
  sourcePath: string,
  folderContext: string = "",
): Promise<string> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueIngest: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const id = upsertQueuedIngestTask(projectId, sourcePath, folderContext)
  await saveQueue(currentProjectPath)

  processNext(currentProjectId)

  return id
}

/**
 * Add multiple files to the queue at once. Same active-project
 * requirement as enqueueIngest.
 */
export async function enqueueBatch(
  projectId: string,
  files: Array<{ sourcePath: string; folderContext: string }>,
): Promise<string[]> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueBatch: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const ids: string[] = []
  for (const file of files) {
    ids.push(upsertQueuedIngestTask(projectId, file.sourcePath, file.folderContext))
  }

  await saveQueue(currentProjectPath)
  console.log(`[Ingest Queue] Enqueued ${files.length} files (maxConcurrency=${getMaxConcurrency()})`)
  processNext(currentProjectId)

  return ids
}

/**
 * Retry a failed task. Only valid for tasks in the active project's
 * queue.
 */
export async function retryTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  task.status = "pending"
  task.error = null
  task.retryCount = 0
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
}

/**
 * Retry every failed task for the active project.
 * Returns the number of tasks requeued.
 */
export async function retryAllFailedTasks(): Promise<number> {
  if (!currentProjectId) return 0

  let requeued = 0
  for (const task of queue) {
    if (task.projectId !== currentProjectId || task.status !== "failed") continue
    task.status = "pending"
    task.error = null
    task.retryCount = 0
    requeued++
  }

  if (requeued === 0) return 0

  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
  return requeued
}

/**
 * Cancel a pending or processing task.
 * If processing, aborts the LLM call and cleans up generated files.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  if (task.status === "processing") {
    // Abort the in-progress LLM call for this specific task
    const ac = abortControllers.get(taskId)
    if (ac) {
      ac.abort()
      abortControllers.delete(taskId)
    }

    // Clean up any files written by the interrupted ingest
    const files = writtenFilesByTask.get(taskId)
    if (files && files.length > 0) {
      await cleanupWrittenFiles(currentProjectPath, files)
      console.log(`[Ingest Queue] Cleaned up ${files.length} files from cancelled task ${taskId}`)
      writtenFilesByTask.delete(taskId)
    }

    activeCount = Math.max(0, activeCount - 1)
  }

  queue = queue.filter((t) => t.id !== taskId)
  await saveQueue(currentProjectPath)
  console.log(`[Ingest Queue] Cancelled: ${task.sourcePath}`)

  processNext(currentProjectId)
}

/**
 * Clear all done/failed tasks from the active project's queue.
 */
export async function clearCompletedTasks(): Promise<void> {
  queue = queue.filter((t) => t.status === "pending" || t.status === "processing")
  await saveQueue(currentProjectPath)
}

/**
 * Cancel everything that's not finished in the active project's queue:
 * aborts all running tasks (if any), cleans up their partial output,
 * and drops every pending + processing item.
 *
 * Failed tasks are retained so the user can still see / retry them.
 * Returns the number of tasks removed from the queue.
 */
export async function cancelAllTasks(): Promise<number> {
  // Abort all in-flight tasks
  for (const [taskId, ac] of abortControllers) {
    ac.abort()
    const files = writtenFilesByTask.get(taskId)
    if (files && files.length > 0) {
      await cleanupWrittenFiles(currentProjectPath, files)
    }
  }
  abortControllers.clear()
  writtenFilesByTask.clear()
  activeCount = 0

  const before = queue.length
  queue = queue.filter((t) => t.status === "failed")
  const removed = before - queue.length

  await saveQueue(currentProjectPath)
  console.log(`[Ingest Queue] Cancelled all: ${removed} tasks removed`)
  return removed
}

/**
 * Get current queue state.
 */
export function getQueue(): readonly IngestTask[] {
  return queue
}

/**
 * Get queue summary.
 */
export function getQueueSummary(): { pending: number; processing: number; failed: number; completed: number; total: number } {
  const activeTotal = queue.length + completedSinceIdle
  return {
    pending: queue.filter((t) => t.status === "pending").length,
    processing: activeCount,
    failed: queue.filter((t) => t.status === "failed").length,
    completed: completedSinceIdle,
    total: activeTotal,
  }
}

/**
 * Clear all in-memory queue state without touching disk. Used by tests
 * that want a clean slate between cases. **Production code should use
 * `pauseQueue()` on project switch**, which flushes pending state to
 * disk before clearing memory.
 */
export function clearQueueState(): void {
  for (const [, ac] of abortControllers) {
    ac.abort()
  }
  abortControllers.clear()
  writtenFilesByTask.clear()
  if (sweepAbortController) {
    sweepAbortController.abort()
  }
  queue = []
  activeCount = 0
  currentProjectId = ""
  currentProjectPath = ""
  sweepAbortController = null
  processedSinceDrain = false
  resetQueueAccounting()
}

/**
 * Project-switch handshake. Flushes the active project's current queue
 * state to its disk file (so pending/failed tasks survive the switch),
 * reverts any processing task to pending, then clears in-memory state
 * so the next `restoreQueue()` can safely load a different project.
 *
 * Must be called before opening or switching to a different project.
 * Must be `await`ed — the disk flush is async.
 */
export async function pauseQueue(): Promise<void> {
  if (!currentProjectId || !currentProjectPath) {
    // Nothing to pause (no active project)
    return
  }

  const pausedProjectPath = currentProjectPath

  // Abort all in-flight tasks
  for (const [, ac] of abortControllers) {
    ac.abort()
  }
  abortControllers.clear()
  writtenFilesByTask.clear()
  activeCount = 0

  if (sweepAbortController) {
    sweepAbortController.abort()
    sweepAbortController = null
  }

  // Revert any in-flight processing task back to pending so when the
  // user returns to this project, the task is re-tried from scratch.
  for (const task of queue) {
    if (task.status === "processing") {
      task.status = "pending"
    }
  }

  // Flush the paused state to THIS project's disk before wiping memory.
  await saveQueue(pausedProjectPath)

  queue = []
  currentProjectId = ""
  currentProjectPath = ""
  processedSinceDrain = false
  resetQueueAccounting()
}

// ── Restore on startup ───────────────────────────────────────────────────

/**
 * Load queue from disk and resume processing. Called on app startup
 * and when opening / switching to a project. `pauseQueue()` must have
 * been called first (or the active project already cleared) so that
 * in-memory state is not contaminated from the previous project.
 */
export async function restoreQueue(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  // Defensive: reset in-memory state (should already be empty via
  // pauseQueue, but clearing again costs nothing).
  queue = []
  activeCount = 0
  abortControllers.clear()
  writtenFilesByTask.clear()
  resetQueueAccounting()
  currentProjectId = projectId
  currentProjectPath = pp

  const saved = await loadQueue(pp, projectId)

  if (saved.length === 0) return

  // Drop any cross-project contamination (shouldn't happen in practice
  // but defends against a corrupt queue file).
  const mine = saved.filter((t) => t.projectId === projectId)
  if (mine.length !== saved.length) {
    console.warn(
      `[Ingest Queue] Dropped ${saved.length - mine.length} cross-project tasks during restore`,
    )
  }

  // Reset any "processing" tasks back to "pending" (interrupted by app close)
  let restored = 0
  for (const task of mine) {
    if (task.status === "processing") {
      task.status = "pending"
      restored++
    }
  }

  queue = mine
  await saveQueue(pp)

  const pending = queue.filter((t) => t.status === "pending").length
  const failed = queue.filter((t) => t.status === "failed").length

  if (pending > 0 || restored > 0) {
    console.log(`[Ingest Queue] Restored: ${pending} pending, ${failed} failed, ${restored} resumed from interrupted`)
    processNext(projectId)
  }
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

async function onQueueDrained(projectId: string, projectPath: string): Promise<void> {
  if (!processedSinceDrain) return
  // Stale-context guard — if we switched projects mid-drain, the sweep
  // would burn tokens analyzing the wrong project.
  if (currentProjectId !== projectId) return
  processedSinceDrain = false

  sweepAbortController = new AbortController()
  const signal = sweepAbortController.signal

  try {
    const { sweepResolvedReviews } = await import("@/lib/sweep-reviews")
    await sweepResolvedReviews(projectPath, signal)
  } catch (err) {
    console.error("[Ingest Queue] Failed to load sweep-reviews:", err)
  } finally {
    if (sweepAbortController && sweepAbortController.signal === signal) {
      sweepAbortController = null
    }
  }
}

async function processNext(projectId: string): Promise<void> {
  const maxConcurrency = getMaxConcurrency()

  // Stale-context guard: processNext may be invoked by an orphaned
  // recursion from a previous project. If we're no longer active, bail.
  if (currentProjectId !== projectId) return

  // Keep launching tasks until the concurrency slot is full or queue is empty
  while (activeCount < maxConcurrency) {
    // Re-check stale context inside the loop (project could switch during await)
    if (currentProjectId !== projectId) return

    const next = queue.find((t) => t.projectId === projectId && t.status === "pending")
    if (!next) {
      // Queue drained — if nothing is actively processing, trigger cleanup
      if (activeCount === 0 && processedSinceDrain) {
        const pathAtDrain = currentProjectPath
        onQueueDrained(projectId, pathAtDrain).catch((err) =>
          console.error("[Ingest Queue] sweep failed:", err)
        )
      }
      return
    }

    // Look up the project's current filesystem path from the registry —
    // it may have moved since the task was enqueued.
    const registryPath = await getProjectPathById(projectId)
    const pp = registryPath ? normalizePath(registryPath) : ""

    // Check we're still active after the registry await.
    if (currentProjectId !== projectId) return

    if (!pp) {
      next.status = "failed"
      next.error = "Project not found in registry (was it deleted?)"
      await saveQueue(currentProjectPath)
      // Don't recurse — the while loop will pick up the next task
      continue
    }

    // Mark as processing BEFORE bumping activeCount so cancelTask sees it
    next.status = "processing"
    activeCount++
    await saveQueue(pp)
    if (currentProjectId !== projectId) return

    const llmConfig = useWikiStore.getState().llmConfig

    // Check if LLM is configured
    if (!hasUsableLlm(llmConfig)) {
      next.status = "failed"
      next.error = "LLM not configured — set API key in Settings"
      activeCount = Math.max(0, activeCount - 1)
      await saveQueue(pp)
      continue
    }

    const fullSourcePath = isAbsolutePath(next.sourcePath)
      ? normalizePath(next.sourcePath)
      : `${pp}/${next.sourcePath}`

    const remaining = queue.filter((t) => t.projectId === projectId && t.status === "pending").length
    console.log(`[Ingest Queue] Processing: ${next.sourcePath} (${remaining} remaining, ${activeCount}/${maxConcurrency} active)`)

    const ac = new AbortController()
    abortControllers.set(next.id, ac)
    writtenFilesByTask.set(next.id, [])

    // Fire-and-forget this task (don't await — let the loop start the next one)
    runTask(next.id, pp, fullSourcePath, llmConfig, ac, projectId).catch((err) => {
      console.error(`[Ingest Queue] Unhandled error in runTask(${next.id}):`, err)
    })
  }
}

async function runTask(
  taskId: string,
  projectPath: string,
  fullSourcePath: string,
  llmConfig: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  abortController: AbortController,
  projectId: string,
): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) {
    activeCount = Math.max(0, activeCount - 1)
    return
  }

  try {
    const writtenFiles = await autoIngest(
      projectPath,
      fullSourcePath,
      llmConfig,
      abortController.signal,
      task.folderContext,
    )

    // Stale-context guard: project switched during the long LLM call
    if (currentProjectId !== projectId) return

    if (writtenFiles.length > 0) {
      writtenFilesByTask.set(taskId, writtenFiles)
    }

    // Safety net: autoIngest returning zero files is treated as failure
    if (writtenFiles.length === 0) {
      throw new Error("Ingest produced no output files")
    }

    // Success: remove from queue
    abortControllers.delete(taskId)
    writtenFilesByTask.delete(taskId)
    queue = queue.filter((t) => t.id !== taskId)
    completedSinceIdle++
    processedSinceDrain = true
    activeCount = Math.max(0, activeCount - 1)
    await saveQueue(projectPath)

    console.log(`[Ingest Queue] Done: ${task.sourcePath}`)
  } catch (err) {
    if (currentProjectId !== projectId) return

    abortControllers.delete(taskId)
    writtenFilesByTask.delete(taskId)
    const message = err instanceof Error ? err.message : String(err)
    task.retryCount++
    task.error = message

    if (task.retryCount >= MAX_RETRIES) {
      task.status = "failed"
      console.log(`[Ingest Queue] Failed (${task.retryCount}x): ${task.sourcePath} — ${message}`)
    } else {
      task.status = "pending" // will retry
      console.log(`[Ingest Queue] Error (retry ${task.retryCount}/${MAX_RETRIES}): ${task.sourcePath} — ${message}`)
    }

    activeCount = Math.max(0, activeCount - 1)
    await saveQueue(projectPath)
  }

  // After one task finishes, try to start the next one
  processNext(projectId)
}
