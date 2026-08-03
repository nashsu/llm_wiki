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

/** Look a project up by its client UUID (WikiProject.id; migration 011). */
export function getProjectByUuid(uuid) {
  return getDb().prepare("SELECT * FROM projects WHERE uuid = ?").get(uuid)
}

/** Look a project up by its root path (unique per migration 003). */
export function getProjectByPath(path) {
  return getDb().prepare("SELECT * FROM projects WHERE path = ?").get(path)
}

/**
 * Resolve-or-create a project row (issue #21). Chat persistence needs a
 * projects FK target, but projects registered through the legacy flow only
 * exist in the plugin store / on disk — never in this table. Resolution
 * order: uuid → path → insert. When an existing row matches by path but
 * lacks the uuid, it is backfilled so both lookups agree going forward.
 * @param {{ uuid?: string|null, path: string, name?: string|null }} args
 */
export function ensureProjectRow({ uuid = null, path, name = null }) {
  const db = getDb()
  if (uuid) {
    const byUuid = getProjectByUuid(uuid)
    if (byUuid) return byUuid
  }
  const byPath = getProjectByPath(path)
  if (byPath) {
    if (uuid && !byPath.uuid) {
      db.prepare("UPDATE projects SET uuid = ?, updated_at = ? WHERE id = ?").run(uuid, Date.now(), byPath.id)
      return getProject(byPath.id)
    }
    return byPath
  }
  const finalName = name || path.split(/[\\/]/).filter(Boolean).pop() || path
  const now = Date.now()
  const info = db
    .prepare(
      "INSERT INTO projects (name, path, uuid, owner_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)"
    )
    .run(finalName, path, uuid, now, now)
  return getProject(info.lastInsertRowid)
}
