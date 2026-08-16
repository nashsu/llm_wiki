import { readFile, writeFile } from "@/commands/fs"
import { autoIngest } from "./ingest"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { IngestCommitCoordinator } from "@/lib/ingest-commit-coordinator"

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
  /** Background scheduled imports start when their project is next opened. */
  autoStart?: boolean
}

// ── State ─────────────────────────────────────────────────────────────────

let queue: IngestTask[] = []
interface ActiveIngestRun {
  taskId: string
  epoch: number
  controller: AbortController
  writtenFiles: string[]
  releaseCommitTurn: () => void
  commitActive: boolean
  completion: Promise<void>
}

const activeRuns = new Map<string, ActiveIngestRun>()
let commitCoordinator = new IngestCommitCoordinator()
let workerLimit = 1
let scheduling = false
let queueEpoch = 0
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
let inactiveQueueWrite: Promise<void> = Promise.resolve()
interface QueueWriteRequest {
  path: string
  snapshot: string
  resolve: () => void
}
const pendingActiveQueueWrites: QueueWriteRequest[] = []
let activeQueueWriteRunning = false
let activeQueueWriteEpoch = 0

function resetQueueAccounting(): void {
  completedSinceIdle = 0
}

export function setIngestWorkerLimit(limit: number): void {
  workerLimit = Math.max(1, Math.min(5, Math.floor(limit) || 1))
  if (currentProjectId && !paused) processNext(currentProjectId)
}

export function getIngestWorkerLimit(): number {
  return workerLimit
}

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  // Capture the snapshot now, then serialize writes so an older async write
  // can never land after a newer queue state.
  const toSave = queue.filter((t) => t.status !== "done")
  const snapshot = JSON.stringify(toSave, null, 2)
  await new Promise<void>((resolve) => {
    pendingActiveQueueWrites.push({
      path: queueFilePath(projectPath),
      snapshot,
      resolve,
    })
    void drainActiveQueueWrites()
  })
}

async function drainActiveQueueWrites(): Promise<void> {
  if (activeQueueWriteRunning) return
  const request = pendingActiveQueueWrites.shift()
  if (!request) return
  const epoch = activeQueueWriteEpoch
  activeQueueWriteRunning = true
  try {
    await writeFile(request.path, request.snapshot)
  } catch {
    // Queue persistence is best-effort; the in-memory queue remains authoritative.
  } finally {
    request.resolve()
    if (epoch === activeQueueWriteEpoch) {
      activeQueueWriteRunning = false
      void drainActiveQueueWrites()
    }
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
  if (queue.length === 0 && activeRuns.size === 0) {
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
 * Explicitly delete wiki files and their matching LanceDB chunks.
 *
 * Cancellation deliberately does not call this helper: written paths may be
 * pre-existing pages merged in place, and deleting them without snapshots
 * would destroy user data.
 *
 * Per-file errors are swallowed (best-effort cleanup) — a missing
 * file or LanceDB unavailable shouldn't abort the caller's cleanup flow.
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
 * Persist ingest work for a project that is not currently open. No model work
 * starts here; restoreQueue starts these marked tasks when the project is next
 * opened. This keeps background folder monitoring project-isolated.
 */
export async function enqueueInactiveProjectBatch(
  projectId: string,
  projectPath: string,
  files: Array<{ sourcePath: string; folderContext: string }>,
): Promise<string[]> {
  if (currentProjectId === projectId) {
    return enqueueBatch(projectId, files)
  }

  const pp = normalizePath(projectPath)
  const ids: string[] = []
  let written = false
  const operation = inactiveQueueWrite.then(async () => {
    // restoreQueue sets currentProjectId before waiting for this write. If the
    // user opened this project meanwhile, leave queuing to the active scanner
    // instead of racing its in-memory queue with a stale disk snapshot.
    if (currentProjectId === projectId) return
    const persisted = await loadQueue(pp, projectId)
    if (currentProjectId === projectId) return
    for (const file of files) {
      const normalizedSourcePath = normalizePath(file.sourcePath)
      const sourcePath = normalizedSourcePath.startsWith(`${pp}/`)
        ? normalizedSourcePath.slice(pp.length + 1)
        : normalizedSourcePath
      const existing = persisted.find((task) =>
        task.projectId === projectId &&
        task.status !== "done" &&
        normalizePath(task.sourcePath) === sourcePath
      )
      if (existing) {
        existing.status = "pending"
        existing.error = null
        existing.retryCount = 0
        existing.folderContext = file.folderContext || existing.folderContext
        existing.autoStart = true
        ids.push(existing.id)
        continue
      }
      const task: IngestTask = {
        id: generateId(),
        projectId,
        sourcePath,
        folderContext: file.folderContext,
        status: "pending",
        addedAt: Date.now(),
        error: null,
        retryCount: 0,
        autoStart: true,
      }
      persisted.push(task)
      ids.push(task.id)
    }
    await writeFile(queueFilePath(pp), JSON.stringify(persisted, null, 2))
    written = true
  })
  // Keep the serialization chain usable after an I/O failure while still
  // returning the failure to this caller.
  inactiveQueueWrite = operation.catch((err) => {
    console.warn("[Ingest Queue] Failed to persist inactive-project tasks:", err)
  })
  await operation
  return written ? ids : []
}

/**
 * Retry a failed or cancelled task. Only valid for stopped tasks in the
 * active project's queue.
 */
export async function retryTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return
  if (task.status !== "failed" && task.status !== "cancelled") return

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
 * Cancel a pending or processing task. Processing work is aborted, while any
 * completed atomic page writes are preserved because they may be merges into
 * pre-existing user content.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  const wasProcessing = task.status === "processing"
  if (wasProcessing) {
    cancelledInFlightTaskIds.add(task.id)
    const run = activeRuns.get(task.id)
    run?.controller.abort()
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

  // The in-flight run owns its worker slot until it observes cancellation.
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
  for (const task of targets) {
    const run = activeRuns.get(task.id)
    run?.controller.abort()
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
 * Permanently discard active-project tasks for sources that no longer exist.
 * Unlike cancelTasks, this does not retain restartable queue entries because
 * scheduled-import reconciliation has already established that the mirrored
 * source must be removed.
 */
export async function discardTasksForSources(
  sourcePaths: readonly string[],
): Promise<number> {
  const targets = queue.filter(
    (task) =>
      task.projectId === currentProjectId &&
      sourcePaths.some((sourcePath) => {
        const source = normalizeSourcePathForQueue(sourcePath)
        const queued = normalizeSourcePathForQueue(task.sourcePath)
        return (
          source === queued ||
          (isAbsolutePath(source) && !isAbsolutePath(queued) && source.endsWith(`/${queued}`)) ||
          (isAbsolutePath(queued) && !isAbsolutePath(source) && queued.endsWith(`/${source}`))
        )
      }),
  )
  if (targets.length === 0) return 0

  const targetIds = new Set(targets.map((task) => task.id))
  const hadProcessingTask = targets.some((task) => task.status === "processing")
  for (const task of targets) {
    restoredPausedTaskIds.delete(task.id)
    if (task.status === "processing") cancelledInFlightTaskIds.add(task.id)
  }
  for (const task of targets) {
    const run = activeRuns.get(task.id)
    run?.controller.abort()
  }

  queue = queue.filter((task) => !targetIds.has(task.id))
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
 * aborts running tasks and retains every pending + processing item as
 * cancelled so it can be restarted.
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
  for (const run of activeRuns.values()) {
    run.controller.abort()
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
  const processingTasks = queue.filter(
    (task) => task.projectId === currentProjectId && task.status === "processing",
  )
  if (processingTasks.length > 0) {
    for (const task of processingTasks) {
      task.status = "pending"
      activeRuns.get(task.id)?.controller.abort()
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
 * Existing active workers keep their slots until they observe cancellation.
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
  queueEpoch += 1
  clearUsageLimitAutoResume()
  for (const run of activeRuns.values()) {
    run.controller.abort()
    run.releaseCommitTurn()
  }
  if (sweepAbortController) {
    sweepAbortController.abort()
  }
  queue = []
  restoredPausedTaskIds.clear()
  cancelledInFlightTaskIds.clear()
  activeRuns.clear()
  scheduling = false
  paused = false
  currentProjectId = ""
  currentProjectPath = ""
  sweepAbortController = null
  processedSinceDrain = false
  resetQueueAccounting()
  activeQueueWriteEpoch += 1
  activeQueueWriteRunning = false
  for (const request of pendingActiveQueueWrites.splice(0)) request.resolve()
  commitCoordinator = new IngestCommitCoordinator()
  workerLimit = 1
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
  queueEpoch += 1

  const runs = [...activeRuns.values()]
  for (const run of runs) {
    run.controller.abort()
    run.releaseCommitTurn()
  }
  if (sweepAbortController) {
    sweepAbortController.abort()
    sweepAbortController = null
  }
  scheduling = false

  // Preparation is safe to abandon after abort, but a commit may already be
  // inside a filesystem operation that cannot observe AbortSignal. Wait only
  // for those active commits before declaring the project switch complete.
  const committingRuns = runs.filter((run) => run.commitActive)
  if (committingRuns.length > 0) {
    await Promise.allSettled(committingRuns.map((run) => run.completion))
  }
  activeRuns.clear()

  // Revert any in-flight processing task back to pending so when the
  // user returns to this project, the task is re-tried from scratch.
  for (const task of queue) {
    if (task.status === "processing") {
      task.status = "pending"
    }
  }

  // Flush the paused state to THIS project's disk before wiping memory.
  await saveQueue(pausedProjectPath)
  // A scheduler that passed its registry guard just before the epoch changed
  // may have persisted one final processing snapshot. Normalize once more
  // after the write queue drains so the durable state is always restartable.
  for (const task of queue) {
    if (task.status === "processing") task.status = "pending"
  }
  await saveQueue(pausedProjectPath)

  queue = []
  restoredPausedTaskIds.clear()
  cancelledInFlightTaskIds.clear()
  currentProjectId = ""
  currentProjectPath = ""
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
  queueEpoch += 1
  const pp = normalizePath(projectPath)
  // Defensive: reset in-memory state (should already be empty via
  // pauseQueue, but clearing again costs nothing).
  queue = []
  restoredPausedTaskIds.clear()
  cancelledInFlightTaskIds.clear()
  activeRuns.clear()
  scheduling = false
  clearUsageLimitAutoResume()
  // Every project loads un-paused. Pause is a current-session control;
  // it does not carry across project switches or app restarts.
  paused = false
  resetQueueAccounting()
  currentProjectId = projectId
  currentProjectPath = pp

  await inactiveQueueWrite

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
      .filter((t) => t.status === "pending" && !t.autoStart)
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

async function onQueueDrained(projectId: string, projectPath: string, epoch: number): Promise<void> {
  if (!processedSinceDrain) return
  // Stale-context guard — if we switched projects mid-drain, the sweep
  // would burn tokens analyzing the wrong project.
  if (currentProjectId !== projectId || queueEpoch !== epoch) return
  processedSinceDrain = false

  sweepAbortController = new AbortController()
  const signal = sweepAbortController.signal

  try {
    const { sweepResolvedReviews } = await import("@/lib/sweep-reviews")
    if (currentProjectId !== projectId || queueEpoch !== epoch) return
    await sweepResolvedReviews(projectPath, signal)
  } catch (err) {
    console.error("[Ingest Queue] Failed to load sweep-reviews:", err)
  } finally {
    if (sweepAbortController && sweepAbortController.signal === signal) {
      sweepAbortController = null
    }
  }
}

async function runTask(
  projectId: string,
  projectPath: string,
  task: IngestTask,
  run: ActiveIngestRun,
  runCommit: ReturnType<IngestCommitCoordinator["reserve"]>["runCommit"],
): Promise<void> {
  const fullSourcePath = isAbsolutePath(task.sourcePath)
    ? normalizePath(task.sourcePath)
    : `${projectPath}/${task.sourcePath}`
  const trackWrittenFile = (relativePath: string): void => {
    if (!run.writtenFiles.includes(relativePath)) run.writtenFiles.push(relativePath)
  }

  try {
    const writtenFiles = await autoIngest(
      projectPath,
      fullSourcePath,
      getTaskLlmConfig("ingest"),
      run.controller.signal,
      task.folderContext,
      trackWrittenFile,
      { runCommit },
    )
    if (currentProjectId !== projectId || run.epoch !== queueEpoch) return
    run.writtenFiles = writtenFiles

    const currentTask = queue.find((candidate) => candidate.id === task.id)
    if (cancelledInFlightTaskIds.delete(task.id) || currentTask?.status === "cancelled") {
      // Written paths may be pre-existing pages that were merged in place.
      // Without a reliable old-content snapshot, deleting them would be data
      // loss. Keep completed atomic writes and let a retry converge via merge.
      await saveQueue(projectPath)
      return
    }
    if (writtenFiles.length === 0) throw new Error("Ingest produced no output files")

    cancelledInFlightTaskIds.delete(task.id)
    queue = queue.filter((candidate) => candidate.id !== task.id)
    completedSinceIdle++
    processedSinceDrain = true
    await saveQueue(projectPath)
    console.log(`[Ingest Queue] Done: ${task.sourcePath}`)
  } catch (err) {
    if (currentProjectId !== projectId || run.epoch !== queueEpoch) return
    const currentTask = queue.find((candidate) => candidate.id === task.id)
    if (cancelledInFlightTaskIds.delete(task.id) || currentTask?.status === "cancelled") {
      await saveQueue(projectPath)
      return
    }
    if (currentTask?.status === "pending") {
      await saveQueue(projectPath)
      return
    }

    const message = err instanceof Error ? err.message : String(err)
    if (isUsageLimitError(message)) {
      task.status = "pending"
      task.error = `Paused after provider usage limit: ${message}`
      paused = true
      for (const [taskId, activeRun] of activeRuns) {
        if (taskId === task.id) continue
        const sibling = queue.find((candidate) => candidate.id === taskId)
        if (sibling?.projectId !== projectId || sibling.status !== "processing") continue
        sibling.status = "pending"
        sibling.error = `Paused after provider usage limit: ${message}`
        activeRun.controller.abort()
      }
      await saveQueue(projectPath)
      scheduleUsageLimitAutoResume(projectId)
      console.log(
        `[Ingest Queue] Paused after provider usage limit; will retry automatically in ${Math.round(USAGE_LIMIT_AUTO_RESUME_MS / 60000)} minutes: ${message}`,
      )
      return
    }

    task.retryCount++
    task.error = message
    if (task.retryCount >= MAX_RETRIES) {
      task.status = "failed"
      console.log(`[Ingest Queue] Failed (${task.retryCount}x): ${task.sourcePath} — ${message}`)
    } else {
      task.status = "pending"
      console.log(`[Ingest Queue] Error (retry ${task.retryCount}/${MAX_RETRIES}): ${task.sourcePath} — ${message}`)
    }
    await saveQueue(projectPath)
  } finally {
    run.releaseCommitTurn()
    if (activeRuns.get(task.id) === run) activeRuns.delete(task.id)
    if (currentProjectId === projectId && run.epoch === queueEpoch && !paused) processNext(projectId)
  }
}

async function startTask(projectId: string, task: IngestTask): Promise<boolean> {
  const startEpoch = queueEpoch
  const registryPath = await getProjectPathById(projectId)
  const projectPath = registryPath ? normalizePath(registryPath) : ""
  if (currentProjectId !== projectId || queueEpoch !== startEpoch) return false
  if (!projectPath) {
    task.status = "failed"
    task.error = "Project not found in registry (was it deleted?)"
    await saveQueue(currentProjectPath)
    return true
  }

  const llmConfig = getTaskLlmConfig("ingest")
  if (!hasUsableLlm(llmConfig)) {
    task.status = "failed"
    task.error = "LLM not configured — set API key in Settings"
    await saveQueue(projectPath)
    return true
  }

  const reservation = commitCoordinator.reserve()
  const run: ActiveIngestRun = {
    taskId: task.id,
    epoch: startEpoch,
    controller: new AbortController(),
    writtenFiles: [],
    releaseCommitTurn: reservation.release,
    commitActive: false,
    completion: Promise.resolve(),
  }
  restoredPausedTaskIds.delete(task.id)
  task.status = "processing"
  activeRuns.set(task.id, run)
  await saveQueue(projectPath)
  if (currentProjectId !== projectId || run.epoch !== queueEpoch) {
    run.controller.abort()
    reservation.release()
    activeRuns.delete(task.id)
    return false
  }

  console.log(`[Ingest Queue] Processing: ${task.sourcePath} (${queue.filter((candidate) => candidate.projectId === projectId && candidate.status === "pending").length} remaining)`)
  const orderedCommit: typeof reservation.runCommit = (operation) =>
    reservation.runCommit(async () => {
      run.commitActive = true
      try {
        return await operation()
      } finally {
        run.commitActive = false
      }
    })
  run.completion = runTask(projectId, projectPath, task, run, orderedCommit)
  return true
}

async function processNext(projectId: string): Promise<void> {
  if (scheduling || currentProjectId !== projectId) return
  if (paused) return
  const epoch = queueEpoch
  scheduling = true
  try {
    while (activeRuns.size < workerLimit && currentProjectId === projectId && !paused) {
      const next = queue.find((task) =>
        task.projectId === projectId &&
        task.status === "pending" &&
        !activeRuns.has(task.id) &&
        !restoredPausedTaskIds.has(task.id)
      )
      if (!next) break
      await startTask(projectId, next)
    }

    const hasRunnablePending = queue.some((task) =>
      task.projectId === projectId &&
      task.status === "pending" &&
      !activeRuns.has(task.id) &&
      !restoredPausedTaskIds.has(task.id)
    )
    const hasRestoredPending = queue.some((task) =>
      task.projectId === projectId &&
      task.status === "pending" &&
      restoredPausedTaskIds.has(task.id)
    )
    if (activeRuns.size === 0 && !hasRunnablePending && !hasRestoredPending) {
      const pathAtDrain = currentProjectPath
      onQueueDrained(projectId, pathAtDrain, epoch).catch((err) =>
        console.error("[Ingest Queue] sweep failed:", err)
      )
    }
  } finally {
    scheduling = false
    const hasRunnable = queue.some((task) =>
      task.projectId === projectId &&
      task.status === "pending" &&
      !activeRuns.has(task.id) &&
      !restoredPausedTaskIds.has(task.id)
    )
    const hasAnyPending = queue.some((task) =>
      task.projectId === projectId && task.status === "pending"
    )
    const needsDrain = processedSinceDrain && activeRuns.size === 0 && !hasAnyPending
    const hasWorkerCapacity = activeRuns.size < workerLimit
    if (currentProjectId === projectId && !paused && ((hasWorkerCapacity && hasRunnable) || needsDrain)) {
      queueMicrotask(() => void processNext(projectId))
    }
  }
}
