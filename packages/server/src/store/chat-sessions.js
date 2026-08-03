// SQLite access layer for chat sessions + messages (issue #21).
//
// Writers for the chartered chat_sessions / chat_messages tables
// (V1_CHARTERED_ARCHITECTURE.md §4.3). Sessions are addressed by their UUID
// text on the wire (the client's locally generated conversation id doubles
// as the session id); the tables keep integer surrogate keys internally.
//
// Messages are persisted on completion — a user message when its turn
// starts, an assistant message when the turn finishes — never per streamed
// delta (decision recorded in issue #21).

import crypto from "node:crypto"
import { getDb } from "./db.js"

const DEFAULT_TITLE = "New chat"

/** Map a chat_sessions row to the wire shape (ChatSessionSchema). */
function sessionToWire(row) {
  if (!row) return null
  return {
    id: row.uuid,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Map a chat_messages row to the wire shape (ChatMessageSchema). */
function messageToWire(row) {
  let references
  if (row.refs) {
    try {
      const parsed = JSON.parse(row.refs)
      if (Array.isArray(parsed)) references = parsed
    } catch { /* corrupt refs column → treat as none */ }
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    ...(references ? { references } : {}),
    createdAt: row.created_at,
  }
}

export function getSessionByUuid(uuid) {
  return sessionToWire(getDb().prepare("SELECT * FROM chat_sessions WHERE uuid = ?").get(uuid))
}

/** List a project's sessions, most recently updated first. */
export function listSessions(projectId) {
  return getDb()
    .prepare("SELECT * FROM chat_sessions WHERE project_id = ? ORDER BY updated_at DESC, id DESC")
    .all(projectId)
    .map(sessionToWire)
}

/**
 * Create a session row. The uuid defaults to a fresh randomUUID — explicit
 * "new session" from the UI lets the server own the id; lazy creation from
 * a chat turn passes the client's conversation id instead.
 */
export function createSession(projectId, { uuid = crypto.randomUUID(), title = DEFAULT_TITLE } = {}) {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    "INSERT INTO chat_sessions (project_id, uuid, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(projectId, uuid, title, now, now)
  return getSessionByUuid(uuid)
}

/**
 * Get the session for a uuid, creating it on first use (a chat turn that
 * arrives for an unknown session id starts that session). The auto title
 * mirrors the client's behavior: the first user message, truncated.
 */
export function ensureSession(projectId, uuid, { title } = {}) {
  const existing = getSessionByUuid(uuid)
  if (existing) return existing
  return createSession(projectId, { uuid, title: title || DEFAULT_TITLE })
}

export function renameSession(uuid, title) {
  const db = getDb()
  const info = db.prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE uuid = ?").run(title, Date.now(), uuid)
  if (info.changes === 0) return null
  return getSessionByUuid(uuid)
}

/** Delete a session; its messages cascade (migration 005 FK). */
export function deleteSession(uuid) {
  const info = getDb().prepare("DELETE FROM chat_sessions WHERE uuid = ?").run(uuid)
  return info.changes > 0
}

/**
 * Append a completed message to a session (by session uuid) and bump the
 * session's updated_at so session lists stay sorted by activity.
 * @param {string} sessionUuid
 * @param {"user"|"assistant"} role
 * @param {string} content
 * @param {unknown[]|null} [references] assistant-turn references, stored as JSON
 */
export function appendMessage(sessionUuid, role, content, references = null) {
  const db = getDb()
  const session = db.prepare("SELECT id FROM chat_sessions WHERE uuid = ?").get(sessionUuid)
  if (!session) return null
  const now = Date.now()
  const refs = Array.isArray(references) && references.length > 0 ? JSON.stringify(references) : null
  const info = db.prepare(
    "INSERT INTO chat_messages (session_id, role, content, refs, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(session.id, role, content, refs, now)
  db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(now, session.id)
  return messageToWire(db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(info.lastInsertRowid))
}

/** A session's messages in insertion order. */
export function listMessages(sessionUuid) {
  const db = getDb()
  const session = db.prepare("SELECT id FROM chat_sessions WHERE uuid = ?").get(sessionUuid)
  if (!session) return []
  return db.prepare(
    "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC"
  ).all(session.id).map(messageToWire)
}
