// Mirror of the desktop's `mark_app_write_path` / `is_app_write_ignored`
// (src-tauri/src/commands/file_sync.rs). When the server itself writes a file
// (a web-client save, an ingest output, a created wiki page), we record the
// path for a short window so the filesystem watchers do NOT treat that change
// as an external edit — preventing self-echo (e.g. re-ingesting a file the
// user just imported, or reloading an editor buffer the user just saved).
// Matching is prefix-aware: ignoring a directory ignores everything under it.

const IGNORE_MS = 4000
const fwd = (p) => p.split(path.sep).join("/")
import path from "node:path"

/** @type {Map<string, number>} normalized path -> expiry ms */
const ignores = new Map()

function purge(now) {
  for (const [k, exp] of ignores) if (exp <= now) ignores.delete(k)
}

export function markAppWrite(absPath) {
  const key = fwd(absPath)
  const now = Date.now()
  purge(now)
  ignores.set(key, now + IGNORE_MS)
}

export function isAppWriteIgnored(absPath) {
  const key = fwd(absPath)
  const now = Date.now()
  purge(now)
  for (const k of ignores.keys()) {
    if (k === key || key.startsWith(k + "/")) return true
  }
  return false
}
