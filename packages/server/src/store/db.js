// SQLite connection + migration runner for the v2 server (Phase 2.2).
//
// Opens the database at DATA_DIR/server.db with WAL mode for concurrent reads.
// Runs migrations in order (001-009) on first boot. The sqlite-vec extension is
// loaded lazily in Phase 2.3 when vector search is implemented.

import path from "node:path"
import fs from "node:fs"
import Database from "better-sqlite3"
import { DATA_DIR } from "../config.js"

const DB_PATH = path.join(DATA_DIR, "server.db")
let db = null

/**
 * Get the singleton database connection. Creates the DB and runs migrations on
 * first call. WAL mode is enabled for concurrent read access.
 * @returns {import("better-sqlite3").Database}
 */
export function getDb() {
  if (db) return db
  fs.mkdirSync(DATA_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  return db
}

/**
 * Run all pending migrations in order. Each migration is a function that
 * receives the db and executes its DDL. Migrations are idempotent (CREATE IF
 * NOT EXISTS) so re-running is safe.
 */
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `)
  const applied = new Set(db.prepare("SELECT name FROM _migrations").all().map((r) => r.name))
  const insert = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")

  for (const [name, migrate] of MIGRATIONS) {
    if (applied.has(name)) continue
    const tx = db.transaction(() => {
      migrate(db)
      insert.run(name, Date.now())
    })
    tx()
    console.log(`[db] applied migration: ${name}`)
  }
}

// ── migrations ────────────────────────────────────────────────────────────
const MIGRATIONS = [
  ["001_users", (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        created_at INTEGER NOT NULL
      )
    `)
  }],

  ["002_settings", (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        user_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `)
  }],

  ["003_projects", (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        owner_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `)
  }],

  ["004_chat_sessions", (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `)
  }],

  ["005_chat_messages", (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        refs TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      )
    `)
  }],

  ["006_reviews", (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `)
  }],

  ["007_ingest_queue", (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingest_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `)
  }],

  ["008_graph_nodes_edges", (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other',
        link_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        UNIQUE (project_id, path),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_edges (
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY (source_id, target_id),
        FOREIGN KEY (source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_project ON graph_nodes(project_id)`)
  }],

  ["009_vec_chunks", (db) => {
    // sqlite-vec virtual table. The extension is loaded lazily in Phase 2.3.
    // For now, create a placeholder table that will be replaced.
    db.exec(`
      CREATE TABLE IF NOT EXISTS vec_chunks (
        chunk_id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        page_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        heading_path TEXT,
        embedding BLOB,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `)
  }],
]
