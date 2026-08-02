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
import type { ScheduledImportConfig, ScheduledImportDirectory } from "@/stores/wiki-store"
import { loadScheduledImportConfig, saveScheduledImportConfig } from "@/lib/project-store"
import { enqueueSourceIngest, isIngestableSourcePath } from "@/lib/source-lifecycle"
import { useActivityStore } from "@/stores/activity-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

export type ScheduledImportPathIssue =
  | "inside-project"
  | "contains-project"
  | "duplicate-directory"
  | "overlaps-directory"

export interface DirectoryScanResult {
  directoryId: string
  scannedAt: number
  discovered: number
  unchanged: number
  copied: number
  queued: number
  skipped: number
  failed: number
}

interface ImportFileRecord {
  md5: string
  destinationPath: string
}

interface ImportDirectoryDb {
  pathKey: string
  files: Record<string, ImportFileRecord>
  lastScan: number | null
}

interface ImportDbStore {
  version: 2
  directories: Record<string, ImportDirectoryDb>
}

type LegacyImportDb = {
  version?: number
  directories?: Record<string, { files?: Record<string, string>; lastScan?: number | null }>
}

type ScanOptions = { runId?: number }

const DB_PATH = ".llm-wiki/scheduled-import-db.json"
const LEGACY_DB_DIR = ".llm-wiki-imported"
const SCHEDULED_IMPORT_DIR = "scheduled-import"
const MAX_SCHEDULED_IMPORT_BYTES = 100 * 1024 * 1024
const SCHEDULED_IMPORT_CONFIG_EXTENSIONS = new Set(["json", "yaml", "yml", "xml"])
const RESERVED_WINDOWS_NAMES = new Set([
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5",
  "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5",
  "lpt6", "lpt7", "lpt8", "lpt9",
])

const scheduler = {
  timer: null as ReturnType<typeof setTimeout> | null,
  running: false,
  runId: 0,
  pendingStart: null as { project: WikiProject; config: ScheduledImportConfig; runId: number } | null,
  pendingManualScan: null as { project: WikiProject; config: ScheduledImportConfig; directoryIds: Set<string> | null } | null,
}

function emptyDbStore(): ImportDbStore {
  return { version: 2, directories: {} }
}

function dbFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${DB_PATH}`
}

function caseFoldPath(path: string): string {
  const normalized = normalizePath(path)
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized
}

function pathKey(path: string): string {
  const normalized = normalizePath(path)
  // Do not turn the filesystem root into an empty string while trimming
  // trailing separators; an empty key would make root containment checks fail.
  return caseFoldPath(normalized === "/" ? "/" : normalized.replace(/\/+$/, ""))
}

function isPathInside(path: string, parent: string): boolean {
  const child = pathKey(path)
  const root = pathKey(parent)
  return child === root || child.startsWith(root === "/" ? "/" : `${root}/`)
}

function stableSuffix(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 8)
}

function sanitizePathSegment(segment: string): string {
  let value = segment.replace(/[<>:"|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").trim()
  if (!value) value = "_"
  if (RESERVED_WINDOWS_NAMES.has((value.split(".")[0] ?? value).toLowerCase())) value = `_${value}`
  return value
}

function safeRelativePath(path: string): string {
  const parts = normalizePath(path).split("/").filter((part) => part && part !== "." && part !== "..")
  const safe = parts.map(sanitizePathSegment)
  if (safe.length === 0) return "_"
  if (safe.join("/") !== parts.join("/")) {
    const index = safe.length - 1
    const name = safe[index]
    const dot = name.lastIndexOf(".")
    safe[index] = dot > 0
      ? `${name.slice(0, dot)}-${stableSuffix(normalizePath(path))}${name.slice(dot)}`
      : `${name}-${stableSuffix(normalizePath(path))}`
  }
  return safe.join("/")
}

function basename(path: string): string {
  return normalizePath(path).replace(/\/+$/, "").split("/").pop() || "directory"
}

function uniqueNamespace(name: string, id: string, existing: Iterable<string>): string {
  const base = `${sanitizePathSegment(name).toLowerCase()}-${stableSuffix(id)}`
  const used = new Set(existing)
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

export function createScheduledImportDirectory(
  path: string,
  existing: readonly ScheduledImportDirectory[] = [],
): ScheduledImportDirectory {
  const normalized = normalizePath(path).replace(/\/+$/, "")
  const id = `scheduled-${stableSuffix(`${normalized}:${Date.now()}:${Math.random()}`)}`
  const name = basename(normalized)
  return {
    id,
    name,
    path: normalized,
    enabled: true,
    lastScan: null,
    lastError: null,
    outputNamespace: uniqueNamespace(name, id, existing.map((directory) => directory.outputNamespace)),
  }
}

export function resolveImportPath(projectPath: string, configPath: string): string {
  const path = normalizePath(configPath.trim())
  if (!path) return ""
  return isAbsolutePath(path) ? path : `${normalizePath(projectPath)}/${path}`
}

export function getScheduledImportPathIssue(
  projectPath: string,
  importPath: string,
  directories: readonly ScheduledImportDirectory[] = [],
  exceptDirectoryId?: string,
): ScheduledImportPathIssue | null {
  const project = pathKey(projectPath)
  const root = pathKey(importPath)
  if (!root) return null
  if (isPathInside(root, project)) return "inside-project"
  if (isPathInside(project, root)) return "contains-project"
  for (const directory of directories) {
    if (directory.id === exceptDirectoryId || !directory.path) continue
    if (pathKey(directory.path) === root) return "duplicate-directory"
    if (isPathInside(directory.path, root) || isPathInside(root, directory.path)) return "overlaps-directory"
  }
  return null
}

export function isProjectManagedScheduledImportPath(projectPath: string, importPath: string): boolean {
  const issue = getScheduledImportPathIssue(projectPath, importPath)
  return issue === "inside-project" || issue === "contains-project"
}

type LegacyConfig = Partial<ScheduledImportConfig> & {
  path?: unknown
  lastScan?: unknown
  version?: unknown
  directories?: unknown
}

export function normalizeScheduledImportConfigForProject(
  projectPath: string,
  config: LegacyConfig | null | undefined,
): ScheduledImportConfig {
  const interval = Math.max(1, Math.min(1440, Number(config?.interval) || 60))
  if (Array.isArray(config?.directories)) {
    const directories: ScheduledImportDirectory[] = []
    for (const [index, value] of config.directories.entries()) {
      if (!value || typeof value !== "object") continue
      const candidate = value as Partial<ScheduledImportDirectory>
      const path = resolveImportPath(projectPath, typeof candidate.path === "string" ? candidate.path : "")
      if (!path || getScheduledImportPathIssue(projectPath, path, directories)) continue
      let id = typeof candidate.id === "string" && candidate.id ? candidate.id : `scheduled-${stableSuffix(path)}`
      if (directories.some((directory) => directory.id === id)) id = `${id}-${stableSuffix(`${path}:${index}`)}`
      const name = typeof candidate.name === "string" && candidate.name ? candidate.name : basename(path)
      const suppliedNamespace = typeof candidate.outputNamespace === "string"
        ? sanitizePathSegment(candidate.outputNamespace)
        : ""
      // A V1 directory intentionally uses the root of scheduled-import. Keep
      // that layout stable on every later V2 normalization.
      const preserveLegacyNamespace = id.startsWith("legacy-") && candidate.outputNamespace === ""
      const outputNamespace = preserveLegacyNamespace
        ? ""
        : suppliedNamespace && !directories.some((directory) => directory.outputNamespace === suppliedNamespace)
        ? suppliedNamespace
        : uniqueNamespace(name, id, directories.map((directory) => directory.outputNamespace))
      directories.push({
        id,
        name,
        path,
        enabled: candidate.enabled !== false,
        lastScan: typeof candidate.lastScan === "number" ? candidate.lastScan : null,
        lastError: typeof candidate.lastError === "string" ? candidate.lastError : null,
        outputNamespace,
      })
    }
    return { version: 2, enabled: config?.enabled === true && directories.some((directory) => directory.enabled), interval, directories }
  }

  const legacyPath = typeof config?.path === "string" ? resolveImportPath(projectPath, config.path) : ""
  if (!legacyPath || isProjectManagedScheduledImportPath(projectPath, legacyPath)) {
    return { version: 2, enabled: false, interval, directories: [] }
  }
  const id = `legacy-${stableSuffix(pathKey(legacyPath))}`
  return {
    version: 2,
    enabled: config?.enabled === true,
    interval,
    directories: [{
      id,
      name: basename(legacyPath),
      path: legacyPath,
      enabled: true,
      lastScan: typeof config?.lastScan === "number" ? config.lastScan : null,
      lastError: null,
      outputNamespace: "",
    }],
  }
}

export function isScheduledImportInternalPath(path: string): boolean {
  const parts = normalizePath(path).split("/")
  return parts.includes(LEGACY_DB_DIR) || parts.includes(".llm-wiki")
}

export function shouldSkipScheduledImportFile(projectPath: string, filePath: string): boolean {
  const path = normalizePath(filePath)
  const project = normalizePath(projectPath)
  if (isScheduledImportInternalPath(path)) return true
  if (isPathInside(path, `${project}/wiki`) || isPathInside(path, `${project}/raw/sources/.cache`)) return true
  return (path.split("/").pop() ?? "").startsWith(".")
}

export function shouldSkipScheduledImportConfigFile(path: string): boolean {
  const name = normalizePath(path).split("/").pop() ?? ""
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : ""
  return Boolean(ext && SCHEDULED_IMPORT_CONFIG_EXTENSIONS.has(ext))
}

function relativePath(importPath: string, file: Pick<FileNode, "path" | "name">): string {
  const root = normalizePath(importPath).replace(/\/+$/, "")
  const source = normalizePath(file.path)
  return isPathInside(source, root) && pathKey(source) !== pathKey(root)
    ? source.slice(root.length + 1)
    : file.name
}

export function scheduledImportDestinationForFile(
  projectPath: string,
  directoryOrPath: ScheduledImportDirectory | string,
  file: Pick<FileNode, "path" | "name">,
): string {
  const project = normalizePath(projectPath)
  const source = normalizePath(file.path)
  const sourcesRoot = `${project}/raw/sources`
  if (isPathInside(source, sourcesRoot)) return source
  const directory = typeof directoryOrPath === "string"
    ? { path: directoryOrPath, outputNamespace: "" }
    : directoryOrPath
  const namespace = directory.outputNamespace ? `${directory.outputNamespace}/` : ""
  return `${sourcesRoot}/${SCHEDULED_IMPORT_DIR}/${namespace}${safeRelativePath(relativePath(directory.path, file))}`
}

function collectFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => node.is_dir ? collectFiles(node.children ?? []) : [node])
}

function legacyRecordDestination(projectPath: string, legacyRoot: string, sourcePath: string): string {
  return scheduledImportDestinationForFile(projectPath, legacyRoot, {
    path: sourcePath,
    name: basename(sourcePath),
  })
}

async function loadDbStore(projectPath: string, config: ScheduledImportConfig): Promise<ImportDbStore> {
  try {
    const path = dbFilePath(projectPath)
    if (!(await fileExists(path))) return emptyDbStore()
    const parsed = JSON.parse(await readFile(path)) as LegacyImportDb | Partial<ImportDbStore>
    if (!parsed.directories || typeof parsed.directories !== "object") return emptyDbStore()
    if (parsed.version === 2) {
      const directories: Record<string, ImportDirectoryDb> = {}
      for (const [id, value] of Object.entries(parsed.directories as Record<string, Partial<ImportDirectoryDb>>)) {
        if (!value || typeof value !== "object") continue
        const files: Record<string, ImportFileRecord> = {}
        for (const [source, record] of Object.entries(value.files ?? {})) {
          if (record && typeof record === "object" && typeof (record as ImportFileRecord).md5 === "string") {
            files[pathKey(source)] = {
              md5: (record as ImportFileRecord).md5,
              destinationPath: normalizePath((record as ImportFileRecord).destinationPath),
            }
          }
        }
        directories[id] = { pathKey: typeof value.pathKey === "string" ? value.pathKey : "", files, lastScan: value.lastScan ?? null }
      }
      return { version: 2, directories }
    }

    const migrated = emptyDbStore()
    for (const directory of config.directories) {
      const legacy = Object.entries(parsed.directories).find(([storedPath]) => pathKey(storedPath) === pathKey(directory.path))?.[1]
      if (!legacy) continue
      const files: Record<string, ImportFileRecord> = {}
      for (const [source, md5] of Object.entries(legacy.files ?? {})) {
        if (typeof md5 !== "string") continue
        files[pathKey(source)] = { md5, destinationPath: legacyRecordDestination(projectPath, directory.path, source) }
      }
      migrated.directories[directory.id] = { pathKey: pathKey(directory.path), files, lastScan: legacy.lastScan ?? null }
    }
    return migrated
  } catch (error) {
    console.warn("[scheduled-import] failed to load scan database:", error)
    return emptyDbStore()
  }
}

async function saveDirectoryDb(
  projectPath: string,
  config: ScheduledImportConfig,
  directory: ScheduledImportDirectory,
  db: ImportDirectoryDb,
): Promise<void> {
  const store = await loadDbStore(projectPath, config)
  store.directories[directory.id] = db
  await writeFileAtomic(dbFilePath(projectPath), JSON.stringify(store, null, 2))
}

function isCurrentRun(projectId: string, runId?: number): boolean {
  return useWikiStore.getState().project?.id === projectId && (runId === undefined || runId === scheduler.runId)
}

async function updateDirectoryStatus(
  project: WikiProject,
  directoryId: string,
  patch: Pick<ScheduledImportDirectory, "lastScan" | "lastError">,
  runId?: number,
): Promise<void> {
  if (!isCurrentRun(project.id, runId)) return
  const persisted = normalizeScheduledImportConfigForProject(project.path, await loadScheduledImportConfig(project.path))
  const next = {
    ...persisted,
    directories: persisted.directories.map((directory) => directory.id === directoryId ? { ...directory, ...patch } : directory),
  }
  await saveScheduledImportConfig(project.path, next)
  if (isCurrentRun(project.id, runId)) useWikiStore.getState().setScheduledImportConfig(next)
}

function reportInvalidDirectory(directory: ScheduledImportDirectory, issue: ScheduledImportPathIssue): void {
  useActivityStore.getState().addItem({
    type: "ingest",
    title: "Scheduled import skipped",
    status: "error",
    detail: `Scheduled import directory is invalid (${issue}): ${directory.path}`,
    filesWritten: [],
  })
}

export async function scanScheduledImportDirectory(
  project: WikiProject,
  directory: ScheduledImportDirectory,
  config: ScheduledImportConfig = useWikiStore.getState().scheduledImportConfig,
  options: ScanOptions = {},
): Promise<DirectoryScanResult> {
  const result: DirectoryScanResult = { directoryId: directory.id, scannedAt: Date.now(), discovered: 0, unchanged: 0, copied: 0, queued: 0, skipped: 0, failed: 0 }
  const issue = getScheduledImportPathIssue(project.path, directory.path, config.directories, directory.id)
  if (issue) {
    reportInvalidDirectory(directory, issue)
    throw new Error(`Invalid scheduled import directory: ${issue}`)
  }
  if (!isCurrentRun(project.id, options.runId)) return result

  const projectPath = normalizePath(project.path)
  const importRoot = resolveImportPath(projectPath, directory.path)
  const tree = await listDirectory(importRoot)
  const store = await loadDbStore(projectPath, config)
  const currentDb = store.directories[directory.id] ?? { pathKey: pathKey(importRoot), files: {}, lastScan: null }
  const nextDb: ImportDirectoryDb = { pathKey: pathKey(importRoot), files: {}, lastScan: result.scannedAt }
  const changed: Array<{ key: string; md5: string; destinationPath: string }> = []
  const llmConfig = useWikiStore.getState().llmConfig

  for (const file of collectFiles(tree)) {
    if (!isCurrentRun(project.id, options.runId)) return result
    result.discovered += 1
    try {
      const sourcePath = normalizePath(file.path)
      if (shouldSkipScheduledImportFile(projectPath, sourcePath) || shouldSkipScheduledImportConfigFile(sourcePath) || !isIngestableSourcePath(sourcePath)) {
        result.skipped += 1
        continue
      }
      if (await getFileSize(sourcePath) > MAX_SCHEDULED_IMPORT_BYTES) {
        result.skipped += 1
        continue
      }
      const key = pathKey(sourcePath)
      const md5 = await getFileMd5(sourcePath)
      const prior = currentDb.files[key]
      if (prior?.md5 === md5) {
        nextDb.files[key] = prior
        result.unchanged += 1
        continue
      }
      const destinationPath = scheduledImportDestinationForFile(projectPath, directory, file)
      await copyFile(sourcePath, destinationPath)
      changed.push({ key, md5, destinationPath })
      result.copied += 1
    } catch (error) {
      result.failed += 1
      console.warn(`[scheduled-import] skipped ${file.path}:`, error)
    }
  }

  if (!isCurrentRun(project.id, options.runId)) return result
  if (changed.length > 0) {
    await Promise.all(changed.map(({ destinationPath }) => preprocessFile(destinationPath).catch(() => undefined)))
    let ids: string[]
    try {
      ids = await enqueueSourceIngest(project, changed.map(({ destinationPath }) => destinationPath), llmConfig)
    } catch (error) {
      // Keep the changed MD5s out of the DB: a later scan must retry files
      // that could not be accepted by the ingest queue.
      console.error("[scheduled-import] failed to enqueue changed files:", error)
      await updateDirectoryStatus(project, directory.id, {
        lastScan: directory.lastScan,
        lastError: error instanceof Error ? error.message : String(error),
      }, options.runId)
      return result
    }
    // enqueueSourceIngest currently returns only task IDs. Until it provides a
    // per-path result, treat a partial acceptance as retryable rather than
    // incorrectly marking every changed file as imported.
    if (ids.length === changed.length) {
      for (const file of changed) nextDb.files[file.key] = { md5: file.md5, destinationPath: file.destinationPath }
      result.queued = ids.length
      await refreshProjectFileTree(projectPath, { projectId: project.id, bumpDataVersion: true })
    } else {
      result.failed += changed.length - ids.length
    }
  }

  if (!isCurrentRun(project.id, options.runId)) return result
  await saveDirectoryDb(projectPath, config, directory, nextDb)
  await updateDirectoryStatus(project, directory.id, { lastScan: result.scannedAt, lastError: null }, options.runId)
  return result
}

/** Backward-compatible one-directory entry point used by existing callers/tests. */
export async function scanAndImport(project: WikiProject, importPath: string, options: ScanOptions = {}): Promise<void> {
  const config = normalizeScheduledImportConfigForProject(project.path, {
    enabled: true,
    interval: 60,
    path: importPath,
  })
  const directory = config.directories[0]
  if (!directory) return
  await scanScheduledImportDirectory(project, directory, config, options)
}

function enabledDirectories(config: ScheduledImportConfig, onlyDirectoryIds?: Set<string>): ScheduledImportDirectory[] {
  return config.directories.filter((directory) => directory.enabled && (!onlyDirectoryIds || onlyDirectoryIds.has(directory.id)))
}

async function runCycle(
  project: WikiProject,
  config: ScheduledImportConfig,
  runId: number,
  options: { onlyDirectoryIds?: Set<string>; scheduleNext: boolean },
): Promise<void> {
  if (scheduler.running) return
  scheduler.running = true
  const directories = enabledDirectories(config, options.onlyDirectoryIds)
  try {
    for (const directory of directories) {
      if (!isCurrentRun(project.id, runId)) return
      try {
        await scanScheduledImportDirectory(project, directory, config, { runId })
      } catch (error) {
        console.error(`[scheduled-import] directory failed: ${directory.path}`, error)
        await updateDirectoryStatus(project, directory.id, { lastScan: directory.lastScan, lastError: String(error) }, runId)
      }
    }
  } finally {
    scheduler.running = false
    // A settings save can restart the scheduler while the previous cycle is
    // still running. Defer the new start until that cycle fully exits so it is
    // not lost behind the single-flight guard.
    const pendingStart = scheduler.pendingStart
    if (pendingStart) {
      scheduler.pendingStart = null
      void runCycle(pendingStart.project, pendingStart.config, pendingStart.runId, { scheduleNext: true })
      return
    }
    const pendingManualScan = scheduler.pendingManualScan
    if (pendingManualScan) {
      scheduler.pendingManualScan = null
      void runCycle(pendingManualScan.project, pendingManualScan.config, scheduler.runId, {
        onlyDirectoryIds: pendingManualScan.directoryIds ?? undefined,
        scheduleNext: options.scheduleNext,
      })
      return
    }
    if (!options.scheduleNext || !isCurrentRun(project.id, runId)) return
    const delay = Math.max(1, Math.min(1440, config.interval)) * 60 * 1000
    scheduler.timer = setTimeout(() => void runCycle(project, config, runId, { scheduleNext: true }), delay)
  }
}

export function startScheduledImport(project: WikiProject, config: ScheduledImportConfig): void {
  stopScheduledImport()
  if (!config.enabled || enabledDirectories(config).length === 0 || config.interval <= 0) return
  const runId = ++scheduler.runId
  if (scheduler.running) {
    scheduler.pendingStart = { project, config, runId }
    return
  }
  void runCycle(project, config, runId, { scheduleNext: true })
}

export function requestScheduledImportScan(project: WikiProject, config: ScheduledImportConfig, directoryId?: string): Promise<void> {
  if (scheduler.running) {
    if (!scheduler.pendingManualScan || scheduler.pendingManualScan.project.id !== project.id) {
      scheduler.pendingManualScan = {
        project,
        config,
        directoryIds: directoryId ? new Set([directoryId]) : null,
      }
    } else if (!directoryId) {
      scheduler.pendingManualScan.directoryIds = null
    } else if (scheduler.pendingManualScan.directoryIds) {
      scheduler.pendingManualScan.directoryIds.add(directoryId)
    }
    return Promise.resolve()
  }
  return runCycle(project, config, scheduler.runId, {
    onlyDirectoryIds: directoryId ? new Set([directoryId]) : undefined,
    scheduleNext: false,
  })
}

export function stopScheduledImport(): void {
  scheduler.runId += 1
  scheduler.pendingStart = null
  scheduler.pendingManualScan = null
  if (scheduler.timer) clearTimeout(scheduler.timer)
  scheduler.timer = null
}
