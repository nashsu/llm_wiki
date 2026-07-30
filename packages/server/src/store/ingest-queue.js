import { getDb } from "./db.js"

// Ingest queue store — manages the ingest_queue table (Phase 2.3.8)

export function enqueueIngestTask(projectId, filePath) {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO ingest_queue (project_id, file_path, status, progress, created_at)
    VALUES (?, ?, 'pending', 0, ?)
  `)
  const info = stmt.run(projectId, filePath, Date.now())
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
