/**
 * SHA256-based ingest cache — Node.js port.
 * Uses Node.js crypto instead of WebCrypto.
 */
import * as crypto from "crypto"
import { readFile, writeFile, fileExists } from "../shims/fs-node"

interface CacheEntry {
  hash: string
  timestamp: number
  filesWritten: string[]
}

interface CacheData {
  entries: Record<string, CacheEntry>
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex")
}

function cachePath(projectPath: string): string {
  return `${projectPath}/.llm-wiki/ingest-cache.json`
}

async function loadCache(projectPath: string): Promise<CacheData> {
  try {
    const raw = await readFile(cachePath(projectPath))
    return JSON.parse(raw) as CacheData
  } catch {
    return { entries: {} }
  }
}

async function saveCache(projectPath: string, cache: CacheData): Promise<void> {
  try {
    await writeFile(cachePath(projectPath), JSON.stringify(cache, null, 2))
  } catch { /* non-critical */ }
}

export async function checkIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
): Promise<string[] | null> {
  const cache = await loadCache(projectPath)
  const entry = cache.entries[sourceFileName]
  if (!entry) return null

  const currentHash = sha256(sourceContent)
  if (entry.hash !== currentHash) return null

  for (const filePath of entry.filesWritten) {
    try {
      if (!(await fileExists(filePath.startsWith("/") ? filePath : `${projectPath}/${filePath}`))) {
        return null
      }
    } catch { return null }
  }
  return entry.filesWritten
}

export async function saveIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  filesWritten: string[],
): Promise<void> {
  const cache = await loadCache(projectPath)
  cache.entries[sourceFileName] = {
    hash: sha256(sourceContent),
    timestamp: Date.now(),
    filesWritten,
  }
  await saveCache(projectPath, cache)
}
