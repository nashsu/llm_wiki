import { getDb } from "./db.js"

// Ingest queue store — manages the ingest_queue table (Phase 2.3.8, lifecycle
// ops added for the server-driven ingest orchestrator, issue #14 P0).
//
// Status vocabulary: pending | processing | completed | failed.
// Invariants enforced here (pinned by ingest-queue-store.test.js):
//  • FIFO claim by id ASC among eligible rows (not_before <= now)
//  • per-project serialization: a claim is refused while ANY row of the same
//    project is 'processing' (analysis reads wiki/index.md, generation
//    overwrites it — concurrent ingests of one project corrupt it)
//  • attempt_count increments on every claim; retry cap enforcement is the
//    orchestrator's job (it reads attempt_count), the store only records it
//  • crash recovery: processing → pending at boot, preserving attempt_count

export function enqueueIngestTask(projectId, filePath, { folderContext = "" } = {}) {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO ingest_queue (project_id, file_path, status, progress, created_at, folder_context, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?, ?)
  `)
  const info = stmt.run(projectId, filePath, Date.now(), folderContext, Date.now())
  return info.lastInsertRowid
}

export function getIngestTask(taskId) {
  const db = getDb()
  return db.prepare("SELECT * FROM ingest_queue WHERE id = ?").get(taskId)
}

export function listIngestTasks(projectId, { status, limit = 50 } = {}) {
  const db = getDb()
  let sql = "SELECT * FROM ingest_queue WHERE project_id = ?"
  const params = [projectId]
  if (status) {
    sql += " AND status = ?"
    params.push(status)
  }
  sql += " ORDER BY created_at DESC LIMIT ?"
  params.push(limit)
  return db.prepare(sql).all(...params)
}

export function updateIngestTask(taskId, { status, progress, error }) {
  const db = getDb()
  const updates = []
  const params = []
  if (status !== undefined) {
    updates.push("status = ?")
    params.push(status)
  }
  if (progress !== undefined) {
    updates.push("progress = ?")
    params.push(progress)
  }
  if (error !== undefined) {
    updates.push("error = ?")
    params.push(error)
  }
  if (updates.length === 0) return
  params.push(taskId)
  db.prepare(`UPDATE ingest_queue SET ${updates.join(", ")} WHERE id = ?`).run(...params)
}

export function deleteIngestTask(taskId) {
  const db = getDb()
  const info = db.prepare("DELETE FROM ingest_queue WHERE id = ?").run(taskId)
  return info.changes > 0
}

export function clearIngestTasks(projectId, { status } = {}) {
  const db = getDb()
  let sql = "DELETE FROM ingest_queue WHERE project_id = ?"
  const params = [projectId]
  if (status) {
    sql += " AND status = ?"
    params.push(status)
  }
  const info = db.prepare(sql).run(...params)
  return info.changes
}

// ── orchestrator lifecycle ops ─────────────────────────────────────────────

/**
 * Atomically claim the next eligible task for processing.
 *
 * Eligible = status 'pending', not_before <= now, AND no other row of the
 * same project is currently 'processing' (per-project serialization). FIFO
 * by id. Returns the claimed row (re-read inside the tx) or null.
 */
export function claimNextIngestTask(now = Date.now()) {
  const db = getDb()
  const claim = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM ingest_queue q
      WHERE q.status = 'pending' AND q.not_before <= ?
        AND NOT EXISTS (
          SELECT 1 FROM ingest_queue p
          WHERE p.project_id = q.project_id AND p.status = 'processing'
        )
      ORDER BY q.id ASC
      LIMIT 1
    `).get(now)
    if (!row) return null
    db.prepare(`
      UPDATE ingest_queue
      SET status = 'processing', attempt_count = attempt_count + 1,
          started_at = ?, updated_at = ?, progress = 0
      WHERE id = ? AND status = 'pending'
    `).run(now, now, row.id)
    return db.prepare("SELECT * FROM ingest_queue WHERE id = ?").get(row.id)
  })
  return claim()
}

/** Mark a task completed (progress 100, error cleared). */
export function completeIngestTask(taskId) {
  const db = getDb()
  db.prepare(`
    UPDATE ingest_queue
    SET status = 'completed', progress = 100, error = NULL, updated_at = ?
    WHERE id = ?
  `).run(Date.now(), taskId)
}

/**
 * Record a failure.
 *  • retryable=true  → back to 'pending' (optionally deferred via notBefore,
 *    used for usage-limit backoff); error keeps the last message.
 *  • retryable=false → terminal 'failed' with the error surfaced.
 */
export function failIngestTask(taskId, error, { retryable = false, notBefore = 0 } = {}) {
  const db = getDb()
  if (retryable) {
    db.prepare(`
      UPDATE ingest_queue
      SET status = 'pending', error = ?, not_before = ?, updated_at = ?
      WHERE id = ?
    `).run(error ?? null, notBefore, Date.now(), taskId)
  } else {
    db.prepare(`
      UPDATE ingest_queue
      SET status = 'failed', error = ?, updated_at = ?
      WHERE id = ?
    `).run(error ?? null, Date.now(), taskId)
  }
}

/** Manual retry of a failed task: resets attempts + error, back to pending. */
export function retryIngestTask(taskId) {
  const db = getDb()
  const info = db.prepare(`
    UPDATE ingest_queue
    SET status = 'pending', attempt_count = 0, error = NULL, not_before = 0,
        progress = 0, updated_at = ?
    WHERE id = ? AND status = 'failed'
  `).run(Date.now(), taskId)
  return info.changes > 0
}

/**
 * Crash recovery at server boot: every 'processing' row was interrupted.
 * Rows under the attempt cap go back to 'pending' (attempt_count preserved so
 * the cap still bites); rows already at/over maxAttempts become 'failed' with
 * a surfaced error instead of silently re-running a fourth time.
 * Returns { reset, failed } counts.
 */
export function resetInterruptedTasks(maxAttempts = 3) {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    const failed = db.prepare(`
      UPDATE ingest_queue
      SET status = 'failed',
          error = 'Server restarted during processing; retry limit reached',
          updated_at = ?
      WHERE status = 'processing' AND attempt_count >= ?
    `).run(now, maxAttempts).changes
    const reset = db.prepare(`
      UPDATE ingest_queue
      SET status = 'pending', updated_at = ?
      WHERE status = 'processing'
    `).run(now).changes
    return { reset, failed }
  })
  return tx()
}

/** Persist stage progress (0-100) without touching status. */
export function touchIngestTask(taskId, progress) {
  const db = getDb()
  db.prepare(`
    UPDATE ingest_queue SET progress = ?, updated_at = ? WHERE id = ?
  `).run(progress, Date.now(), taskId)
}

/**
 * Find an unfinished (pending/processing) task for the same project + file
 * path — used by enqueue-by-path to dedupe against a live task.
 */
export function findLiveIngestTask(projectId, filePath) {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM ingest_queue
    WHERE project_id = ? AND file_path = ? AND status IN ('pending', 'processing')
    ORDER BY id ASC LIMIT 1
  `).get(projectId, filePath)
}
