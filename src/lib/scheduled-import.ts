import { listDirectory, copyFile, preprocessFile, getFileModifiedTime } from "@/commands/fs"
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

let scanTimer: ReturnType<typeof setInterval> | null = null
let scanning = false

interface FileChange {
  type: "new" | "modified"
  sourcePath: string // absolute path in monitored directory
  fileName: string
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
 * Build a map of existing sources: fileName -> lastModifiedTime.
 * We match by base filename (without directory prefix) since sources
 * are flat in raw/sources/.
 */
async function buildExistingSourcesMap(projectPath: string): Promise<Map<string, { path: string; modified: number }>> {
  const pp = normalizePath(projectPath)
  const map = new Map<string, { path: string; modified: number }>()

  try {
    const tree = await listDirectory(`${pp}/raw/sources`)
    const files = collectFiles(tree)

    for (const file of files) {
      const baseName = getFileName(file.path) || file.name
      try {
        const modified = await getFileModifiedTime(file.path)
        map.set(baseName, { path: file.path, modified })
      } catch {
        // Can't get modified time, skip
      }
    }
  } catch {
    // sources directory may not exist yet
  }

  return map
}

/**
 * Detect changes between monitored directory and existing sources.
 */
async function detectChanges(
  monitoredPath: string,
  existingSources: Map<string, { path: string; modified: number }>,
): Promise<FileChange[]> {
  const changes: FileChange[] = []

  try {
    const tree = await listDirectory(monitoredPath)
    const files = collectFiles(tree)

    for (const file of files) {
      if (!isImportableFile(file.name)) continue

      const baseName = getFileName(file.path) || file.name
      const existing = existingSources.get(baseName)

      if (!existing) {
        // New file
        changes.push({
          type: "new",
          sourcePath: file.path,
          fileName: baseName,
        })
      } else {
        // Check if modified
        try {
          const sourceModified = await getFileModifiedTime(file.path)
          if (sourceModified > existing.modified) {
            changes.push({
              type: "modified",
              sourcePath: file.path,
              fileName: baseName,
            })
          }
        } catch {
          // Can't compare, skip
        }
      }
    }
  } catch (err) {
    console.error("[Scheduled Import] Failed to scan monitored directory:", err)
  }

  return changes
}

/**
 * Execute a scan: detect changes and import modified/new files.
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
    const existingSources = await buildExistingSourcesMap(pp)
    const changes = await detectChanges(ip, existingSources)

    if (changes.length === 0) {
      console.log("[Scheduled Import] No changes detected")
      return
    }

    console.log(`[Scheduled Import] Found ${changes.length} changes`)

    const llmConfig = useWikiStore.getState().llmConfig
    const hasLlm = hasUsableLlm(llmConfig)

    for (const change of changes) {
      try {
        // Copy file to sources directory
        const destPath = `${pp}/raw/sources/${change.fileName}`
        await copyFile(change.sourcePath, destPath)

        // Preprocess the file
        preprocessFile(destPath).catch(() => {})

        // Enqueue for ingest if LLM is configured
        if (hasLlm) {
          const project = useWikiStore.getState().project
          if (project) {
            await enqueueIngest(project.id, destPath)
          }
        }

        console.log(`[Scheduled Import] ${change.type === "new" ? "Imported" : "Updated"}: ${change.fileName}`)
      } catch (err) {
        console.error(`[Scheduled Import] Failed to process ${change.fileName}:`, err)
      }
    }

    // Update last scan time
    const config = useWikiStore.getState().scheduledImportConfig
    const updatedConfig = { ...config, lastScan: Date.now() }
    useWikiStore.getState().setScheduledImportConfig(updatedConfig)
    // Persist per-project config
    const { saveScheduledImportConfig } = await import("@/lib/project-store")
    await saveScheduledImportConfig(projectPath, updatedConfig)

    // Refresh file tree
    const { listDirectory: listDir } = await import("@/commands/fs")
    const tree = await listDir(pp)
    useWikiStore.getState().setFileTree(tree)
    useWikiStore.getState().bumpDataVersion()

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
  // Default to "raw/sources" if path is empty
  const path = configPath || "raw/sources"
  // If path is already absolute, use it as-is
  if (path.startsWith("/") || path.match(/^[a-zA-Z]:[/\\]/)) {
    return normalizePath(path)
  }
  // Otherwise, treat as relative to project path
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
