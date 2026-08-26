import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { Plus, FileText, RefreshCw, BookOpen, Trash2, Folder, ChevronRight, ChevronDown, Link, ExternalLink, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useWikiStore } from "@/stores/wiki-store"
import { listDirectory, openPathInProject, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import { useAppDialog } from "@/stores/app-dialog-store"
import { normalizePath } from "@/lib/path-utils"
import { decideDeleteClick } from "@/lib/sources-tree-delete"
import { rescanProjectFileSync } from "@/lib/project-file-sync"
import { sortFileNodes } from "@/lib/file-tree-order"
import {
  deleteSourceFile,
  deleteSourceFolder,
  enqueueSourceIngest,
  importSourceFiles,
  importSourceFolder,
  type SkippedSourceImport,
  type SourceImportResult,
} from "@/lib/source-lifecycle"
import { filterRawSourceTree } from "@/lib/source-filter"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { importSourceUrls, parseImportUrls, type UrlImportResult } from "@/lib/url-source-import"
import { listIngestedSourceIdentities } from "@/lib/ingest-cache"
import { getQueue, type IngestTask } from "@/lib/ingest-queue"

const SOURCE_TREE_INITIAL_ROWS = 160
const SOURCE_TREE_LOAD_BATCH = 160
const IMPORT_SKIP_INITIAL_ROWS = 100
type SourceIngestStatus = "not-ingested" | "ingested" | IngestTask["status"]

export function SourcesView() {
  const { t } = useTranslation()
  const appDialog = useAppDialog()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const sourceWatchConfig = useWikiStore((s) => s.sourceWatchConfig)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [sources, setSources] = useState<FileNode[]>([])
  const [importing, setImporting] = useState(false)
  const [ingestingPath, setIngestingPath] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [urlDialogOpen, setUrlDialogOpen] = useState(false)
  const [urlInput, setUrlInput] = useState("")
  const [urlError, setUrlError] = useState<string | null>(null)
  const [urlResults, setUrlResults] = useState<UrlImportResult[]>([])
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null)
  const [showAllImportSkips, setShowAllImportSkips] = useState(false)
  const [ingestedIdentities, setIngestedIdentities] = useState<string[]>([])
  const [queueSnapshot, setQueueSnapshot] = useState<IngestTask[]>(() => [...getQueue()])
  const [sourceQuery, setSourceQuery] = useState("")
  /**
   * Path of the source-tree node currently in "click again to
   * confirm delete" state. Lifted up here (rather than living
   * inside SourceTree) for two reasons:
   *   1. Only one button can be armed at a time across the whole
   *      tree — clicking another delete disarms the prior one.
   *      Lifting state to the common ancestor makes that natural.
   *   2. The auto-disarm timer (5s) needs to survive across re-
   *      renders triggered by tree mutation; useEffect cleanup
   *      anchored here is the right scope.
   */
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null)

  // Auto-disarm: 5 seconds without a second click resets the
  // pending state. Prevents a stale armed button from firing if
  // the user walked away and came back. Cleared whenever the
  // pending path changes (so a fresh arm restarts the clock).
  useEffect(() => {
    if (!pendingDeletePath) return
    const t = setTimeout(() => setPendingDeletePath(null), 5000)
    return () => clearTimeout(t)
  }, [pendingDeletePath])

  const loadSources = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const tree = await listDirectory(`${pp}/raw/sources`, true)
      setSources(filterRawSourceTree(tree))
      setRefreshError(null)
    } catch (err) {
      setRefreshError(String(err))
      setSources([])
    }
  }, [project])

  useEffect(() => {
    loadSources()
  }, [loadSources, dataVersion])

  useEffect(() => {
    setSourceQuery("")
  }, [project?.id])

  useEffect(() => {
    if (!project) {
      setIngestedIdentities([])
      return
    }
    let active = true
    listIngestedSourceIdentities(project.path)
      .then((identities) => {
        if (active) setIngestedIdentities(identities)
      })
      .catch(() => {
        if (active) setIngestedIdentities([])
      })
    return () => {
      active = false
    }
  }, [project, dataVersion])

  useEffect(() => {
    const refresh = () => setQueueSnapshot([...getQueue()])
    refresh()
    const interval = setInterval(refresh, 1000)
    return () => clearInterval(interval)
  }, [project])

  const sourceStatuses = useMemo(() => {
    const statuses = new Map<string, SourceIngestStatus>()
    if (!project) return statuses
    const pp = normalizePath(project.path)
    for (const identity of ingestedIdentities) {
      statuses.set(`${pp}/raw/sources/${normalizePath(identity)}`, "ingested")
    }
    for (const task of queueSnapshot) {
      if (task.projectId !== project.id || task.status === "done") continue
      const path = normalizePath(task.sourcePath)
      statuses.set(path.startsWith("/") || /^[A-Za-z]:\//.test(path) ? path : `${pp}/${path}`, task.status)
    }
    return statuses
  }, [ingestedIdentities, project, queueSnapshot])
  const filteredSources = useMemo(
    () => filterSourceTreeByQuery(sources, sourceQuery),
    [sourceQuery, sources],
  )
  const totalSourceCount = useMemo(() => countFiles(sources), [sources])
  const filteredSourceCount = useMemo(() => countFiles(filteredSources), [filteredSources])

  async function handleRefreshSources() {
    if (!project || refreshing) return
    setRefreshing(true)
    try {
      await rescanProjectFileSync(project, useWikiStore.getState().sourceWatchConfig)
      setRefreshError(null)
    } catch (err) {
      console.warn("[sources] failed to rescan project files:", err)
      setRefreshError(String(err))
    } finally {
      await loadSources()
      setRefreshing(false)
    }
  }

  async function handleImport() {
    if (!project) return

    const selected = await open({
      multiple: true,
      title: t("sources.importSourceFiles"),
      filters: [
        {
          name: "Documents",
          extensions: [
            "md", "mdx", "txt", "org", "rtf", "pdf",
            "html", "htm", "xml",
            "doc", "docx", "docm", "xls", "xlsx", "xlsm", "xlsb",
            "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm",
            "odt", "ods", "odp", "epub", "mobi", "pages", "numbers", "key",
          ],
        },
        {
          name: "Data",
          extensions: ["json", "jsonl", "csv", "tsv", "yaml", "yml", "ndjson"],
        },
        {
          name: "Code",
          extensions: [
            "py", "js", "ts", "jsx", "tsx", "rs", "go", "java",
            "c", "cpp", "h", "rb", "php", "swift", "sql", "sh",
          ],
        },
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "avif", "heic"],
        },
        {
          name: "Media",
          extensions: ["mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a"],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    })

    if (!selected || selected.length === 0) return

    setImporting(true)
    setImportOutcome(null)
    setShowAllImportSkips(false)
    const paths = Array.isArray(selected) ? selected : [selected]
    try {
      const result = await importSourceFiles(project, paths, llmConfig, sourceWatchConfig)
      setImportOutcome(summarizeImportOutcome(result, null))
      await loadSources()
    } catch (err) {
      console.error("Failed to import files:", err)
      setImportOutcome(summarizeImportOutcome(null, err))
    } finally {
      setImporting(false)
    }
  }

  async function handleImportFolder() {
    if (!project) return

    const selected = await open({
      directory: true,
      title: t("sources.importSourceFolder"),
    })

    if (!selected || typeof selected !== "string") return

    setImporting(true)
    setImportOutcome(null)
    setShowAllImportSkips(false)
    try {
      const result = await importSourceFolder(project, selected, llmConfig, sourceWatchConfig)
      setImportOutcome(summarizeImportOutcome(result, null))
      await loadSources()
    } catch (err) {
      console.error(`Failed to import folder:`, err)
      setImportOutcome(summarizeImportOutcome(null, err))
    } finally {
      setImporting(false)
    }
  }

  async function handleImportUrls() {
    if (!project || importing) return
    let urls: string[]
    try {
      urls = parseImportUrls(urlInput)
      if (urls.length === 0) throw new Error(t("sources.urlImport.empty"))
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : String(error))
      return
    }
    setImporting(true)
    setUrlError(null)
    setUrlResults([])
    try {
      const results = await importSourceUrls(project, urls, llmConfig, sourceWatchConfig)
      setUrlResults(results)
      await loadSources()
      if (results.every((result) => result.path && !result.error)) setUrlInput("")
    } finally {
      setImporting(false)
    }
  }

  async function handleOpenSource(node: FileNode) {
    try {
      const content = await readFile(node.path)
      openFileInPreview(node.path, content)
    } catch (err) {
      console.error("Failed to read source:", err)
    }
  }

  async function handleOpenSourceExternally(node: FileNode) {
    if (!project) return
    try {
      await openPathInProject(project.path, node.path)
    } catch (err) {
      console.error("Failed to open source externally:", err)
      await appDialog.alert({ message: t("sources.openExternalFailed", {
        name: node.name,
        error: String(err),
      }) })
    }
  }

  async function handleDelete(node: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    // Confirmation now lives in the SourceTree component as a
    // two-stage button (click once = "Confirm", click again =
    // delete). Reaching this handler means the user has already
    // confirmed via the inline UI, so we proceed unconditionally.
    try {
      const result = await deleteSourceFile(pp, node.path)
      // Step 8: Refresh everything (UI side — must run with parent
      // context, hence kept here rather than inside the helper).
      await loadSources()
      await refreshProjectFileTree(pp, {
        projectId: project.id,
        bumpDataVersion: true,
      })
      if (
        selectedFile === node.path ||
        result.deletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete source:", err)
      await appDialog.alert({ message: `Failed to delete: ${err}` })
    }
  }

  /**
   * Recursive folder delete. Walks the folder tree, runs the
   * wiki-cascade for every individual file inside (so any
   * derived wiki pages, embeddings, log entries get cleaned up
   * the same way as a single-file delete), then removes the
   * folder itself with `deleteFile` — which dispatches to
   * `remove_dir_all` Rust-side, taking the now-empty (or near-
   * empty) directory tree with it including any leftover dotdir
   * cache files we didn't explicitly target.
   *
   * Errors on individual files are logged and skipped; the batch
   * keeps going so partial cleanup is preferred over an all-or-
   * nothing failure that leaves the tree half-deleted.
   */
  async function handleDeleteFolder(folder: FileNode) {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const result = await deleteSourceFolder(pp, folder)
      await loadSources()
      await refreshProjectFileTree(pp, {
        projectId: project.id,
        bumpDataVersion: true,
      })
      if (
        selectedFile?.startsWith(folder.path + "/") ||
        result.deletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete folder:", err)
      await appDialog.alert({ message: `Failed to delete folder: ${err}` })
    }
  }

  async function handleIngest(node: FileNode) {
    if (!project || ingestingPath) return
    // Re-ingest goes through the same automated queue path as a fresh
    // import (`handleImport` above). Earlier this used `startIngest`,
    // which opens an interactive chat → user clicks "Save to Wiki" →
    // `executeIngestWrites`. That had two problems: (a) it duplicated
    // the auto-pipeline so features like image cascade had to be
    // wired in twice, and (b) the interactive flow surprised users
    // who expected a fresh-import re-run. One button, one path now.
    setIngestingPath(node.path)
    try {
      await enqueueSourceIngest(project, [node.path], llmConfig)
    } catch (err) {
      console.error("Failed to enqueue ingest:", err)
    } finally {
      setIngestingPath(null)
    }
  }

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("sources.title")}</h2>
        <div className="flex gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleRefreshSources}
                  disabled={refreshing}
                  aria-label={t("sources.refreshFolder")}
                />
              }
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="max-w-80 whitespace-normal leading-relaxed">
              {t("sources.refreshFolderTooltip")}
            </TooltipContent>
          </Tooltip>
          <Button size="sm" onClick={handleImport} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {importing ? t("sources.importing") : t("sources.import")}
          </Button>
          <Button size="sm" onClick={handleImportFolder} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {t("sources.importFolder", "Folder")}
          </Button>
          <Button size="sm" onClick={() => setUrlDialogOpen(true)} disabled={importing}>
            <Link className="mr-1 h-4 w-4" />
            {t("sources.importUrls")}
          </Button>
        </div>
      </div>

      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("sources.urlImport.title")}</DialogTitle>
            <DialogDescription>{t("sources.urlImport.description")}</DialogDescription>
          </DialogHeader>
          <textarea
            className="min-h-44 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={urlInput}
            onChange={(event) => {
              setUrlInput(event.target.value)
              setUrlError(null)
              setUrlResults([])
            }}
            placeholder={t("sources.urlImport.placeholder")}
            disabled={importing}
          />
          {urlError && <p className="text-sm text-destructive">{urlError}</p>}
          {urlResults.length > 0 && (
            <div className="max-h-40 space-y-1 overflow-auto rounded-md border p-2 text-xs">
              {urlResults.map((result) => (
                <div key={result.url} className={result.error ? "text-destructive" : "text-muted-foreground"}>
                  <span className="break-all">{result.url}</span>
                  <span className="ml-2">{result.error ?? t("sources.urlImport.imported")}</span>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUrlDialogOpen(false)} disabled={importing}>
              {t("common.close")}
            </Button>
            <Button onClick={() => void handleImportUrls()} disabled={importing || !urlInput.trim()}>
              {importing ? t("sources.importing") : t("sources.urlImport.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {sources.length > 0 && (
        <div className="border-b px-4 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={sourceQuery}
              onChange={(event) => setSourceQuery(event.target.value)}
              placeholder={t("sources.searchPlaceholder")}
              aria-label={t("sources.searchPlaceholder")}
              className="h-8 pl-8 pr-8"
            />
            {sourceQuery && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2"
                onClick={() => setSourceQuery("")}
                aria-label={t("sources.clearSearch")}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        {refreshError && (
          <div className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {t("sources.refreshFailed", {
              defaultValue: "Failed to refresh sources: {{error}}",
              error: refreshError,
            })}
          </div>
        )}
        {importOutcome && (
          <div className="mx-4 mt-3 space-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">
                {importOutcome.error
                  ? t("sources.importSkip.failed", {
                      defaultValue: "Import failed: {{error}}",
                      error: importOutcome.error,
                    })
                  : t("sources.importSkip.summary", {
                      defaultValue: "Imported {{imported}}, skipped {{skipped}}",
                      imported: importOutcome.importedCount,
                      skipped: importOutcome.skipped.length,
                    })}
              </span>
              <button
                type="button"
                onClick={() => setImportOutcome(null)}
                className="shrink-0 rounded p-0.5 hover:bg-destructive/20"
                aria-label={t("common.dismiss", { defaultValue: "Dismiss" })}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {importOutcome.skipped
              .slice(0, showAllImportSkips ? undefined : IMPORT_SKIP_INITIAL_ROWS)
              .map((item, index) => (
                <div key={`${item.name}-${index}`} className="pl-1">
                  {item.name}
                  {": "}
                  {t(`sources.importSkip.reason.${item.reason}`, {
                    defaultValue: item.reason,
                  })}
                  {item.detail ? ` (${item.detail})` : ""}
                </div>
              ))}
            {importOutcome.skipped.length > IMPORT_SKIP_INITIAL_ROWS && (
              <button
                type="button"
                className="pl-1 font-medium underline underline-offset-2"
                onClick={() => setShowAllImportSkips((current) => !current)}
              >
                {showAllImportSkips
                  ? t("sources.importSkip.showLess")
                  : t("sources.importSkip.showRemaining", {
                      count: importOutcome.skipped.length - IMPORT_SKIP_INITIAL_ROWS,
                    })}
              </button>
            )}
          </div>
        )}
        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <p>{t("sources.noSources")}</p>
            <p>{t("sources.importHint")}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleImport}>
                <Plus className="mr-1 h-4 w-4" />
                {t("sources.importFiles")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleImportFolder}>
                <Plus className="mr-1 h-4 w-4" />
                {t("sources.importFolder")}
              </Button>
            </div>
          </div>
        ) : filteredSources.length === 0 ? (
          <div className="flex h-32 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t("sources.noSearchResults", { query: sourceQuery.trim() })}
          </div>
        ) : (
          <div className="p-2">
            <SourceTree
              nodes={filteredSources}
              onOpen={handleOpenSource}
              onOpenExternal={handleOpenSourceExternally}
              onIngest={handleIngest}
              onDelete={handleDelete}
              onDeleteFolder={handleDeleteFolder}
              pendingDeletePath={pendingDeletePath}
              setPendingDeletePath={setPendingDeletePath}
              ingestingPath={ingestingPath}
              sourceStatuses={sourceStatuses}
              forceExpanded={Boolean(sourceQuery.trim())}
            />
          </div>
        )}
      </ScrollArea>

      <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          {sourceQuery.trim()
            ? t("sources.filteredSourceCount", {
                count: filteredSourceCount,
                total: totalSourceCount,
              })
            : t("sources.sourceCount", { count: totalSourceCount })}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefreshSources}
                disabled={!project || refreshing}
                className="h-7 px-2 text-xs"
              />
            }
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? t("sources.refreshingFolder") : t("sources.refreshFolder")}
          </TooltipTrigger>
          <TooltipContent side="top" align="end" className="max-w-80 whitespace-normal leading-relaxed">
            {t("sources.refreshFolderTooltip")}
          </TooltipContent>
        </Tooltip>
      </div>
      </div>
    </TooltipProvider>
  )
}

interface SourceTreeRow {
  node: FileNode
  depth: number
}

function countFiles(nodes: FileNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      count += countFiles(node.children)
    } else if (!node.is_dir) {
      count++
    }
  }
  return count
}

export interface ImportOutcome {
  importedCount: number
  skipped: SkippedSourceImport[]
  error: string | null
}

/**
 * Decides whether an import needs to say anything to the user.
 * A clean import stays quiet; anything skipped or thrown gets reported.
 */
export function summarizeImportOutcome(
  result: SourceImportResult | null,
  error: unknown,
): ImportOutcome | null {
  if (error) {
    return {
      importedCount: result?.imported.length ?? 0,
      skipped: result?.skipped ?? [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!result || result.skipped.length === 0) return null
  return { importedCount: result.imported.length, skipped: result.skipped, error: null }
}

export function filterSourceTreeByQuery(
  nodes: readonly FileNode[],
  query: string,
): FileNode[] {
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase()
  if (!needle) return [...nodes]

  const visit = (node: FileNode): FileNode | null => {
    const haystack = `${node.name}\n${normalizePath(node.path)}`
      .normalize("NFKC")
      .toLocaleLowerCase()
    if (haystack.includes(needle)) return node
    if (!node.is_dir || !node.children) return null
    const children = node.children
      .map(visit)
      .filter((child): child is FileNode => child !== null)
    return children.length > 0 ? { ...node, children } : null
  }

  return nodes.map(visit).filter((node): node is FileNode => node !== null)
}

function sortSourceNodes(nodes: readonly FileNode[]): FileNode[] {
  return sortFileNodes(nodes)
}

function flattenVisibleRows(
  nodes: readonly FileNode[],
  collapsed: Record<string, boolean>,
  depth = 0,
): SourceTreeRow[] {
  const rows: SourceTreeRow[] = []
  for (const node of sortSourceNodes(nodes)) {
    rows.push({ node, depth })
    if (node.is_dir && node.children && !(collapsed[node.path] ?? false)) {
      rows.push(...flattenVisibleRows(node.children, collapsed, depth + 1))
    }
  }
  return rows
}

function SourceTree({
  nodes,
  onOpen,
  onOpenExternal,
  onIngest,
  onDelete,
  onDeleteFolder,
  pendingDeletePath,
  setPendingDeletePath,
  ingestingPath,
  sourceStatuses,
  forceExpanded,
}: {
  nodes: FileNode[]
  onOpen: (node: FileNode) => void
  onOpenExternal: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  onDeleteFolder: (node: FileNode) => void
  /** Path of the node currently in "click again to confirm" state.
   *  Lifted to the parent so only ONE button is armed at a time
   *  across the whole tree — clicking another delete arms that one
   *  and disarms the previous. */
  pendingDeletePath: string | null
  setPendingDeletePath: (path: string | null) => void
  ingestingPath: string | null
  sourceStatuses: ReadonlyMap<string, SourceIngestStatus>
  forceExpanded: boolean
}) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [visibleLimit, setVisibleLimit] = useState(SOURCE_TREE_INITIAL_ROWS)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const rows = useMemo(
    () => flattenVisibleRows(nodes, forceExpanded ? {} : collapsed),
    [collapsed, forceExpanded, nodes],
  )
  const visibleRows = rows.slice(0, visibleLimit)
  const hasMore = visibleLimit < rows.length

  useEffect(() => {
    setVisibleLimit(SOURCE_TREE_INITIAL_ROWS)
  }, [nodes])

  useEffect(() => {
    if (!hasMore) return
    const target = loadMoreRef.current
    if (!target) return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisibleLimit((current) => Math.min(current + SOURCE_TREE_LOAD_BATCH, rows.length))
    }, { rootMargin: "240px 0px" })

    observer.observe(target)
    return () => observer.disconnect()
  }, [hasMore, rows.length])

  const toggle = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  /**
   * Two-stage delete handler. Decision logic lives in
   * `decideDeleteClick` (pure, unit-tested in
   * `sources-tree-delete.test.ts`); this wrapper just dispatches
   * the resulting action onto the React state + handler props.
   */
  const handleDeleteClick = (node: FileNode) => {
    const action = decideDeleteClick(pendingDeletePath, node)
    switch (action.kind) {
      case "arm":
        setPendingDeletePath(action.path)
        return
      case "fire-file":
        setPendingDeletePath(null)
        onDelete(action.node)
        return
      case "fire-folder":
        setPendingDeletePath(null)
        onDeleteFolder(action.node)
        return
    }
  }

  return (
    <>
      {visibleRows.map(({ node, depth }) => {
        const isPendingDelete = pendingDeletePath === node.path
        const ingestStatus = sourceStatuses.get(normalizePath(node.path)) ?? "not-ingested"
        if (node.is_dir && node.children) {
          const isCollapsed = !forceExpanded && (collapsed[node.path] ?? false)
          return (
            <div key={node.path}>
              <div
                className="group flex w-full items-center gap-1 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
              >
                <button
                  onClick={() => {
                    if (!forceExpanded) toggle(node.path)
                  }}
                  className="flex flex-1 items-center gap-1.5 px-1 py-1 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                  <span className="truncate font-medium">{node.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">
                    {countFiles(node.children)}
                  </span>
                </button>
                <DeleteButton
                  isPending={isPendingDelete}
                  onClick={() => handleDeleteClick(node)}
                  hint={
                    isPendingDelete
                      ? t("sources.deleteFolderConfirm", { name: node.name })
                      : t("sources.deleteFolder", { name: node.name })
                  }
                />
              </div>
            </div>
          )
        }

        return (
          <div
            key={node.path}
            className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
          >
            <button
              onClick={() => onOpen(node)}
              className="flex flex-1 items-center gap-2 truncate px-2 py-1 text-left"
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{node.name}</span>
              <span
                className={
                  ingestStatus === "failed"
                    ? "shrink-0 text-[10px] text-destructive"
                    : ingestStatus === "processing"
                      ? "shrink-0 text-[10px] text-primary"
                      : "shrink-0 text-[10px] text-muted-foreground"
                }
              >
                {t(`sources.ingestStatus.${ingestStatus}`)}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title={t("sources.openExternal")}
              aria-label={t("sources.openExternal")}
              onClick={() => onOpenExternal(node)}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title={t("sources.ingest")}
              disabled={
                ingestingPath === node.path ||
                ingestStatus === "pending" ||
                ingestStatus === "processing"
              }
              onClick={() => onIngest(node)}
            >
              <BookOpen className="h-4 w-4" />
            </Button>
            <DeleteButton
              isPending={isPendingDelete}
              onClick={() => handleDeleteClick(node)}
              hint={
                isPendingDelete
                  ? t("sources.deleteFileConfirm", { name: node.name })
                  : t("sources.deleteFile", { name: node.name })
              }
            />
          </div>
        )
      })}
      {hasMore && (
        <div
          ref={loadMoreRef}
          className="px-3 py-2 text-center text-[11px] text-muted-foreground"
        >
          {t("sources.loadingMore")}
        </div>
      )}
    </>
  )
}

/**
 * Two-stage delete button. Default = ghost trash icon (subtle).
 * Armed = solid red "Confirm" pill with the icon — visually
 * unmistakable, so the user can't miss the second-click warning.
 *
 * Same component is used for both files and folders; the parent
 * decides which delete handler to call from the click. The pending
 * state is owned by SourceTree (lifted to its parent SourcesView)
 * so only one button is armed across the entire tree at a time.
 */
function DeleteButton({
  isPending,
  onClick,
  hint,
}: {
  isPending: boolean
  onClick: () => void
  hint: string
}) {
  const { t } = useTranslation()
  if (isPending) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className="h-7 shrink-0 px-2 text-[11px] font-semibold animate-pulse"
        title={hint}
        onClick={onClick}
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" />
        {t("sources.confirm")}
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
      title={hint}
      onClick={onClick}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  )
}
