// SQLite access layer for projects (Phase 2.3).
//
// Thin wrappers over the projects table. All writes go through the main thread
// (better-sqlite3 is synchronous), per the worker-thread model in
// V1_CHARTERED_ARCHITECTURE.md §4.4.

import { getDb } from "./db.js"

export function listProjects() {
  return getDb().prepare("SELECT * FROM projects ORDER BY updated_at DESC").all()
}

export function getProject(id) {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id)
}

export function createProject({ name, path, ownerId = null }) {
  const db = getDb()
  const now = Date.now()
  const info = db
    .prepare(
      "INSERT INTO projects (name, path, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(name, path, ownerId, now, now)
  return getProject(info.lastInsertRowid)
}

export function updateProject(id, { name }) {
  const db = getDb()
  db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), id)
  return getProject(id)
}

export function deleteProject(id) {
  const info = getDb().prepare("DELETE FROM projects WHERE id = ?").run(id)
  return info.changes > 0
}
