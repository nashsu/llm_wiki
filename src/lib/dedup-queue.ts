/**
 * Persistent serial queue for duplicate-merge operations.
 *
 * Why a queue (and not just kicking off `executeMerge` from the click
 * handler):
 *   - Merges rewrite cross-references across the entire wiki. Two
 *     concurrent merges race on the same files, last write wins, and
 *     half the rewrites silently disappear.
 *   - LLM calls take seconds; the user wants to queue several merges
 *     and walk away. The queue must survive app close so an
 *     interrupted merge resumes on next launch.
 *
 * Mirrors `ingest-queue.ts` almost line-for-line: same lifecycle
 * (pause / restore on project switch), same persistence file shape,
 * same retry-up-to-3 policy, same registry-based path resolution so
 * a relocated project still finds its tasks.
 */
import { readFile, writeFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { executeMerge } from "@/lib/dedup-runner"
import type { DuplicateGroup } from "@/lib/dedup"

// ── Types ─────────────────────────────────────────────────────────────────

export interface DedupTask {
  id: string
  projectId: string
  group: DuplicateGroup
  canonicalSlug: string
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────

let queue: DedupTask[] = []
let processing = false
/** Pending tasks restored from disk on startup/project open. These are
 * intentionally hydrated without auto-running so opening a project does
 * not immediately spend LLM tokens on historical merge work. A fresh
 * enqueue for the same group promotes the restored task out of this set. */
let restoredPausedTaskIds = new Set<string>()
let currentProjectId = ""
let currentProjectPath = ""
let currentAbortController: AbortController | null = null

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/dedup-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  try {
    const toSave = queue.filter((t) => t.status !== "done")
    await writeFile(queueFilePath(projectPath), JSON.stringify(toSave, null, 2))
  } catch {
    // non-critical
  }
}

async function loadQueue(
  projectPath: string,
  projectId: string,
): Promise<DedupTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    const tasks = JSON.parse(raw) as DedupTask[]
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
  return `dedup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Stable key for matching a queued task to a UI card. Order-independent
 * lowercase join — same shape used by dedup-storage's canonical key.
 */
export function groupKey(slugs: readonly string[]): string {
  return [...slugs].map((s) => s.toLowerCase()).sort().join(",")
}

/**
 * Add a merge to the queue. The project MUST be the currently-active
 * project. Returns the new task's id. Idempotent on the same group:
 * if there's already a pending/processing/failed task for the same
 * slug-set, the existing id is returned instead of a duplicate.
 */
export async function enqueueMerge(
  projectId: string,
  group: DuplicateGroup,
  canonicalSlug: string,
): Promise<string> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueMerge: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const key = groupKey(group.slugs)
  const existing = queue.find(
    (t) =>
      t.projectId === projectId &&
      t.status !== "done" &&
      groupKey(t.group.slugs) === key,
  )
  if (existing) {
    restoredPausedTaskIds.delete(existing.id)
    if (existing.status === "failed") {
      existing.status = "pending"
      existing.error = null
      existing.retryCount = 0
    }
    await saveQueue(currentProjectPath)
    processNext(currentProjectId)
    return existing.id
  }

  const task: DedupTask = {
    id: generateId(),
    projectId,
    group,
    canonicalSlug,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
  }

  queue.push(task)
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
  return task.id
}

/**
 * Reset a failed task back to pending so it gets another shot. Clears
 * the error and resets retryCount so the user gets the full 3
 * attempts again.
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

/** Resume merge tasks restored from disk during project open. */
export function resumeProcessing(): void {
  restoredPausedTaskIds.clear()
  if (currentProjectId) processNext(currentProjectId)
}

/**
 * Cancel/delete a task. If it's currently running, abort the LLM call
 * first — the merge writes will be left where they were when the
 * abort fired. Backup snapshots already on disk are kept either way.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  if (task.status === "processing") {
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
    processing = false
  }

  restoredPausedTaskIds.delete(taskId)
  queue = queue.filter((t) => t.id !== taskId)
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
}

export function getQueue(): readonly DedupTask[] {
  return queue
}

export function getQueueSummary(): {
  pending: number
  processing: number
  failed: number
  total: number
  restoredBacklogWaiting: boolean
} {
  return {
    pending: queue.filter((t) => t.status === "pending").length,
    processing: queue.filter((t) => t.status === "processing").length,
    failed: queue.filter((t) => t.status === "failed").length,
    total: queue.length,
    restoredBacklogWaiting: queue.some((t) =>
      t.status === "pending" && restoredPausedTaskIds.has(t.id)
    ),
  }
}

/**
 * Test-only: wipe in-memory state without touching disk. Production
 * code should always use `pauseQueue()` so pending state lands in
 * the right project's file before the slate is cleared.
 */
export function clearQueueState(): void {
  if (currentAbortController) {
    currentAbortController.abort()
  }
  queue = []
  restoredPausedTaskIds.clear()
  processing = false
  currentProjectId = ""
  currentProjectPath = ""
  currentAbortController = null
}

/**
 * Project-switch handshake: flush the active project's queue to disk
 * (reverting any in-flight task to pending so it gets re-tried on
 * resume), then clear in-memory state.
 */
export async function pauseQueue(): Promise<void> {
  if (!currentProjectId || !currentProjectPath) return

  const pausedProjectPath = currentProjectPath

  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  processing = false

  for (const task of queue) {
    if (task.status === "processing") {
      task.status = "pending"
    }
  }

  await saveQueue(pausedProjectPath)

  queue = []
  restoredPausedTaskIds.clear()
  currentProjectId = ""
  currentProjectPath = ""
}

/**
 * Load a project's queue from disk. Restored pending tasks are visible
 * but do not auto-run; a fresh enqueue for the same group promotes the
 * existing task, and retryTask can also resume one explicitly.
 */
export async function restoreQueue(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  queue = []
  restoredPausedTaskIds.clear()
  processing = false
  currentAbortController = null
  currentProjectId = projectId
  currentProjectPath = pp

  const saved = await loadQueue(pp, projectId)
  if (saved.length === 0) return

  const mine = saved.filter((t) => t.projectId === projectId)
  if (mine.length !== saved.length) {
    console.warn(
      `[Dedup Queue] Dropped ${saved.length - mine.length} cross-project tasks during restore`,
    )
  }

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
    console.log(
      `[Dedup Queue] Restored: ${pending} pending paused for manual resume, ${failed} failed, ${restored} reset from interrupted`,
    )
  }
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

async function processNext(projectId: string): Promise<void> {
  if (processing) return
  if (currentProjectId !== projectId) return

  const next = queue.find((t) =>
    t.projectId === projectId &&
    t.status === "pending" &&
    !restoredPausedTaskIds.has(t.id)
  )
  if (!next) return

  const registryPath = await getProjectPathById(projectId)
  const pp = registryPath ? normalizePath(registryPath) : ""
  if (currentProjectId !== projectId) return

  if (!pp) {
    next.status = "failed"
    next.error = "Project not found in registry (was it deleted?)"
    await saveQueue(currentProjectPath)
    processNext(projectId)
    return
  }

  processing = true
  next.status = "processing"
  await saveQueue(pp)
  if (currentProjectId !== projectId) return

  const llmConfig = getTaskLlmConfig("ingest")

  if (!hasUsableLlm(llmConfig)) {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    processing = false
    await saveQueue(pp)
    return
  }

  console.log(
    `[Dedup Queue] Processing: merge ${next.group.slugs.join(",")} → ${next.canonicalSlug}`,
  )

  currentAbortController = new AbortController()

  try {
    await executeMerge(pp, next.group, next.canonicalSlug, llmConfig, {
      signal: currentAbortController.signal,
    })
    if (currentProjectId !== projectId) return

    currentAbortController = null
    restoredPausedTaskIds.delete(next.id)
    queue = queue.filter((t) => t.id !== next.id)
    await saveQueue(pp)
    // Tell the rest of the app the wiki tree changed.
    useWikiStore.getState().bumpDataVersion()

    console.log(`[Dedup Queue] Done: ${next.group.slugs.join(",")}`)
  } catch (err) {
    if (currentProjectId !== projectId) return
    currentAbortController = null
    const message = err instanceof Error ? err.message : String(err)
    next.retryCount++
    next.error = message

    if (next.retryCount >= MAX_RETRIES) {
      next.status = "failed"
      console.log(
        `[Dedup Queue] Failed (${next.retryCount}x): ${next.group.slugs.join(",")} — ${message}`,
      )
    } else {
      next.status = "pending"
      console.log(
        `[Dedup Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.group.slugs.join(",")} — ${message}`,
      )
    }
    await saveQueue(pp)
  }

  processing = false
  processNext(projectId)
}
