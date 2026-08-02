import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

// Faithful Node port of src-tauri/src/commands/file_history.rs.
// Append-only per-file version history stored under
// <project>/.llm-wiki/history/<fnv1a(relative-path)>.json

const MAX_HISTORY_CONTENT_BYTES = 512 * 1024
const MAX_ENTRIES_PER_FILE = 30

function toForwardSlash(p) {
  return p.split(path.sep).join("/")
}

/** Walk up from a file until a directory containing `.llm-wiki` is found. */
export function projectRootFor(filePath) {
  let cursor = path.dirname(filePath)
  while (true) {
    try {
      if (fs.statSync(path.join(cursor, ".llm-wiki")).isDirectory()) return cursor
    } catch { /* keep walking */ }
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

/** 64-bit FNV-1a hash, hex-encoded to 16 chars (matches Rust `{hash:016x}`). */
function fnv1aHex(str) {
  let hash = 0xcbf29ce484222325n
  const bytes = Buffer.from(str, "utf-8")
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

function historyPath(root, filePath) {
  const relative = toForwardSlash(path.relative(root, filePath))
  return path.join(root, ".llm-wiki", "history", `${fnv1aHex(relative)}.json`)
}

export function recordFileVersion(filePath, author, tool) {
  let metadata
  try { metadata = fs.statSync(filePath) } catch { return }
  if (!metadata.isFile() || metadata.size > MAX_HISTORY_CONTENT_BYTES) return
  let content
  try { content = fs.readFileSync(filePath, "utf-8") } catch { return }
  const root = projectRootFor(filePath)
  if (!root) return
  if (filePath.startsWith(path.join(root, ".llm-wiki"))) return
  const storePath = historyPath(root, filePath)
  let entries = []
  try { entries = JSON.parse(fs.readFileSync(storePath, "utf-8")) } catch { entries = [] }
  if (!Array.isArray(entries)) entries = []
  if (entries.length && entries[entries.length - 1].content === content) return
  entries.push({
    id: crypto.randomUUID(),
    path: toForwardSlash(filePath),
    timestamp: Date.now(),
    author,
    tool,
    content,
  })
  if (entries.length > MAX_ENTRIES_PER_FILE) {
    entries = entries.slice(entries.length - MAX_ENTRIES_PER_FILE)
  }
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, JSON.stringify(entries))
  } catch { /* best effort */ }
}

function checkedFile(projectPath, filePath) {
  const root = fs.realpathSync(projectPath)
  const file = fs.realpathSync(filePath)
  if (!file.startsWith(root) || file.startsWith(path.join(root, ".llm-wiki"))) {
    throw new Error("History path must stay inside the project")
  }
  return { root, file }
}

export function listFileHistory({ projectPath, filePath }) {
  const { root, file } = checkedFile(projectPath, filePath)
  let entries = []
  try { entries = JSON.parse(fs.readFileSync(historyPath(root, file), "utf-8")) } catch { entries = [] }
  if (!Array.isArray(entries)) entries = []
  return [...entries].reverse()
}

export function restoreFileHistory({ projectPath, filePath, entryId }) {
  const { root, file } = checkedFile(projectPath, filePath)
  const entries = JSON.parse(fs.readFileSync(historyPath(root, file), "utf-8"))
  const entry = entries.find((e) => e.id === entryId)
  if (!entry) throw new Error("History entry not found")
  fs.writeFileSync(file, entry.content)
  recordFileVersion(file, "human", "history.restore")
  return entry.content
}
