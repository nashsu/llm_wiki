import { listDirectory, copyFile, preprocessFile, getFileMd5, createDirectory, fileExists, readFile, writeFile } from "@/commands/fs"
import { enqueueIngest } from "@/lib/ingest-queue"
import { normalizePath, getFileName } from "@/lib/path-utils"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { useWikiStore, type ScheduledImportConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

// Supported file extensions for import
const IMPORTABLE_EXTENSIONS = new Set([
  "md", "mdx", "txt", "rtf", "pdf",
  "html", "htm", "xml",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp", "epub", "pages", "numbers", "key",
  "json", "jsonl", "csv", "tsv", "yaml", "yml", "ndjson",
  "py", "js", "ts", "jsx", "tsx", "rs", "go", "java",
  "c", "cpp", "h", "rb", "php", "swift", "sql", "sh",
])

// Hidden config folder name in the monitored directory
const IMPORT_DB_FOLDER = ".llm-wiki-imported"
const IMPORT_DB_FILE = "db.json"

let scanTimer: ReturnType<typeof setInterval> | null = null
let scanning = false

interface ImportDbEntry {
  md5: string
  importedAt: number
}

interface ImportDb {
  files: Record<string, ImportDbEntry>
  lastScan: number
}

/**
 * Get all files recursively from a directory tree (FileNode structure).
 */
function collectFiles(nodes: FileNode[], prefix: string = ""): Array<{ name: string; path: string }> {
  const files: Array<{ name: string; path: string }> = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...collectFiles(node.children, `${prefix}${node.name}/`))
    } else if (!node.is_dir) {
      files.push({ name: `${prefix}${node.name}`, path: node.path })
    }
  }
  return files
}

/**
 * Check if a file has an importable extension.
 */
function isImportableFile(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""
  return IMPORTABLE_EXTENSIONS.has(ext)
}

/**
 * Get the path to the import db folder within the monitored directory.
 */
function getDbFolderPath(importPath: string): string {
  return `${importPath}/${IMPORT_DB_FOLDER}`
}

/**
 * Get the path to the import db.json file.
 */
function getDbFilePath(importPath: string): string {
  return `${importPath}/${IMPORT_DB_FOLDER}/${IMPORT_DB_FILE}`
}

/**
 * Ensure the .llm-wiki-imported/ directory exists in the monitored directory.
 */
async function ensureImportDb(importPath: string): Promise<void> {
  const dbFolder = getDbFolderPath(importPath)
  try {
    await createDirectory(dbFolder)
  } catch {
    // Directory may already exist
  }
}

/**
 * Load the import database from .llm-wiki-imported/db.json.
 * Returns an empty database if the file doesn't exist.
 */
async function loadImportDb(importPath: string): Promise<ImportDb> {
  const dbFilePath = getDbFilePath(importPath)
  try {
    const exists = await fileExists(dbFilePath)
    if (!exists) return { files: {}, lastScan: 0 }
    const content = await readFile(dbFilePath)
    const parsed = JSON.parse(content)
    return {
      files: parsed.files || {},
      lastScan: parsed.lastScan || 0,
    }
  } catch {
    return { files: {}, lastScan: 0 }
  }
}

/**
 * Save the import database to .llm-wiki-imported/db.json.
 */
async function saveImportDb(importPath: string, db: ImportDb): Promise<void> {
  const dbFilePath = getDbFilePath(importPath)
  try {
    await writeFile(dbFilePath, JSON.stringify(db, null, 2))
  } catch (err) {
    console.error("[Scheduled Import] Failed to save import db:", err)
  }
}

/**
 * Scan the monitored directory and import new or modified files.
 * Uses MD5 hashing stored in .llm-wiki-imported/db.json to detect changes.
 */
export async function scanAndImport(projectPath: string, importPath: string): Promise<void> {
  if (scanning) {
    console.log("[Scheduled Import] Scan already in progress, skipping")
    return
  }

  const pp = normalizePath(projectPath)
  const ip = normalizePath(importPath)

  scanning = true
  console.log(`[Scheduled Import] Starting scan of ${ip}`)

  try {
    // Ensure the hidden config folder exists
    await ensureImportDb(ip)

    // Load existing import database
    const db = await loadImportDb(ip)

    // List all files in the monitored directory
    let monitoredFiles: Array<{ name: string; path: string }> = []
    try {
      const tree = await listDirectory(ip)
      monitoredFiles = collectFiles(tree)
    } catch (err) {
      console.error("[Scheduled Import] Failed to list monitored directory:", err)
      return
    }

    // Filter to importable files only, excluding the hidden config folder
    const dbFolderPrefix = `${ip}/${IMPORT_DB_FOLDER}`
    const importableFiles = monitoredFiles.filter(f => {
      // Skip files inside .llm-wiki-imported/ (compare normalized paths)
      if (normalizePath(f.path).startsWith(dbFolderPrefix)) {
        return false
      }
      return isImportableFile(f.name)
    })

    if (importableFiles.length === 0) {
      console.log("[Scheduled Import] No importable files found")
      return
    }

    console.log(`[Scheduled Import] Found ${importableFiles.length} importable files`)

    const llmConfig = useWikiStore.getState().llmConfig
    const hasLlm = hasUsableLlm(llmConfig)
    let importedCount = 0
    let skippedCount = 0

    for (const file of importableFiles) {
      try {
        // Use relative path (from monitored dir) as the key
        const relativePath = file.name
        const currentMd5 = await getFileMd5(file.path)
        const existing = db.files[relativePath]

        // Check if file has changed
        if (existing && existing.md5 === currentMd5) {
          skippedCount++
          continue
        }

        // File is new or modified - import it
        const baseName = getFileName(file.path) || file.name
        const destPath = `${pp}/raw/sources/${baseName}`

        // Copy file to sources directory (skip if source IS the destination)
        const normalizedSource = normalizePath(file.path)
        const normalizedDest = normalizePath(destPath)
        if (normalizedSource !== normalizedDest) {
          await copyFile(file.path, destPath)
        }

        // Preprocess the file
        preprocessFile(destPath).catch(() => {})

        // Enqueue for ingest if LLM is configured
        if (hasLlm) {
          const project = useWikiStore.getState().project
          if (project) {
            await enqueueIngest(project.id, destPath)
          }
        }

        // Update the database with the new MD5
        db.files[relativePath] = {
          md5: currentMd5,
          importedAt: Date.now(),
        }

        importedCount++
        console.log(`[Scheduled Import] ${existing ? "Updated" : "Imported"}: ${baseName}`)
      } catch (err) {
        console.error(`[Scheduled Import] Failed to process ${file.name}:`, err)
      }
    }

    // Save the updated database
    db.lastScan = Date.now()
    await saveImportDb(ip, db)

    // Update last scan time in the store
    const config = useWikiStore.getState().scheduledImportConfig
    const updatedConfig = { ...config, lastScan: Date.now() }
    useWikiStore.getState().setScheduledImportConfig(updatedConfig)
    const { saveScheduledImportConfig } = await import("@/lib/project-store")
    await saveScheduledImportConfig(projectPath, updatedConfig)

    // Refresh file tree
    const { listDirectory: listDir } = await import("@/commands/fs")
    const tree = await listDir(pp)
    useWikiStore.getState().setFileTree(tree)
    useWikiStore.getState().bumpDataVersion()

    console.log(`[Scheduled Import] Scan complete: ${importedCount} imported, ${skippedCount} skipped`)
  } catch (err) {
    console.error("[Scheduled Import] Scan failed:", err)
  } finally {
    scanning = false
  }
}

/**
 * Resolve the absolute path for scheduled import.
 * If the config path is relative (not absolute), prepend the project path.
 * If the config path is empty, use the default "raw/sources" directory.
 */
export function resolveImportPath(projectPath: string, configPath: string): string {
  const pp = normalizePath(projectPath)
  const path = configPath || "raw/sources"
  if (path.startsWith("/") || path.match(/^[a-zA-Z]:[/\\]/)) {
    return normalizePath(path)
  }
  return `${pp}/${path}`
}

/**
 * Start the scheduled import timer.
 */
export function startScheduledImport(projectPath: string, config: ScheduledImportConfig): void {
  stopScheduledImport()

  if (!config.enabled || config.interval <= 0) {
    return
  }

  const pp = normalizePath(projectPath)
  const ip = resolveImportPath(pp, config.path)

  console.log(`[Scheduled Import] Starting with interval ${config.interval} minutes, path: ${ip}`)

  // Run first scan immediately
  scanAndImport(pp, ip).catch((err) => {
    console.error("[Scheduled Import] Initial scan failed:", err)
  })

  // Set up interval
  const intervalMs = config.interval * 60 * 1000
  scanTimer = setInterval(() => {
    scanAndImport(pp, ip).catch((err) => {
      console.error("[Scheduled Import] Scheduled scan failed:", err)
    })
  }, intervalMs)
}

/**
 * Stop the scheduled import timer.
 */
export function stopScheduledImport(): void {
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
    console.log("[Scheduled Import] Stopped")
  }
}

/**
 * Check if scheduled import is currently running.
 */
export function isScanning(): boolean {
  return scanning
}
