// Ingest queue consumer (orchestrator) — issue #14 P0 server-driven ingest.
//
// Consumes the ingest_queue SQLite table (store/ingest-queue.js) and drives
// runIngestPipeline per claimed row. Desktop parity (src/lib/ingest-queue.ts
// processNext/cancelTask) for the semantics that matter to users:
//
//  • MAX_RETRIES = 3 total attempts: attempt_count increments on every claim;
//    a retryable failure at attempt_count >= 3 becomes a terminal 'failed'
//    with the error surfaced (ingest-queue.ts:808-815).
//  • Provider usage limits do NOT consume an attempt: the claim increment is
//    rolled back and the row pauses for USAGE_LIMIT_BACKOFF_MS (15 min) with
//    "Paused after provider usage limit: <msg>" (ingest-queue.ts:792-806).
//    The 60s sweep timer re-claims it once not_before passes — no external
//    event needed to resume.
//  • LLM not configured → terminal fail with the exact desktop message
//    (ingest-queue.ts:723).
//  • Cancel: abort the in-flight pipeline, delete the row, and clean up the
//    files it already wrote + their vector chunks (port of the desktop's
//    cleanupWrittenFiles; LanceDB cascade → removePageEmbedding per page).
//
// Config is read from the shared store FRESH per attempt (agent.js runLoop
// pattern): settings edits take effect on the next attempt without restart.
//
// The module is import-safe: no timers, no DB access, no side effects at
// import time. Everything starts with startIngestOrchestrator(), called only
// from the index-v2.js boot block — test imports of the app never start it.

import { basename, isAbsolute, join, relative } from "node:path"
import { unlink } from "node:fs/promises"
import { SHARED_STORE_NAME } from "../config.js"
import { readStore } from "../store.js"
import { resolveIngestConfig, hasUsableLlmConfig } from "../llm-resolve.js"
import { getProject } from "../store/projects.js"
import {
  claimNextIngestTask,
  completeIngestTask,
  failIngestTask,
  getIngestTask,
  deleteIngestTask,
  resetInterruptedTasks,
  deferIngestTaskForUsageLimit,
} from "../store/ingest-queue.js"
import { runIngestPipeline } from "./pipeline.js"
import { reportIngestProgress, emitIngestComplete, emitIngestError } from "./progress.js"
import { isUsageLimitError, USAGE_LIMIT_BACKOFF_MS } from "./llm.js"
import { removePageEmbedding } from "./embed.js"
import { emit } from "../events.js"
import { EventTypes } from "../events/bus.js"

/** Total attempts before a retryable failure becomes terminal (desktop MAX_RETRIES). */
export const MAX_ATTEMPTS = 3

/** Sweep period for resuming deferred (not_before) tasks without external events. */
const SWEEP_INTERVAL_MS = 60_000

/** Default concurrency cap; overridden by LLM_WIKI_INGEST_CONCURRENCY (1..16). */
const DEFAULT_CONCURRENCY = 2

/**
 * Runtime-only state (the DB is the source of truth for queue contents):
 * active maps taskId → { controller: AbortController, writtenPaths: string[] }.
 * `kicking` keeps kick() single-threaded so concurrent callers (API routes,
 * sweep timer, processTask finally-chains) never double-run the claim loop —
 * claimNextIngestTask is atomic anyway, this just avoids redundant loops.
 */
let active = new Map()
let kicking = false
let sweepTimer = null
let started = false
let cap = DEFAULT_CONCURRENCY

function resolveCap() {
  const raw = parseInt(process.env.LLM_WIKI_INGEST_CONCURRENCY ?? "", 10)
  if (Number.isNaN(raw)) return DEFAULT_CONCURRENCY
  return Math.max(1, Math.min(16, raw))
}

/**
 * Start the orchestrator (idempotent). Runs boot crash recovery
 * (processing→pending, at-cap rows→failed), starts the unref'd sweep timer,
 * and kicks the claim loop. The concurrency cap is read here (start only).
 */
export function startIngestOrchestrator() {
  if (started) return
  started = true
  cap = resolveCap()
  const { reset, failed } = resetInterruptedTasks(MAX_ATTEMPTS)
  console.log(
    `[ingest-orchestrator] started (concurrency ${cap}); boot recovery: ${reset} reset to pending, ${failed} failed at attempt cap`,
  )
  sweepTimer = setInterval(() => kick(), SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
  kick()
}

/** Stop the sweep timer (test hook; in-flight tasks are left to settle). */
export function stopIngestOrchestrator() {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  started = false
}

/**
 * Claim loop: fill free concurrency slots with eligible rows. processTask is
 * fire-and-forget — it catches everything internally, and its finally-block
 * kick() chains to the next eligible task when a slot frees up.
 */
function kick() {
  if (!started || kicking) return
  kicking = true
  try {
    while (active.size < cap) {
      const row = claimNextIngestTask(Date.now())
      if (!row) break
      void processTask(row)
    }
  } finally {
    kicking = false
  }
}

/** Public kick for API routes (upload/enqueue/retry just changed the queue). */
export function kickIngestOrchestrator() {
  kick()
}

async function processTask(row) {
  const entry = { controller: new AbortController(), writtenPaths: [] }
  active.set(row.id, entry)
  try {
    // Fresh store snapshot per attempt (agent.js pattern): settings may have
    // changed since the task was enqueued.
    const store = readStore(SHARED_STORE_NAME) ?? {}
    const llmConfig = resolveIngestConfig(store)
    if (!hasUsableLlmConfig(llmConfig)) {
      const message = "LLM not configured — set API key in Settings"
      failIngestTask(row.id, message, { retryable: false })
      emitIngestError(row, { error: message, retryable: false, maxAttempts: MAX_ATTEMPTS })
      return
    }
    // Plan §"claude-code/codex-cli providers": fail fast AT CLAIM — the
    // server has no CLI transport for ingest, so these providers would
    // otherwise burn all three attempts failing inside streamChat.
    if (llmConfig.provider === "claude-code" || llmConfig.provider === "codex-cli") {
      const message = "Ingest with this provider requires the desktop CLI"
      failIngestTask(row.id, message, { retryable: false })
      emitIngestError(row, { error: message, retryable: false, maxAttempts: MAX_ATTEMPTS })
      return
    }
    const project = getProject(row.project_id)
    if (!project) {
      // Desktop parity (ingest-queue.ts: project gone from the registry).
      const message = "Project not found in registry (was it deleted?)"
      failIngestTask(row.id, message, { retryable: false })
      emitIngestError(row, { error: message, retryable: false, maxAttempts: MAX_ATTEMPTS })
      return
    }
    const env = {
      projectPath: project.path,
      llmConfig,
      mineruConfig: store.mineruConfig,
      multimodalConfig: store.multimodalConfig,
      embeddingConfig: store.embeddingConfig,
      outputLanguage: store.outputLanguage,
      signal: entry.controller.signal,
      onProgress: (stage, detail) => reportIngestProgress(row, { stage, detail }),
      onFileWritten: (p) => {
        if (!entry.writtenPaths.includes(p)) entry.writtenPaths.push(p)
      },
    }
    const t0 = Date.now()
    const result = await runIngestPipeline(row, env)
    // The row may have been cancelled mid-run: re-read before completing —
    // cancelIngestTask already deleted it and cleaned up written files.
    if (!getIngestTask(row.id)) return
    completeIngestTask(row.id)
    emitIngestComplete(row, {
      pagesCreated: result.writtenPaths,
      reviewCount: result.reviewCount,
      warnings: result.warnings,
      durationMs: result.durationMs ?? (Date.now() - t0),
    })
  } catch (err) {
    const cancelled = err?.message === "Ingest cancelled" && !getIngestTask(row.id)
    if (cancelled) return // cancelIngestTask already deleted + cleaned up
    const message = err instanceof Error ? err.message : String(err)
    const usageLimit = err?.usageLimit === true || isUsageLimitError(message)
    if (usageLimit) {
      // Usage limits are a provider condition, not a task failure: pause with
      // backoff and roll the attempt back (client parity).
      const notBefore = Date.now() + USAGE_LIMIT_BACKOFF_MS
      deferIngestTaskForUsageLimit(row.id, `Paused after provider usage limit: ${message}`, notBefore)
      emitIngestError(row, { error: message, retryable: true, maxAttempts: MAX_ATTEMPTS, retryAt: notBefore })
    } else if (row.attempt_count >= MAX_ATTEMPTS) {
      failIngestTask(row.id, message, { retryable: false })
      emitIngestError(row, { error: message, retryable: false, maxAttempts: MAX_ATTEMPTS })
    } else {
      failIngestTask(row.id, message, { retryable: true })
      emitIngestError(row, { error: message, retryable: true, maxAttempts: MAX_ATTEMPTS })
    }
  } finally {
    active.delete(row.id)
    kick() // chain to the next eligible task
  }
}

/**
 * Desktop parity (ingest-queue.ts isStructuralWikiPath): index/log/overview
 * aggregate ALL pages — they were only UPDATED by the cancelled ingest, so
 * deleting them would destroy pre-existing wiki content.
 */
function isStructuralWikiPath(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/")
  return (
    normalized === "wiki/index.md" ||
    normalized === "wiki/log.md" ||
    normalized === "wiki/overview.md" ||
    normalized.endsWith("/wiki/index.md") ||
    normalized.endsWith("/wiki/log.md") ||
    normalized.endsWith("/wiki/overview.md")
  )
}

/**
 * Best-effort cleanup of files a cancelled task already wrote (port of the
 * desktop cleanupWrittenFiles, ingest-queue.ts:190-213): unlink each file
 * under the project root and drop the matching page's vector chunks
 * (LanceDB cascade → removePageEmbedding; pageId = basename minus ".md",
 * same derivation as the pipeline's embed loop). Structural pages
 * (index/log/overview) are skipped — desktop parity. Per-file errors are
 * swallowed — cleanup must never throw into the cancel flow. Each
 * SUCCESSFUL unlink publishes file:deleted (project-relative path, row's
 * project_id as payload attribution) so sse-sync refreshes trees
 * (plans/sse-taxonomy.md stage 2).
 */
async function cleanupWrittenFiles(projectPath, filePaths, projectId) {
  for (const filePath of filePaths) {
    if (isStructuralWikiPath(filePath)) continue
    const fullPath = isAbsolute(filePath) ? filePath : join(projectPath, filePath)
    let unlinked = false
    try {
      await unlink(fullPath)
      unlinked = true
    } catch {
      // file may not exist anymore — non-critical; no file:deleted frame
      // when nothing was actually removed
    }
    if (unlinked) {
      emit(EventTypes.FILE_DELETED, {
        projectId,
        // Project-relative, forward-slashed (isStructuralWikiPath parity).
        path: relative(projectPath, fullPath).replaceAll("\\", "/"),
      })
    }
    if (fullPath.endsWith(".md")) {
      const pageId = basename(fullPath).replace(/\.md$/, "")
      if (pageId) {
        try {
          await removePageEmbedding(projectPath, pageId)
        } catch {
          // non-critical
        }
      }
    }
  }
}

/**
 * Cancel a task. In-flight: delete the row FIRST (so processTask's catch
 * sees it gone and treats the abort as a cancel), abort the pipeline, clean
 * up written files + embeddings. Pending: just delete the row. Emits a
 * terminal ingest:error frame so live clients update, then kicks.
 * Returns false when the task does not exist.
 */
export async function cancelIngestTask(taskId) {
  const row = getIngestTask(taskId)
  if (!row) return false
  const entry = active.get(taskId)
  if (entry) {
    deleteIngestTask(taskId)
    entry.controller.abort()
    const project = getProject(row.project_id)
    if (project?.path) await cleanupWrittenFiles(project.path, entry.writtenPaths, row.project_id)
  } else {
    deleteIngestTask(taskId)
  }
  emit("ingest:error", {
    projectId: row.project_id,
    taskId,
    status: "failed",
    error: "Cancelled",
    retryable: false,
  })
  kick()
  return true
}

/** Number of tasks currently in flight (test/observability helper). */
export function activeIngestTaskCount() {
  return active.size
}

/** @internal reset all module state between tests. */
export function __resetOrchestratorForTests() {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  started = false
  kicking = false
  active = new Map()
}
