import {
  copyFile,
  fileExists,
  getFileMd5,
  getFileSize,
  listDirectory,
  preprocessFile,
  readFile,
  writeFileAtomic,
} from "@/commands/fs"
import type { FileNode, WikiProject } from "@/types/wiki"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import type { ScheduledImportConfig } from "@/stores/wiki-store"
import {
  loadScheduledImportConfig,
  saveScheduledImportConfig,
} from "@/lib/project-store"
import {
  enqueueSourceIngest,
  isIngestableSourcePath,
} from "@/lib/source-lifecycle"
import { useActivityStore } from "@/stores/activity-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

interface ImportDb {
  files: Record<string, string>
  lastScan: number | null
}

interface ImportDbStore {
  version: 1
  /**
   * Kept as a map for backward compatibility with early scheduled-import
   * builds. The current UI supports one watched directory per project, so
   * saveImportDb intentionally writes only the active directory key.
   */
  directories: Record<string, ImportDb>
}

type ScanOptions = {
  runId?: number
}

const EMPTY_DB: ImportDb = {
  files: {},
  lastScan: null,
}

let scanTimer: ReturnType<typeof setInterval> | null = null
let scanning = false
let activeRunId = 0
const managedPathWarningKeys = new Set<string>()

const DB_PATH = ".llm-wiki/scheduled-import-db.json"
const LEGACY_DB_DIR = ".llm-wiki-imported"
const SCHEDULED_IMPORT_DIR = "scheduled-import"
const MAX_SCHEDULED_IMPORT_BYTES = 100 * 1024 * 1024
const SCHEDULED_IMPORT_CONFIG_EXTENSIONS = new Set(["json", "yaml", "yml", "xml"])
const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
])

function emptyStore(): ImportDbStore {
  return { version: 1, directories: {} }
}

function dbFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${DB_PATH}`
}

function dbDirectoryKey(importPath: string): string {
  const normalized = normalizePath(importPath)
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized
}

function cloneDb(db: ImportDb): ImportDb {
  return {
    files: { ...db.files },
    lastScan: db.lastScan,
  }
}

function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedParent = normalizePath(parent).replace(/\/+$/, "")
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  )
}

function projectSubpath(projectPath: string, relPath: string): string {
  return `${normalizePath(projectPath)}/${relPath}`
}

export function isProjectManagedScheduledImportPath(
  projectPath: string,
  importPath: string,
): boolean {
  const project = normalizePath(projectPath).replace(/\/+$/, "")
  const root = normalizePath(importPath).replace(/\/+$/, "")
  return (
    root === project ||
    isPathInside(project, root) ||
    isPathInside(root, projectSubpath(project, "raw")) ||
    isPathInside(root, projectSubpath(project, "raw/sources")) ||
    isPathInside(root, projectSubpath(project, "wiki")) ||
    isPathInside(root, projectSubpath(project, ".llm-wiki"))
  )
}

function notifyManagedScheduledImportPath(project: WikiProject, importRoot: string): void {
  const key = `${project.id}:${normalizePath(importRoot)}`
  if (managedPathWarningKeys.has(key)) return
  managedPathWarningKeys.add(key)
  useActivityStore.getState().addItem({
    type: "ingest",
    title: "Scheduled import skipped",
    status: "error",
    detail: `Scheduled import path is inside or contains the current LLM Wiki project: ${importRoot}. Choose an external folder; project sources are handled by source folder monitoring.`,
    filesWritten: [],
  })
}

function stableSuffix(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 6)
}

function sanitizePathSegment(segment: string): string {
  let value = segment
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()

  if (!value) {
    value = "_"
  }

  const stem = value.split(".")[0]?.toLowerCase() ?? value.toLowerCase()
  if (RESERVED_WINDOWS_NAMES.has(stem)) {
    value = `_${value}`
  }

  return value
}

function appendSuffixToFileName(fileName: string, suffix: string): string {
  const dot = fileName.lastIndexOf(".")
  if (dot > 0) {
    return `${fileName.slice(0, dot)}-${suffix}${fileName.slice(dot)}`
  }
  return `${fileName}-${suffix}`
}

function safeRelativePath(path: string): string {
  const normalized = normalizePath(path)
  const parts = normalized
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
  const safeParts = parts.map(sanitizePathSegment)

  if (safeParts.length === 0) {
    return "_"
  }

  const safePath = safeParts.join("/")
  if (safePath !== parts.join("/")) {
    const last = safeParts[safeParts.length - 1]
    safeParts[safeParts.length - 1] = appendSuffixToFileName(last, stableSuffix(normalized))
  }
  return safeParts.join("/")
}

export function isScheduledImportInternalPath(path: string): boolean {
  const parts = normalizePath(path).split("/")
  return parts.includes(LEGACY_DB_DIR) || parts.includes(".llm-wiki")
}

export function shouldSkipScheduledImportFile(
  projectPath: string,
  filePath: string,
): boolean {
  const path = normalizePath(filePath)
  const project = normalizePath(projectPath)

  if (isScheduledImportInternalPath(path)) {
    return true
  }

  if (isPathInside(path, projectSubpath(project, "wiki"))) {
    return true
  }

  if (isPathInside(path, projectSubpath(project, "raw/sources/.cache"))) {
    return true
  }

  const name = path.split("/").pop() ?? ""
  return name.startsWith(".")
}

export function shouldSkipScheduledImportConfigFile(path: string): boolean {
  const name = normalizePath(path).split("/").pop() ?? ""
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : ""
  return Boolean(ext && SCHEDULED_IMPORT_CONFIG_EXTENSIONS.has(ext))
}

export function resolveImportPath(projectPath: string, configPath: string): string {
  const path = normalizePath(configPath || "raw/sources")
  if (isAbsolutePath(path)) {
    return path
  }
  return `${normalizePath(projectPath)}/${path}`
}

export function scheduledImportDestinationForFile(
  projectPath: string,
  importPath: string,
  file: Pick<FileNode, "path" | "name">,
): string {
  const project = normalizePath(projectPath)
  const source = normalizePath(file.path)
  const sourcesRoot = projectSubpath(project, "raw/sources")

  if (isPathInside(source, sourcesRoot)) {
    return source
  }

  const importRoot = normalizePath(importPath).replace(/\/+$/, "")
  const relative =
    source === importRoot || !source.startsWith(`${importRoot}/`)
      ? file.name
      : source.slice(importRoot.length + 1)

  return `${sourcesRoot}/${SCHEDULED_IMPORT_DIR}/${safeRelativePath(relative)}`
}

function collectFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (!node.is_dir) {
      files.push(node)
    } else if (node.children) {
      files.push(...collectFiles(node.children))
    }
  }
  return files
}

async function loadDbStore(projectPath: string): Promise<ImportDbStore> {
  const path = dbFilePath(projectPath)
  try {
    if (!(await fileExists(path))) {
      return emptyStore()
    }
    const content = await readFile(path)
    const parsed = JSON.parse(content) as Partial<ImportDbStore>
    if (!parsed.directories || typeof parsed.directories !== "object") {
      return emptyStore()
    }
    return {
      version: 1,
      directories: parsed.directories as Record<string, ImportDb>,
    }
  } catch (err) {
    console.warn("Failed to load scheduled import database:", err)
    return emptyStore()
  }
}

async function loadImportDb(
  projectPath: string,
  importPath: string,
): Promise<ImportDb> {
  const store = await loadDbStore(projectPath)
  const db = store.directories[dbDirectoryKey(importPath)]
  return db ? cloneDb(db) : cloneDb(EMPTY_DB)
}

async function saveImportDb(
  projectPath: string,
  importPath: string,
  db: ImportDb,
): Promise<void> {
  const store: ImportDbStore = {
    version: 1,
    directories: {
      [dbDirectoryKey(importPath)]: cloneDb(db),
    },
  }
  await writeFileAtomic(dbFilePath(projectPath), JSON.stringify(store, null, 2))
}

function isCurrentProject(projectId: string): boolean {
  return useWikiStore.getState().project?.id === projectId
}

function isCurrentRun(projectId: string, runId?: number): boolean {
  return isCurrentProject(projectId) && (runId === undefined || runId === activeRunId)
}

export async function scanAndImport(
  project: WikiProject,
  importPath: string,
  options: ScanOptions = {},
): Promise<void> {
  if (!importPath) return

  const projectPath = normalizePath(project.path)
  const importRoot = resolveImportPath(projectPath, importPath)
  if (isProjectManagedScheduledImportPath(projectPath, importRoot)) {
    console.warn(
      `[scheduled-import] skipped self-referential path "${importRoot}". Use source folder monitoring for project sources instead.`,
    )
    notifyManagedScheduledImportPath(project, importRoot)
    return
  }

  if (scanning) return

  scanning = true

  try {
    if (!isCurrentRun(project.id, options.runId)) {
      return
    }

    const tree = await listDirectory(importRoot)
    const db = await loadImportDb(projectPath, importRoot)
    const nextDb: ImportDb = { files: {}, lastScan: Date.now() }
    const llmConfig = useWikiStore.getState().llmConfig
    const changedFiles: Array<{ key: string; md5: string; destPath: string }> = []

    for (const file of collectFiles(tree)) {
      try {
        const sourcePath = normalizePath(file.path)
        if (
          shouldSkipScheduledImportFile(projectPath, sourcePath) ||
          shouldSkipScheduledImportConfigFile(sourcePath) ||
          !isIngestableSourcePath(sourcePath)
        ) {
          continue
        }

        if (!isCurrentRun(project.id, options.runId)) {
          return
        }

        const size = await getFileSize(sourcePath)
        if (size > MAX_SCHEDULED_IMPORT_BYTES) {
          console.warn(
            `[scheduled-import] skipping ${sourcePath}: ${(size / 1024 / 1024).toFixed(1)} MB exceeds 100 MB limit`,
          )
          continue
        }

        const key = sourcePath
        const md5 = await getFileMd5(sourcePath)

        if (db.files[key] === md5) {
          nextDb.files[key] = md5
          continue
        }

        const destPath = scheduledImportDestinationForFile(projectPath, importRoot, file)
        if (normalizePath(destPath) !== sourcePath) {
          await copyFile(sourcePath, destPath)
        }
        changedFiles.push({ key, md5, destPath })
      } catch (err) {
        console.warn(`[scheduled-import] skipped ${file.path}:`, err)
      }
    }

    if (!isCurrentRun(project.id, options.runId)) {
      return
    }

    if (changedFiles.length > 0) {
      const destPaths = changedFiles.map((file) => file.destPath)
      await Promise.all(destPaths.map((path) => preprocessFile(path).catch(() => {})))
      if (isCurrentRun(project.id, options.runId)) {
        const ids = await enqueueSourceIngest(project, destPaths, llmConfig)
        if (ids.length > 0) {
          for (const file of changedFiles) {
            nextDb.files[file.key] = file.md5
          }
          await refreshProjectFileTree(projectPath, {
            projectId: project.id,
            bumpDataVersion: true,
          })
        } else {
          console.warn("[scheduled-import] LLM is not configured; changed files were not marked imported")
        }
      }
    }

    await saveImportDb(projectPath, importRoot, nextDb)

    const currentConfig = await loadScheduledImportConfig(projectPath)
    if (currentConfig) {
      await saveScheduledImportConfig(projectPath, {
        ...currentConfig,
        lastScan: nextDb.lastScan,
      })
    }

    if (isCurrentProject(project.id) && currentConfig) {
      useWikiStore.getState().setScheduledImportConfig({
        ...currentConfig,
        lastScan: nextDb.lastScan,
      })
    }
  } catch (err) {
    console.error("Scheduled import scan failed:", err)
  } finally {
    scanning = false
  }
}

export function startScheduledImport(
  project: WikiProject,
  config: ScheduledImportConfig,
): void {
  stopScheduledImport()

  if (!config.enabled || !config.path || config.interval <= 0) {
    return
  }

  const runId = ++activeRunId
  const intervalMs = Math.max(1, Math.min(1440, config.interval)) * 60 * 1000

  void scanAndImport(project, config.path, { runId })

  scanTimer = setInterval(() => {
    void scanAndImport(project, config.path, { runId })
  }, intervalMs)
}

export function stopScheduledImport(): void {
  activeRunId += 1
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
  }
}
