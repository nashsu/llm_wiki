import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { emit } from "../events.js"
import { isAppWriteIgnored } from "../appwrite.js"

// Node port of src-tauri/src/commands/file_sync.rs (source-folder auto-watch).
// Snapshots raw/sources/, diffs on demand and on fs.watch events, persists a
// change queue to .llm-wiki/file-change-queue.json, and broadcasts
// "file-sync://changed" / "file-sync://queue-updated" over SSE.

const SNAPSHOT_FILE = ".llm-wiki/file-snapshot.json"
const QUEUE_FILE = ".llm-wiki/file-change-queue.json"
const EVENT_QUEUE_UPDATED = "file-sync://queue-updated"
const EVENT_CHANGED = "file-sync://changed"
const EVENT_PROJECT_CHANGED = "project://files-changed"
const IGNORED_TOP = new Set([".llm-wiki", ".obsidian", ".git", "node_modules", ".cache", ".superpowers"])
// Desktop (file_sync.rs) only md5-hashes sources <= 32 MiB; larger files get
// hash:null and are diffed by size+mtime. Mirror it so a snapshot written by one
// client is interpreted identically by the other (no spurious "modified" tasks).
const MAX_HASH_BYTES = 32 * 1024 * 1024

const fwd = (p) => p.split(path.sep).join("/")

/** @type {Map<string, {watcher: any, timer: any, projectId: string}>} */
const watchers = new Map()

function md5OfFile(file) {
  try { return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex") }
  catch { return null }
}

function sourcesDir(projectPath) {
  return path.join(projectPath, "raw", "sources")
}

function walkSources(dir, base, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = fwd(path.relative(base, full))
    if (entry.isDirectory()) walkSources(full, base, out)
    else if (entry.isFile()) {
      let stat
      try { stat = fs.statSync(full) } catch { continue }
      const size = stat.size
      out.set(rel, { hash: size <= MAX_HASH_BYTES ? md5OfFile(full) : null, size, mtimeMs: Math.floor(stat.mtimeMs) })
    }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")) } catch { return fallback }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8")
}

// The source snapshot is shared on disk with the desktop app, which stores it
// wrapped as { version, updatedAt, files: { rel: FileMeta } } (file_sync.rs
// FileSnapshot, camelCase). Read tolerates both that and the legacy flat map an
// older web server wrote, so switching formats never looks like a mass
// create/delete. Write always emits the desktop shape so the Rust reader
// (serde FileSnapshot) parses it cleanly.
function loadSnapshotFiles(projectPath) {
  const raw = readJson(path.join(projectPath, SNAPSHOT_FILE), null)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  if (raw.files && typeof raw.files === "object" && !Array.isArray(raw.files)) return raw.files
  const { version: _v, updatedAt: _u, ...flat } = raw
  return flat
}

function saveSnapshot(projectPath, filesMap) {
  const files = {}
  for (const [rel, info] of filesMap) files[rel] = info
  writeJson(path.join(projectPath, SNAPSHOT_FILE), { version: 1, updatedAt: Date.now(), files })
}

function loadQueue(projectPath) {
  const q = readJson(path.join(projectPath, QUEUE_FILE), null)
  if (q && typeof q.version === "number" && Array.isArray(q.tasks)) return q
  return { version: 0, tasks: [] }
}

function saveQueue(projectPath, queue) {
  writeJson(path.join(projectPath, QUEUE_FILE), queue)
}

function makeTask(projectId, absPath, kind, info) {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    projectId,
    path: fwd(absPath),
    kind,
    status: "pending",
    hashBefore: null,
    hashAfter: info?.hash ?? null,
    size: info?.size ?? null,
    mtimeMs: info?.mtimeMs ?? null,
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    error: null,
    needsRerun: false,
  }
}

function rescan({ projectId, projectPath }) {
  const base = sourcesDir(projectPath)
  const previous = loadSnapshotFiles(projectPath)
  const current = new Map()
  walkSources(base, base, current)

  const changedTasks = []
  const queue = loadQueue(projectPath)
  // Keep non-pending history; rebuild pending from the fresh diff.
  queue.tasks = queue.tasks.filter((t) => t.status !== "pending")

  for (const [rel, info] of current) {
    const abs = path.join(base, rel)
    if (isAppWriteIgnored(abs)) continue
    const prev = previous[rel]
    if (!prev) changedTasks.push(makeTask(projectId, abs, "created", info))
    else if (prev.hash !== info.hash || prev.size !== info.size) {
      // Desktop (enqueue_paths) decides "modified" by (hash, size), NOT mtime,
      // so a mere touch (mtime bump, identical bytes) is not re-ingested. Match
      // that so the two clients enqueue the same tasks from a shared snapshot.
      const task = makeTask(projectId, abs, "modified", info)
      task.hashBefore = prev.hash
      changedTasks.push(task)
    }
  }
  for (const rel of Object.keys(previous)) {
    if (isAppWriteIgnored(path.join(base, rel))) continue
    if (!current.has(rel)) changedTasks.push(makeTask(projectId, path.join(base, rel), "deleted", previous[rel]))
  }

  queue.tasks.push(...changedTasks)
  queue.version += 1
  saveQueue(projectPath, queue)

  saveSnapshot(projectPath, current)

  if (changedTasks.length) {
    emit(EVENT_CHANGED, { projectId, tasks: changedTasks })
    emit(EVENT_QUEUE_UPDATED, { projectId, tasks: queue.tasks })
  }
  return { queue, changedTasks }
}

function onProjectFsEvent(entry, filename) {
  if (filename == null) entry.projUnknown = true
  else entry.projPaths.add(fwd(String(filename)))
  if (entry.projDebounce) clearTimeout(entry.projDebounce)
  entry.projDebounce = setTimeout(() => flushProjectChanges(entry), 700)
}

function flushProjectChanges(entry) {
  entry.projDebounce = null
  const out = []
  for (const rel of entry.projPaths) {
    const segs = rel.split("/")
    if (IGNORED_TOP.has(segs[0])) continue
    if (segs[0] === "raw" && segs[1] === "sources") continue // handled by the source pipeline
    const abs = path.join(entry.projectPath, rel)
    if (isAppWriteIgnored(abs)) continue
    out.push(rel)
  }
  entry.projPaths = new Set()
  const unknown = entry.projUnknown
  entry.projUnknown = false
  if (out.length === 0 && !unknown) return
  // paths=[] (unknown platform or only-ignored activity that still warrants a
  // tree refresh) tells the client to refresh the tree but NOT reload the open
  // file; a non-empty list lets it also reload the open file if affected.
  emit(EVENT_PROJECT_CHANGED, { projectId: entry.projectId, paths: out })
}

function startProjectWatcher(entry) {
  try {
    entry.projectWatcher = fs.watch(entry.projectPath, { recursive: true }, (_e, fn) => onProjectFsEvent(entry, fn))
  } catch {
    // recursive watch unsupported; live cross-client refresh degrades to manual.
    entry.projectWatcher = null
  }
}

function startProjectFileWatcher({ projectId, projectPath }) {
  const result = rescan({ projectId, projectPath })
  const key = path.resolve(projectPath)
  stopWatcherForKey(key)
  const base = sourcesDir(projectPath)
  let watcher = null
  try {
    watcher = fs.watch(base, { recursive: true }, () => scheduleRescan(key, projectId, projectPath))
  } catch {
    // recursive watch unsupported (some Linux fs); fall back to polling.
  }
  const timer = setInterval(() => scheduleRescan(key, projectId, projectPath), 15000)
  const entry = {
    watcher, timer, projectId, projectPath, debounce: null,
    projectWatcher: null, projDebounce: null, projPaths: new Set(), projUnknown: false,
  }
  watchers.set(key, entry)
  startProjectWatcher(entry)
  return result
}

function scheduleRescan(key, projectId, projectPath) {
  const entry = watchers.get(key)
  if (!entry) return
  if (entry.debounce) clearTimeout(entry.debounce)
  entry.debounce = setTimeout(() => {
    try { rescan({ projectId, projectPath }) } catch { /* ignore */ }
  }, 750)
}

function stopWatcherForKey(key) {
  const entry = watchers.get(key)
  if (!entry) return
  try { entry.watcher?.close() } catch { /* ignore */ }
  try { entry.projectWatcher?.close() } catch { /* ignore */ }
  if (entry.timer) clearInterval(entry.timer)
  if (entry.debounce) clearTimeout(entry.debounce)
  if (entry.projDebounce) clearTimeout(entry.projDebounce)
  watchers.delete(key)
}

function stopProjectFileWatcher() {
  for (const key of [...watchers.keys()]) stopWatcherForKey(key)
}

function getFileChangeQueue({ projectPath }) {
  return loadQueue(projectPath)
}

function retryFileChangeTask({ projectId, projectPath, taskId }) {
  const queue = loadQueue(projectPath)
  const task = queue.tasks.find((t) => t.id === taskId)
  if (task) {
    task.status = "pending"
    task.needsRerun = true
    task.retryCount += 1
    task.error = null
    task.updatedAt = Date.now()
    queue.version += 1
    saveQueue(projectPath, queue)
    emit(EVENT_QUEUE_UPDATED, { projectId, tasks: queue.tasks })
  }
  return queue
}

function ignoreFileChangeTask({ projectId, projectPath, taskId }) {
  const queue = loadQueue(projectPath)
  const task = queue.tasks.find((t) => t.id === taskId)
  if (task) {
    task.status = "superseded"
    task.updatedAt = Date.now()
    queue.version += 1
    saveQueue(projectPath, queue)
    emit(EVENT_QUEUE_UPDATED, { projectId, tasks: queue.tasks })
  }
  return queue
}

export const fileSyncCommands = {
  start_project_file_watcher: startProjectFileWatcher,
  stop_project_file_watcher: stopProjectFileWatcher,
  rescan_project_files: rescan,
  get_file_change_queue: getFileChangeQueue,
  retry_file_change_task: retryFileChangeTask,
  ignore_file_change_task: ignoreFileChangeTask,
}
