// SHA256-based ingest cache (port of src/lib/ingest-cache.ts).
// Stores hash of source file content → skips re-ingest if unchanged.
// Cache file: .llm-wiki/ingest-cache.json
//
// Browser→Node swaps: crypto.subtle.digest("SHA-256", TextEncoder bytes) →
// node:crypto createHash("sha256") over the UTF-8 encoding of the same
// string (byte-identical digests); @/commands/fs readFile/writeFile/
// fileExists → node:fs/promises. The Tauri write_file command creates
// missing parent dirs, so writeFile mirrors that with mkdir recursive.
// normalizePath/isAbsolutePath are inlined from @/lib/path-utils.
//
// The source identity is passed as a PARAMETER (no store access on the
// server).

import { createHash } from "node:crypto"
import { mkdir, readFile as fsReadFile, stat, writeFile as fsWriteFile } from "node:fs/promises"

function normalizePath(p) {
  return p.replace(/\\/g, "/")
}

function isAbsolutePath(p) {
  if (!p) return false
  if (p.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (p.startsWith("\\\\") || p.startsWith("//")) return true
  return false
}

async function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function cachePath(projectPath) {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-cache.json`
}

async function loadCache(projectPath) {
  try {
    const raw = await fsReadFile(cachePath(projectPath), "utf8")
    return JSON.parse(raw)
  } catch {
    return { entries: {} }
  }
}

async function saveCache(projectPath, cache) {
  try {
    const target = cachePath(projectPath)
    await mkdir(target.split("/").slice(0, -1).join("/"), { recursive: true })
    await fsWriteFile(target, JSON.stringify(cache, null, 2))
  } catch {
    // non-critical
  }
}

/**
 * Existence check mirroring the Tauri file_exists command: a missing path
 * resolves to false (stat ENOENT/ENOTDIR); any other error propagates so
 * callers can fall back to re-ingest instead of trusting a stale entry.
 */
async function fileExists(fullPath) {
  try {
    await stat(fullPath)
    return true
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return false
    throw err
  }
}

/**
 * Check if a source file has already been ingested with the same content.
 * Returns the list of previously written files if cached, or null if ingest
 * is needed.
 *
 * IMPORTANT: a cache hit is only returned if every previously-written file
 * still exists on disk. Otherwise we treat the cache as stale and fall
 * through to a full re-ingest. Historically we returned the cached list
 * blindly, which surfaced ghost entries in the activity panel — clicking
 * them gave the preview panel a missing file, and the auto-save path then
 * materialized a `[Binary file: ...]` stub at the now-empty location.
 */
export async function checkIngestCache(projectPath, sourceFileName, sourceContent) {
  const cache = await loadCache(projectPath)
  const entry = cache.entries[sourceFileName]
  if (!entry) return null

  const currentHash = await sha256(sourceContent)
  if (entry.hash !== currentHash) return null

  const pp = normalizePath(projectPath)
  for (const filePath of entry.filesWritten) {
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${pp}/${filePath}`
    try {
      if (!(await fileExists(fullPath))) {
        console.log(
          `[ingest-cache] cache miss for ${sourceFileName}: ${filePath} no longer on disk`,
        )
        return null
      }
    } catch {
      // If the existence check itself fails, fall back to re-ingest —
      // safer than trusting a stale cache entry.
      return null
    }
  }

  return entry.filesWritten
}

/**
 * Save ingest result to cache after successful ingest.
 */
export async function saveIngestCache(projectPath, sourceFileName, sourceContent, filesWritten) {
  const cache = await loadCache(projectPath)
  const hash = await sha256(sourceContent)
  const newEntries = { ...cache.entries }
  newEntries[sourceFileName] = {
    hash,
    timestamp: Date.now(),
    filesWritten,
  }
  await saveCache(projectPath, { entries: newEntries })
}

/**
 * Remove a source file entry from cache (e.g., when source is deleted).
 */
export async function removeFromIngestCache(projectPath, sourceFileName) {
  const cache = await loadCache(projectPath)
  const newEntries = { ...cache.entries }
  delete newEntries[sourceFileName]
  await saveCache(projectPath, { entries: newEntries })
}

/** Move a cache entry when an unchanged source is renamed inside raw/sources. */
export async function moveIngestCacheEntry(
  projectPath,
  oldSourceIdentity,
  newSourceIdentity,
  movedFiles = new Map(),
) {
  const cache = await loadCache(projectPath)
  const entry = cache.entries[oldSourceIdentity]
  if (!entry || oldSourceIdentity === newSourceIdentity) return
  const migratedEntry = {
    ...entry,
    filesWritten: entry.filesWritten.map((path) => movedFiles.get(path) ?? path),
  }
  const newEntries = { ...cache.entries, [newSourceIdentity]: migratedEntry }
  delete newEntries[oldSourceIdentity]
  await saveCache(projectPath, { entries: newEntries })
}
