import { readFile, writeFile } from "@/commands/fs"
import { autoIngest } from "./ingest"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"

// ── Types ─────────────────────────────────────────────────────────────────

export interface IngestTask {
  id: string
  /** Stable project UUID (see project-identity.ts). Prefer this to
   *  `projectPath` because the filesystem location can change — tasks
   *  look up the current path via the registry at run time. */
  projectId: string
  sourcePath: string  // relative to project: "raw/sources/folder/file.pdf"
  folderContext: string  // e.g. "AI-Research > papers" or ""
  status: "pending" | "processing" | "done" | "failed" | "cancelled"
  addedAt: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────

let queue: IngestTask[] = []
let processing = false
/** User-controlled pause. When true, processNext stops handing pending
 *  tasks to the LLM. If a task is in flight, pauseProcessing aborts it
 *  and returns it to pending so token spend stops promptly. The drain-
 *  sweep (also an LLM call) is suppressed too, which is intentional.
 *  In-memory only: not persisted, reset to false on restoreQueue and
 *  clearQueueState. */
let paused = false
/** Pending task IDs loaded from disk on startup/project open. These are
 *  intentionally not auto-run to avoid surprise LLM/MinerU spend when the
 *  app opens. New live tasks still run; if a live enqueue touches the same
 *  source, it promotes that restored task out of this set. */
let restoredPausedTaskIds = new Set<string>()
/** UUID of the currently-active project. Used as a stale-context guard
 *  in processNext: if this changes mid-ingest (user switched projects),
 *  the orphaned runner bails instead of writing to the old project. */
let currentProjectId = ""
/** Cached filesystem path of the currently-active project. Kept in lock-
 *  step with `currentProjectId` by pauseQueue / restoreQueue so sync
 *  callers (saveQueue, cancelTask, etc.) don't need a registry lookup. */
let currentProjectPath = ""
let currentAbortController: AbortController | null = null
let lastWrittenFiles: string[] = []  // track files written by current ingest for cleanup
/** Task runs cancelled while still inside autoIngest. This is separate from
 * the persisted task status because the user may restart a retained task
 * before the old run observes its AbortSignal. In that case the old output
 * must still be discarded before the restarted pending task can run. */
let cancelledInFlightTaskIds = new Set<string>()
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

function isStructuralWikiPath(filePath: string): boolean {
  const normalized = normalizePath(filePath)
  return (
    normalized.endsWith("/wiki/index.md") ||
    normalized.endsWith("/wiki/log.md") ||
    normalized.endsWith("/wiki/overview.md") ||
    normalized === "wiki/index.md" ||
    normalized === "wiki/log.md" ||
    normalized === "wiki/overview.md"
  )
}

function upsertQueuedIngestTask(
  projectId: string,
  sourcePath: string,
  folderContext: string,
): string {
  if (queue.length === 0 && !processing) {
    resetQueueAccounting()
  }
  const normalizedSourcePath = normalizeSourcePathForQueue(sourcePath)
  const pendingOrStopped = queue.find((t) =>
    t.projectId === projectId &&
    (t.status === "pending" || t.status === "failed" || t.status === "cancelled") &&
    sameQueuedSourcePath(t.sourcePath, normalizedSourcePath)
  )

  if (pendingOrStopped) {
    restoredPausedTaskIds.delete(pendingOrStopped.id)
    pendingOrStopped.sourcePath = normalizedSourcePath
    pendingOrStopped.folderContext = folderContext || pendingOrStopped.folderContext
    pendingOrStopped.status = "pending"
    pendingOrStopped.error = null
    pendingOrStopped.retryCount = 0
    return pendingOrStopped.id
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
    if (isStructuralWikiPath(filePath)) continue
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
  console.log(`[Ingest Queue] Enqueued ${files.length} files`)
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

  restoredPausedTaskIds.delete(task.id)
  task.status = "pending"
  task.error = null
  task.retryCount = 0
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
}

/** Requeue selected failed or cancelled tasks in their existing priority order. */
export async function retryTasks(taskIds: readonly string[]): Promise<number> {
  if (!currentProjectId) return 0
  const selected = new Set(taskIds)
  let requeued = 0
  for (const task of queue) {
    if (
      task.projectId !== currentProjectId ||
      !selected.has(task.id) ||
      (task.status !== "failed" && task.status !== "cancelled")
    ) continue
    restoredPausedTaskIds.delete(task.id)
    task.status = "pending"
    task.error = null
    task.retryCount = 0
    requeued += 1
  }
  if (requeued === 0) return 0
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
  return requeued
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
    restoredPausedTaskIds.delete(task.id)
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

export async function retryAllStoppedTasks(): Promise<number> {
  return retryTasks(
    queue
      .filter(
        (task) =>
          task.projectId === currentProjectId &&
          (task.status === "failed" || task.status === "cancelled"),
      )
      .map((task) => task.id),
  )
}

/** Move a pending task one slot in queue priority without crossing active work. */
export async function movePendingTask(
  taskId: string,
  direction: "up" | "down",
): Promise<boolean> {
  const pending = queue.filter(
    (task) => task.projectId === currentProjectId && task.status === "pending",
  )
  const position = pending.findIndex((task) => task.id === taskId)
  const swapPosition = direction === "up" ? position - 1 : position + 1
  if (position < 0 || swapPosition < 0 || swapPosition >= pending.length) return false
  const firstIndex = queue.findIndex((task) => task.id === pending[position].id)
  const secondIndex = queue.findIndex((task) => task.id === pending[swapPosition].id)
  ;[queue[firstIndex], queue[secondIndex]] = [queue[secondIndex], queue[firstIndex]]
  await saveQueue(currentProjectPath)
  return true
}

/**
 * Cancel a pending or processing task.
 * If processing, aborts the LLM call and cleans up generated files.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  const wasProcessing = task.status === "processing"
  if (wasProcessing) {
    cancelledInFlightTaskIds.add(task.id)
    // Abort the in-progress LLM call
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }

    // Clean up any files written by the interrupted ingest
    if (lastWrittenFiles.length > 0) {
      await cleanupWrittenFiles(currentProjectPath, lastWrittenFiles)
      console.log(`[Ingest Queue] Cleaned up ${lastWrittenFiles.length} files from cancelled task`)
      lastWrittenFiles = []
    }

  }

  restoredPausedTaskIds.delete(taskId)
  task.status = "cancelled"
  task.error = null
  if (!queue.some((t) => t.status === "pending" || t.status === "processing")) {
    paused = false
    clearUsageLimitAutoResume()
  }
  await saveQueue(currentProjectPath)
  console.log(`[Ingest Queue] Cancelled and retained for restart: ${task.sourcePath}`)

  // The in-flight run owns `processing` until it observes cancellation.
  // Starting another task here would let the old abort handler race it.
  if (!wasProcessing) processNext(currentProjectId)
}

/** Cancel selected pending/processing tasks while retaining them for restart. */
export async function cancelTasks(taskIds: readonly string[]): Promise<number> {
  const selected = new Set(taskIds)
  const targets = queue.filter(
    (task) =>
      task.projectId === currentProjectId &&
      selected.has(task.id) &&
      (task.status === "pending" || task.status === "processing"),
  )
  if (targets.length === 0) return 0
  const hadProcessingTask = targets.some((task) => task.status === "processing")
  for (const task of targets) {
    if (task.status === "processing") cancelledInFlightTaskIds.add(task.id)
  }
  if (hadProcessingTask && currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  if (hadProcessingTask && lastWrittenFiles.length > 0) {
    await cleanupWrittenFiles(currentProjectPath, lastWrittenFiles)
    lastWrittenFiles = []
  }
  for (const task of targets) {
    restoredPausedTaskIds.delete(task.id)
    task.status = "cancelled"
    task.error = null
  }
  if (!queue.some((task) => task.status === "pending" || task.status === "processing")) {
    paused = false
    clearUsageLimitAutoResume()
  }
  await saveQueue(currentProjectPath)
  if (!hadProcessingTask) processNext(currentProjectId)
  return targets.length
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
 * aborts the running task (if any), cleans up its partial output, and
 * retains every pending + processing item as cancelled so it can be restarted.
 *
 * Failed tasks are retained so the user can still see / retry them.
 * Returns the number of tasks removed from the queue.
 */
export async function cancelAllTasks(): Promise<number> {
  const hadProcessingTask = queue.some(
    (task) => task.projectId === currentProjectId && task.status === "processing",
  )
  for (const task of queue) {
    if (task.projectId === currentProjectId && task.status === "processing") {
      cancelledInFlightTaskIds.add(task.id)
    }
  }
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }

  if (lastWrittenFiles.length > 0) {
    await cleanupWrittenFiles(currentProjectPath, lastWrittenFiles)
    lastWrittenFiles = []
  }

  let cancelled = 0
  for (const task of queue) {
    if (task.status !== "pending" && task.status !== "processing") continue
    restoredPausedTaskIds.delete(task.id)
    task.status = "cancelled"
    task.error = null
    cancelled += 1
  }
  paused = false
  clearUsageLimitAutoResume()
  if (!hadProcessingTask) processing = false

  await saveQueue(currentProjectPath)
  console.log(`[Ingest Queue] Cancelled all and retained: ${cancelled} tasks`)
  if (!hadProcessingTask) processNext(currentProjectId)
  return cancelled
}

/**
 * Pause queue processing. The currently-running task (if any) is aborted
 * and returned to pending; no pending tasks are handed to the LLM until
 * resumeProcessing() is called. Use this to stop token spend without
 * losing the queue or cancelling work.
 *
 * In-memory only: a paused queue auto-resumes on app restart / project
 * switch (pending tasks are picked up by restoreQueue).
 */
export function pauseProcessing(): void {
  clearUsageLimitAutoResume()
  paused = true
  const processingTask = queue.find(
    (t) => t.projectId === currentProjectId && t.status === "processing",
  )
  if (processingTask) {
    processingTask.status = "pending"
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
    saveQueue(currentProjectPath).catch((err) => {
      console.warn("[Ingest Queue] Failed to persist paused queue:", err)
    })
  }
  console.log("[Ingest Queue] Paused — in-flight task aborted; no new tasks will start")
}

/**
 * Resume queue processing after pauseProcessing(). Kicks processNext so
 * pending tasks start immediately. A no-op if a task is already running
 * (the existing `if (processing) return` guard handles that).
 */
export function resumeProcessing(): void {
  clearUsageLimitAutoResume()
  paused = false
  restoredPausedTaskIds.clear()
  console.log("[Ingest Queue] Resumed")
  if (currentProjectId) processNext(currentProjectId)
}

/** Whether queue processing is currently paused by the user. */
export function isQueuePaused(): boolean {
  return paused || queue.some((t) => t.status === "pending" && restoredPausedTaskIds.has(t.id))
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
export function getQueueSummary(): {
  pending: number
  processing: number
  failed: number
  cancelled: number
  completed: number
  total: number
  paused: boolean
  userPaused: boolean
  restoredBacklogWaiting: boolean
} {
  const pending = queue.filter((t) => t.status === "pending").length
  const processingCount = queue.filter((t) => t.status === "processing").length
  const failed = queue.filter((t) => t.status === "failed").length
  const cancelled = queue.filter((t) => t.status === "cancelled").length
  const activeTotal = queue.length + completedSinceIdle
  const restoredBacklogWaiting = queue.some((t) =>
    t.status === "pending" && restoredPausedTaskIds.has(t.id)
  )
  return {
    pending,
    processing: processingCount,
    failed,
    cancelled,
    completed: completedSinceIdle,
    total: activeTotal,
    paused: paused || (restoredBacklogWaiting && processingCount === 0),
    userPaused: paused,
    restoredBacklogWaiting,
  }
}

/**
 * Clear all in-memory queue state without touching disk. Used by tests
 * that want a clean slate between cases. **Production code should use
 * `pauseQueue()` on project switch**, which flushes pending state to
 * disk before clearing memory.
 */
export function clearQueueState(): void {
  clearUsageLimitAutoResume()
  if (currentAbortController) {
    currentAbortController.abort()
  }
  if (sweepAbortController) {
    sweepAbortController.abort()
  }
  queue = []
  restoredPausedTaskIds.clear()
  cancelledInFlightTaskIds.clear()
  processing = false
  paused = false
  currentProjectId = ""
  currentProjectPath = ""
  currentAbortController = null
  sweepAbortController = null
  lastWrittenFiles = []
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
  clearUsageLimitAutoResume()
  if (!currentProjectId || !currentProjectPath) {
    // Nothing to pause (no active project)
    return
  }

  const pausedProjectPath = currentProjectPath

  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  if (sweepAbortController) {
    sweepAbortController.abort()
    sweepAbortController = null
  }
  processing = false

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
  restoredPausedTaskIds.clear()
  cancelledInFlightTaskIds.clear()
  currentProjectId = ""
  currentProjectPath = ""
  lastWrittenFiles = []
  processedSinceDrain = false
  resetQueueAccounting()
}

// ── Restore on startup ───────────────────────────────────────────────────

/**
 * Load queue from disk. Called on app startup and when opening / switching
 * to a project. Restored pending tasks are hydrated but not auto-run; the
 * user can resume them from the Activity panel. New live enqueues still run.
 * `pauseQueue()` must have been called first (or the active project already
 * cleared) so that in-memory state is not contaminated from the previous
 * project.
 */
export async function restoreQueue(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  // Defensive: reset in-memory state (should already be empty via
  // pauseQueue, but clearing again costs nothing).
  queue = []
  restoredPausedTaskIds.clear()
  cancelledInFlightTaskIds.clear()
  processing = false
  clearUsageLimitAutoResume()
  // Every project loads un-paused. Pause is a current-session control;
  // it does not carry across project switches or app restarts.
  paused = false
  currentAbortController = null
  lastWrittenFiles = []
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
  restoredPausedTaskIds = new Set(
    queue
      .filter((t) => t.status === "pending")
      .map((t) => t.id),
  )
  await saveQueue(pp)

  const pending = queue.filter((t) => t.status === "pending").length
  const failed = queue.filter((t) => t.status === "failed").length

  if (pending > 0 || restored > 0) {
    console.log(`[Ingest Queue] Restored: ${pending} pending paused for manual resume, ${failed} failed, ${restored} reset from interrupted`)
    processNext(projectId)
  }
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3
const USAGE_LIMIT_AUTO_RESUME_MS = 15 * 60 * 1000
let usageLimitResumeTimer: ReturnType<typeof setTimeout> | null = null

function clearUsageLimitAutoResume(): void {
  if (usageLimitResumeTimer) {
    clearTimeout(usageLimitResumeTimer)
    usageLimitResumeTimer = null
  }
}

function isUsageLimitError(message: string): boolean {
  return /\b429\b|rate[_\s-]*limit|usage\s+limit|quota|too many requests/i.test(message)
}

function scheduleUsageLimitAutoResume(projectId: string): void {
  if (usageLimitResumeTimer) return
  usageLimitResumeTimer = setTimeout(() => {
    usageLimitResumeTimer = null
    if (currentProjectId !== projectId) return
    paused = false
    console.log("[Ingest Queue] Auto-resuming after provider usage limit pause")
    processNext(projectId)
  }, USAGE_LIMIT_AUTO_RESUME_MS)
}

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
  if (processing) return
  // Stale-context guard: processNext may be invoked by an orphaned
  // recursion from a previous project. If we're no longer active, bail.
  if (currentProjectId !== projectId) return
  // User pause: don't hand the next pending task to the LLM. Also
  // skips the drain-sweep below — intended, since that's an LLM call.
  if (paused) {
    const hasPending = queue.some((t) => t.projectId === projectId && t.status === "pending")
    if (hasPending) return
    // Pause applies to the current queue, not to future imports forever.
    // If the in-flight task completed despite the abort and nothing is left,
    // clear it so a later explicit import can run normally.
    paused = false
    return
  }

  const next = queue.find((t) =>
    t.projectId === projectId &&
    t.status === "pending" &&
    !restoredPausedTaskIds.has(t.id)
  )
  if (!next) {
    const hasRestoredPending = queue.some((t) =>
      t.projectId === projectId &&
      t.status === "pending" &&
      restoredPausedTaskIds.has(t.id)
    )
    if (hasRestoredPending) return
    // Queue drained — trigger review cleanup (auto-resolve stale items)
    const pathAtDrain = currentProjectPath
    onQueueDrained(projectId, pathAtDrain).catch((err) =>
      console.error("[Ingest Queue] sweep failed:", err)
    )
    return
  }

  // Look up the project's current filesystem path from the registry —
  // it may have moved since the task was enqueued. If the project isn't
  // in the registry (was deleted or never registered), mark as failed.
  const registryPath = await getProjectPathById(projectId)
  const pp = registryPath ? normalizePath(registryPath) : ""

  // Check we're still active after the registry await.
  if (currentProjectId !== projectId) return

  if (!pp) {
    next.status = "failed"
    next.error = "Project not found in registry (was it deleted?)"
    await saveQueue(currentProjectPath)
    processNext(projectId)
    return
  }

  processing = true
  restoredPausedTaskIds.delete(next.id)
  next.status = "processing"
  await saveQueue(pp)
  if (currentProjectId !== projectId) return

  const llmConfig = getTaskLlmConfig("ingest")

  // Check if LLM is configured
  if (!hasUsableLlm(llmConfig)) {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    processing = false
    await saveQueue(pp)
    processNext(projectId)
    return
  }

  const fullSourcePath = isAbsolutePath(next.sourcePath)
    ? normalizePath(next.sourcePath)
    : `${pp}/${next.sourcePath}`

  console.log(`[Ingest Queue] Processing: ${next.sourcePath} (${queue.filter((t) => t.projectId === projectId && t.status === "pending").length} remaining)`)

  currentAbortController = new AbortController()
  lastWrittenFiles = []
  const trackWrittenFile = (relativePath: string): void => {
    if (!lastWrittenFiles.includes(relativePath)) {
      lastWrittenFiles.push(relativePath)
    }
  }

  try {
    const writtenFiles = await autoIngest(
      pp,
      fullSourcePath,
      llmConfig,
      currentAbortController.signal,
      next.folderContext,
      trackWrittenFile,
    )
    // Stale-context guard: project switched during the long LLM call.
    // Bail without mutating queue or writing to disk — pauseQueue has
    // already persisted the correct state to the old project's file,
    // and the new project's queue must not be touched by this orphan.
    if (currentProjectId !== projectId) return
    lastWrittenFiles = writtenFiles

    const currentTask = queue.find((task) => task.id === next.id)
    if (cancelledInFlightTaskIds.delete(next.id) || currentTask?.status === "cancelled") {
      if (lastWrittenFiles.length > 0) {
        await cleanupWrittenFiles(pp, lastWrittenFiles)
        lastWrittenFiles = []
      }
      currentAbortController = null
      processing = false
      await saveQueue(pp)
      processNext(projectId)
      return
    }

    // Safety net: autoIngest resolving with zero files means nothing
    // was really ingested (e.g. abort during webview refresh where the
    // historical `return []` error path masqueraded as success). Treat
    // as failure so the task stays in the queue and retries.
    if (writtenFiles.length === 0) {
      throw new Error("Ingest produced no output files")
    }

    // Success: remove from queue
    currentAbortController = null
    lastWrittenFiles = []
    cancelledInFlightTaskIds.delete(next.id)
    queue = queue.filter((t) => t.id !== next.id)
    completedSinceIdle++
    processedSinceDrain = true
    await saveQueue(pp)

    console.log(`[Ingest Queue] Done: ${next.sourcePath}`)
  } catch (err) {
    if (currentProjectId !== projectId) return
    currentAbortController = null
    const currentTask = queue.find((t) => t.id === next.id)
    if (cancelledInFlightTaskIds.delete(next.id) || currentTask?.status === "cancelled") {
      if (lastWrittenFiles.length > 0) {
        await cleanupWrittenFiles(pp, lastWrittenFiles)
        lastWrittenFiles = []
      }
      processing = false
      await saveQueue(pp)
      processNext(projectId)
      return
    }
    if (currentTask?.status === "pending") {
      if (lastWrittenFiles.length > 0) {
        await cleanupWrittenFiles(pp, lastWrittenFiles)
        lastWrittenFiles = []
      }
      processing = false
      await saveQueue(pp)
      if (!paused) processNext(projectId)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    if (isUsageLimitError(message)) {
      next.status = "pending"
      next.error = `Paused after provider usage limit: ${message}`
      paused = true
      processing = false
      await saveQueue(pp)
      scheduleUsageLimitAutoResume(projectId)
      console.log(
        `[Ingest Queue] Paused after provider usage limit; will retry automatically in ${Math.round(USAGE_LIMIT_AUTO_RESUME_MS / 60000)} minutes: ${message}`,
      )
      return
    }

    next.retryCount++
    next.error = message

    if (next.retryCount >= MAX_RETRIES) {
      next.status = "failed"
      console.log(`[Ingest Queue] Failed (${next.retryCount}x): ${next.sourcePath} — ${message}`)
    } else {
      next.status = "pending" // will retry
      console.log(`[Ingest Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.sourcePath} — ${message}`)
    }

    await saveQueue(pp)
  }

  processing = false
  processNext(projectId)
}
