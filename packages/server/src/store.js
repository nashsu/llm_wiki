import fs from "node:fs"
import path from "node:path"
import {
  STORES_DIR, SHARED_STORE_NAME, STORE_KEYS, desktopStoreCandidateDirs,
  explicitStoreFile, sharingDisabled, ensureDataDirs,
} from "./config.js"

// Persistent key/value store backing the browser shim for
// `@tauri-apps/plugin-store`, with a crucial property: when the web server
// runs on the SAME host as the desktop app, it reads and writes the DESKTOP's
// own plugin-store file, so one user has ONE set of settings across both
// clients. Writes are key-level read-modify-write under a file lock so the web
// client never clobbers an unrelated key the desktop changed, and reads are
// mtime-aware so desktop edits become visible to the web without a restart.

const cache = new Map()           // path -> { mtime, size, obj }
let resolvedShared = null         // { path, source } once a shared file is found
let fallbackCheckedAt = 0         // throttle re-discovery while on fallback
const FALLBACK_RECHECK_MS = 30000

function isSharedName(name) { return name === SHARED_STORE_NAME }

function looksLikeLlmWikiStore(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false
  return STORE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function discoverSharedFile() {
  const name = SHARED_STORE_NAME
  const explicit = explicitStoreFile()
  if (explicit) return { path: explicit, source: "explicit" }
  if (sharingDisabled()) return { path: path.join(STORES_DIR, name), source: "disabled" }
  const candidates = []
  for (const dir of desktopStoreCandidateDirs()) candidates.push(path.join(dir, name))
  // Include the web fallback dir too, so a store created here is rediscovered.
  candidates.push(path.join(STORES_DIR, name))
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, "utf-8")
      if (looksLikeLlmWikiStore(JSON.parse(raw))) return { path: file, source: file.startsWith(STORES_DIR) ? "fallback" : "auto" }
    } catch { /* not present / not json / no known keys -> try next */ }
  }
  return { path: path.join(STORES_DIR, name), source: "fallback" }
}

/** Resolve the on-disk file for a store name (shared discovery for the default store). */
export function resolveStorePath(name) {
  if (!isSharedName(name)) {
    const base = path.basename(name)
    if (!base || base !== name || name.includes("..")) throw new Error(`invalid store name: ${name}`)
    return path.join(STORES_DIR, base)
  }
  if (resolvedShared && resolvedShared.source !== "fallback") return resolvedShared.path
  const now = Date.now()
  if (!resolvedShared || (resolvedShared.source === "fallback" && now - fallbackCheckedAt > FALLBACK_RECHECK_MS)) {
    fallbackCheckedAt = now
    resolvedShared = discoverSharedFile()
  }
  return resolvedShared.path
}

export function getStoreDiagnostics() {
  // Force a resolution so the reported path/source is current.
  const p = resolveStorePath(SHARED_STORE_NAME)
  return {
    shared: !!(resolvedShared && (resolvedShared.source === "auto" || resolvedShared.source === "explicit")),
    path: p,
    source: resolvedShared ? resolvedShared.source : "unknown",
    exists: fs.existsSync(p),
    candidates: desktopStoreCandidateDirs(),
  }
}

// ── mtime-aware read ──────────────────────────────────────────────────────
function readObj(file, force) {
  let stat
  try { stat = fs.statSync(file) } catch { cache.delete(file); return {} }
  const c = cache.get(file)
  if (!force && c && c.mtime === stat.mtimeMs && c.size === stat.size) return c.obj
  let obj = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed
  } catch { obj = {} }
  cache.set(file, { mtime: stat.mtimeMs, size: stat.size, obj })
  return obj
}

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8")
  fs.renameSync(tmp, file)
  const st = fs.statSync(file)
  cache.set(file, { mtime: st.mtimeMs, size: st.size, obj })
}

// ── advisory file lock (spinlock via exclusive-create + stale timeout) ─────
function withLock(file, fn) {
  const lock = `${file}.lock`
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  const STALE_MS = 5000
  const start = Date.now()
  while (true) {
    try {
      const fd = fs.openSync(lock, "wx")
      try { fs.closeSync(fd) } catch { /* ignore */ }
      break
    } catch {
      // lock held; reclaim if stale
      try {
        const st = fs.statSync(lock)
        if (Date.now() - st.mtimeMs > STALE_MS) { try { fs.unlinkSync(lock) } catch { /* race ok */ } }
      } catch { /* ignore */ }
      if (Date.now() - start > 4000) throw new Error(`store lock timeout: ${lock}`)
      // busy-wait briefly (synchronous; settings writes are infrequent)
      const until = Date.now() + 25
      while (Date.now() < until) { /* spin */ }
    }
  }
  try { return fn() } finally {
    try { fs.unlinkSync(lock) } catch { /* ignore */ }
  }
}

// ── public API ────────────────────────────────────────────────────────────
export function readStore(name) {
  return readObj(resolveStorePath(name), false)
}

export function readStoreKey(name, key) {
  const obj = readObj(resolveStorePath(name), false)
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
}

export function writeStore(name, value) {
  const file = resolveStorePath(name)
  return withLock(file, () => {
    const cur = readObj(file, true)
    const merged = { ...cur, ...(value && typeof value === "object" ? value : {}) }
    writeAtomic(file, merged)
    return merged
  })
}

export function writeStoreKey(name, key, value) {
  const file = resolveStorePath(name)
  return withLock(file, () => {
    const cur = readObj(file, true)
    cur[key] = value
    writeAtomic(file, cur)
    return cur
  })
}

export function deleteStoreKey(name, key) {
  const file = resolveStorePath(name)
  return withLock(file, () => {
    const cur = readObj(file, true)
    const existed = Object.prototype.hasOwnProperty.call(cur, key)
    delete cur[key]
    writeAtomic(file, cur)
    return existed
  })
}

export { ensureDataDirs }
