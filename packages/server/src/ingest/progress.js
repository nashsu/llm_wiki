// Pipeline progress reporting (issue #14 P0).
//
// The orchestrator's tasks are SQLite rows; live progress is (a) persisted
// via touchIngestTask so a client attaching mid-ingest can poll current state,
// and (b) broadcast as ingest:progress SSE frames (legacy emit() — the plan's
// SSE contract; payload always carries projectId, taskId is the correlation
// key). Stage names + percents are FIXED here and pinned by tests: the client
// renders stage labels verbatim and shows the percent bar from these values.

import { touchIngestTask } from "../store/ingest-queue.js"
import { emit } from "../events.js"

// Ordered execution stages of runIngestPipeline (pipeline.js), mapped to a
// monotonically increasing percent. The order mirrors the desktop autoIngest
// flow: preprocess → MinerU → context reads → cache check → image extraction
// → captioning → analysis → generation → optional review stage → writes →
// index/log → review parsing → cache save → embeddings.
export const INGEST_STAGES = [
  ["preprocess", 5],
  ["mineru", 15],
  ["context", 20],
  ["cache-check", 25],
  ["images", 30],
  ["caption", 40],
  ["analysis", 55],
  ["generation", 75],
  ["review-stage", 80],
  ["write", 85],
  ["index-log", 90],
  ["reviews", 92],
  ["cache-save", 95],
  ["embed", 98],
]

const STAGE_PERCENT = new Map(INGEST_STAGES)

/** Percent for a stage name (0 for unknown stages — never throws). */
export function stagePercent(stage) {
  return STAGE_PERCENT.get(stage) ?? 0
}

/**
 * Persist + broadcast progress for a claimed task row.
 * `task` is the ingest_queue row (id, project_id, attempt_count, …).
 */
export function reportIngestProgress(task, { stage, detail = "" }) {
  const progress = stagePercent(stage)
  try {
    touchIngestTask(task.id, progress)
  } catch {
    // DB hiccup must not kill the pipeline; the SSE frame still goes out.
  }
  emit("ingest:progress", {
    projectId: task.project_id,
    taskId: task.id,
    status: "processing",
    progress,
    stage,
    detail,
    attempt: task.attempt_count ?? 0,
  })
}

/** Terminal success frame (orchestrator calls after completeIngestTask). */
export function emitIngestComplete(task, { pagesCreated = [], reviewCount = 0, warnings = [], durationMs = 0 }) {
  emit("ingest:complete", {
    projectId: task.project_id,
    taskId: task.id,
    status: "completed",
    progress: 100,
    pagesCreated,
    reviewCount,
    warnings,
    durationMs,
  })
}

/**
 * Failure frame. `retryable` failures put the row back to pending (status
 * "pending" + retryAt), terminal ones surface as "failed" — matching the
 * plan's SSE contract so the client can render retry affordances correctly.
 */
export function emitIngestError(task, { error, retryable = false, maxAttempts = 3, retryAt = null }) {
  emit("ingest:error", {
    projectId: task.project_id,
    taskId: task.id,
    status: retryable ? "pending" : "failed",
    error: error ?? "Unknown error",
    retryable,
    attempt: task.attempt_count ?? 0,
    maxAttempts,
    retryAt,
  })
}
