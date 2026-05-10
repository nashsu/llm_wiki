import { useState, useEffect, useCallback } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { Plus, FileText, RefreshCw, BookOpen, Trash2, Folder, ChevronRight, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import {
  copyFile,
  createDirectory,
  fileExists,
  listDirectory,
  readFile,
  writeFile,
  deleteFile,
  findRelatedWikiPages,
  preprocessFile,
} from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { enqueueIngest, enqueueBatch } from "@/lib/ingest-queue"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { useTranslation } from "react-i18next"
import { normalizePath, getFileName } from "@/lib/path-utils"
import { parseSources, writeSources } from "@/lib/sources-merge"
import { decidePageFate } from "@/lib/source-delete-decision"
import { removeFromIngestCache } from "@/lib/ingest-cache"
import { appendLogContent } from "@/lib/log-append"
import {
  collectAllFilesIncludingDot,
  decideDeleteClick,
} from "@/lib/sources-tree-delete"
import { buildRawDocumentNamePlan, buildRawFolderName } from "@/lib/wiki-title"

export function SourcesView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [sources, setSources] = useState<FileNode[]>([])
  const [importing, setImporting] = useState(false)
  const [ingestingPath, setIngestingPath] = useState<string | null>(null)
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
      const tree = await listDirectory(`${pp}/raw/sources`)
      // Filter out hidden files/dirs and cache
      const filtered = filterTree(tree)
      setSources(filtered)
    } catch {
      setSources([])
    }
  }, [project])

  useEffect(() => {
    loadSources()
  }, [loadSources])

  async function handleImport() {
    if (!project) return

    const selected = await open({
      multiple: true,
      title: "Import Source Files",
      filters: [
        {
          name: "Documents",
          extensions: [
            "md", "mdx", "txt", "rtf", "pdf",
            "html", "htm", "xml",
            "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "odt", "ods", "odp", "epub", "pages", "numbers", "key",
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
    const pp = normalizePath(project.path)
    const paths = Array.isArray(selected) ? selected : [selected]

    const importedPaths: string[] = []
    for (const sourcePath of paths) {
      const originalName = getFileName(sourcePath) || "unknown"
      const titleSeed = await readImportTitleSeed(sourcePath, originalName)
      const rawNamePlan = buildRawDocumentNamePlan(originalName, titleSeed)
      const destPath = await getUniqueDestPath(`${pp}/raw/sources`, rawNamePlan.fileName)
      try {
        await copyFile(sourcePath, destPath)
        importedPaths.push(destPath)
        // Pre-process file (extract text from PDF, etc.) for instant preview later
        preprocessFile(destPath).catch(() => {})
      } catch (err) {
        console.error(`Failed to import ${originalName}:`, err)
      }
    }

    setImporting(false)
    await loadSources()

    // Enqueue for serial ingest (runs in background via ingest queue)
    if (hasUsableLlm(llmConfig)) {
      for (const destPath of importedPaths) {
        enqueueIngest(project.id, destPath).catch((err) =>
          console.error(`Failed to enqueue ingest:`, err)
        )
      }
    }
  }

  async function handleImportFolder() {
    if (!project) return

    const selected = await open({
      directory: true,
      title: "Import Source Folder",
    })

    if (!selected || typeof selected !== "string") return

    setImporting(true)
    const pp = normalizePath(project.path)
    const folderName = buildRawFolderName(getFileName(selected) || "imported")
    const destDir = await getUniqueDirectoryPath(`${pp}/raw/sources`, folderName)

    try {
      const copiedFiles = await copyDirectoryWithNormalizedNames(selected, destDir)
      const contextRoot = getFileName(destDir) || folderName

      console.log(`[Folder Import] Copied ${copiedFiles.length} files from ${contextRoot}`)

      // Preprocess all files
      for (const filePath of copiedFiles) {
        preprocessFile(filePath).catch(() => {})
      }

      setImporting(false)
      await loadSources()

      // Build ingest tasks with folder context
      if (hasUsableLlm(llmConfig)) {
        const tasks = copiedFiles
          .filter((fp) => {
            const ext = fp.split(".").pop()?.toLowerCase() ?? ""
            // Only ingest text-based files, skip images/media
            return ["md", "mdx", "txt", "pdf", "docx", "pptx", "xlsx", "xls",
                    "csv", "json", "html", "htm", "rtf", "xml", "yaml", "yml"].includes(ext)
          })
          .map((filePath) => {
            // Build folder context from relative path. On Windows the
            // Rust-returned filePath uses backslashes while destDir was
            // composed with forward slashes — normalize both sides before
            // the replace so this works on every platform.
            const normFilePath = normalizePath(filePath)
            const normDestDir = normalizePath(destDir)
            const relPath = normFilePath.replace(normDestDir + "/", "")
            const parts = relPath.split("/")
            parts.pop() // remove filename
            const context = parts.length > 0
              ? `${contextRoot} > ${parts.join(" > ")}`
              : contextRoot
            return { sourcePath: filePath, folderContext: context }
          })

        if (tasks.length > 0) {
          await enqueueBatch(project.id, tasks)
          console.log(`[Folder Import] Enqueued ${tasks.length} files for ingest`)
        }
      }
    } catch (err) {
      console.error(`Failed to import folder:`, err)
      setImporting(false)
    }
  }

  async function handleOpenSource(node: FileNode) {
    setSelectedFile(node.path)
    try {
      const content = await readFile(node.path)
      setFileContent(content)
    } catch (err) {
      console.error("Failed to read source:", err)
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
      const result = await deleteSourceWithCascade(pp, node)
      // Step 8: Refresh everything (UI side — must run with parent
      // context, hence kept here rather than inside the helper).
      await loadSources()
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
      if (
        selectedFile === node.path ||
        result.deletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete source:", err)
      window.alert(`Failed to delete: ${err}`)
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
      const allFiles = collectAllFilesIncludingDot(folder)
      const allDeletedWikiPaths: string[] = []
      for (const file of allFiles) {
        try {
          const r = await deleteSourceWithCascade(pp, file)
          allDeletedWikiPaths.push(...r.deletedWikiPaths)
        } catch (err) {
          console.warn(`Failed to delete ${file.path} during folder delete:`, err)
        }
      }
      // Now remove the folder (and any leftover empty subdirs / dot
      // cache dirs) in one shot. Files we just deleted above are
      // gone; this call mostly tears down empty directories.
      try {
        await deleteFile(folder.path)
      } catch (err) {
        console.warn(`Failed to remove folder ${folder.path}:`, err)
      }
      await loadSources()
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
      if (
        selectedFile?.startsWith(folder.path + "/") ||
        allDeletedWikiPaths.includes(selectedFile ?? "")
      ) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete folder:", err)
      window.alert(`Failed to delete folder: ${err}`)
    }
  }

  /**
   * Per-file deletion: the wiki cascade portion (steps 1-7 of the
   * old handleDelete), without the confirmation dialog or the
   * UI-state refresh (callers do those once at the end of a batch).
   *
   * Returns the wiki page paths we actually removed so the caller
   * can reset selectedFile if one of them was open.
   */
  async function deleteSourceWithCascade(
    pp: string,
    node: FileNode,
  ): Promise<{ deletedWikiPaths: string[] }> {
    const fileName = node.name
    // Step 1: Find related wiki pages before deleting
    const relatedPages = await findRelatedWikiPages(pp, fileName)

    // Step 2: Delete the source file
    await deleteFile(node.path)

    // Step 3: Delete preprocessed cache
    try {
      await deleteFile(`${pp}/raw/sources/.cache/${fileName}.txt`)
    } catch {
      // cache file may not exist
    }

      // Step 4: For each page that findRelatedWikiPages surfaced,
      // consult decidePageFate to pick one of three actions:
      //
      //   keep   — page has OTHER sources too; just drop this one from
      //            its sources[] list and rewrite.
      //   delete — this was the page's sole source; remove the page
      //            and record { slug, title } so downstream cleanup
      //            can wipe every stale reference to it.
      //   skip   — the page's sources[] doesn't actually include the
      //            file being deleted. Must have been surfaced by the
      //            Rust findRelatedWikiPages loose-match path (fs.rs
      //            Strategy 3 — substring of title / description /
      //            elsewhere in the frontmatter). Leaving the page
      //            alone prevents silent data loss when a filename
      //            happens to appear in an unrelated page's metadata.
      // Pass 1: keep / skip — rewrite sources for shared pages, no
      // deletion needed. The "delete" decisions are deferred to a
      // single batch call after the loop so we can route them
      // through the unified cascade helper.
      const pagesToDelete: string[] = []
      for (const pagePath of relatedPages) {
        try {
          const content = await readFile(pagePath)
          const sourcesList = parseSources(content)
          const decision = decidePageFate(sourcesList, fileName)

          if (decision.action === "skip") {
            // Nothing to do — page isn't really derived from this source.
            continue
          }

          if (decision.action === "keep") {
            // Multi-source page — rewrite sources with the deleted one
            // filtered out. writeSources preserves every other
            // frontmatter field and position.
            const updated = writeSources(content, decision.updatedSources)
            await writeFile(pagePath, updated)
            continue
          }

          // action === "delete" → defer.
          pagesToDelete.push(pagePath)
        } catch (err) {
          console.error(`Failed to process wiki page ${pagePath}:`, err)
        }
      }

      // Pass 2: full cascade for every page whose sole source was
      // this file. The helper deletes the file + drops embeddings
      // + sweeps every other wiki .md to clean stale body
      // wikilinks, index.md listings, AND `related:` frontmatter
      // arrays. The previous inline cleanup loop did 1 and 2 but
      // left `related:` slugs pointing at deleted pages, which
      // FrontmatterPanel renders as a broken-ref warning icon.
      const { cascadeDeleteWikiPagesWithRefs } = await import(
        "@/lib/wiki-page-delete"
      )
      const cascadeResult =
        pagesToDelete.length > 0
          ? await cascadeDeleteWikiPagesWithRefs(pp, pagesToDelete)
          : { deletedPaths: [], rewrittenFiles: 0 }
      const actuallyDeleted = cascadeResult.deletedPaths

    // Step 7: Append deletion record to log.md
    try {
      const logPath = `${pp}/wiki/log.md`
      const logContent = await readFile(logPath).catch(() => "# Wiki Log\n")
      const date = new Date().toISOString().slice(0, 10)
      const keptCount = relatedPages.length - actuallyDeleted.length
      const logEntry = `\n## [${date}] delete | ${fileName}\n\nDeleted source file and ${actuallyDeleted.length} wiki pages.${keptCount > 0 ? ` ${keptCount} shared pages kept (have other sources).` : ""}\n`
      await writeFile(logPath, appendLogContent(logContent, logEntry))
    } catch {
      // non-critical
    }

    // Step 8: Drop the source's ingest-cache entry so a future
    // re-import doesn't hit a stale "already ingested" record.
    // The cache's existence-check fallback would have caught this
    // anyway (it falls through to re-ingest when wiki/sources/<slug>.md
    // is gone), but removing the entry up front keeps the cache
    // file small and avoids confusing log lines like "cache miss
    // for foo.pdf: wiki/sources/foo.md no longer on disk" on
    // every search after a delete.
    try {
      await removeFromIngestCache(pp, fileName)
    } catch {
      // non-critical
    }

    return { deletedWikiPaths: actuallyDeleted }
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
      await enqueueIngest(project.id, node.path)
    } catch (err) {
      console.error("Failed to enqueue ingest:", err)
    } finally {
      setIngestingPath(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t("sources.title")}</h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={loadSources} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={handleImport} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {importing ? t("sources.importing") : t("sources.import")}
          </Button>
          <Button size="sm" onClick={handleImportFolder} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {t("sources.importFolder", "Folder")}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
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
                Folder
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-2">
            <SourceTree
              nodes={sources}
              onOpen={handleOpenSource}
              onIngest={handleIngest}
              onDelete={handleDelete}
              onDeleteFolder={handleDeleteFolder}
              pendingDeletePath={pendingDeletePath}
              setPendingDeletePath={setPendingDeletePath}
              ingestingPath={ingestingPath}
              depth={0}
            />
          </div>
        )}
      </ScrollArea>

      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        {t("sources.sourceCount", { count: countFiles(sources) })}
      </div>
    </div>
  )
}

/**
 * Generate a unique destination path. If file already exists, adds date/counter suffix.
 * "file.pdf" → "file.pdf" (first time)
 * "file.pdf" → "file-20260406.pdf" (conflict)
 * "file.pdf" → "file-20260406-2.pdf" (second conflict same day)
 */
async function getUniqueDestPath(dir: string, fileName: string): Promise<string> {
  const basePath = `${dir}/${fileName}`

  // Check if file exists by trying to read it
  try {
    await readFile(basePath)
  } catch {
    // File doesn't exist — use original name
    return basePath
  }

  // File exists — add date suffix
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ""
  const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")

  const withDate = `${dir}/${nameWithoutExt}-${date}${ext}`
  try {
    await readFile(withDate)
  } catch {
    return withDate
  }

  // Date suffix also exists — add counter
  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${nameWithoutExt}-${date}-${i}${ext}`
    try {
      await readFile(withCounter)
    } catch {
      return withCounter
    }
  }

  // Shouldn't happen, but fallback
  return `${dir}/${nameWithoutExt}-${date}-${Date.now()}${ext}`
}

const TITLE_SEED_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "html",
  "htm",
  "xml",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "ndjson",
])

async function readImportTitleSeed(path: string, fileName: string): Promise<string> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""
  if (!TITLE_SEED_EXTENSIONS.has(ext)) return ""
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

async function getUniqueDirectoryPath(dir: string, folderName: string): Promise<string> {
  const basePath = `${dir}/${folderName}`
  if (!(await fileExists(basePath))) return basePath

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const withDate = `${dir}/${folderName}-${date}`
  if (!(await fileExists(withDate))) return withDate

  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${folderName}-${date}-${i}`
    if (!(await fileExists(withCounter))) return withCounter
  }

  return `${dir}/${folderName}-${date}-${Date.now()}`
}

async function copyDirectoryWithNormalizedNames(sourceDir: string, destDir: string): Promise<string[]> {
  await createDirectory(destDir)
  const nodes = await listDirectory(sourceDir)
  const copiedFiles: string[] = []
  await copyTreeNodesWithNormalizedNames(nodes, destDir, copiedFiles)
  return copiedFiles
}

async function copyTreeNodesWithNormalizedNames(
  nodes: FileNode[],
  destDir: string,
  copiedFiles: string[],
): Promise<void> {
  for (const node of nodes) {
    if (node.is_dir) {
      const folderName = buildRawFolderName(node.name)
      const childDestDir = await getUniqueDirectoryPath(destDir, folderName)
      await createDirectory(childDestDir)
      await copyTreeNodesWithNormalizedNames(node.children ?? [], childDestDir, copiedFiles)
      continue
    }

    const titleSeed = await readImportTitleSeed(node.path, node.name)
    const rawNamePlan = buildRawDocumentNamePlan(node.name, titleSeed)
    const destPath = await getUniqueDestPath(destDir, rawNamePlan.fileName)
    await copyFile(node.path, destPath)
    copiedFiles.push(destPath)
  }
}

function filterTree(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter((n) => !n.name.startsWith("."))
    .map((n) => {
      if (n.is_dir && n.children) {
        return { ...n, children: filterTree(n.children) }
      }
      return n
    })
    .filter((n) => !n.is_dir || (n.children && n.children.length > 0))
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


function SourceTree({
  nodes,
  onOpen,
  onIngest,
  onDelete,
  onDeleteFolder,
  pendingDeletePath,
  setPendingDeletePath,
  ingestingPath,
  depth,
}: {
  nodes: FileNode[]
  onOpen: (node: FileNode) => void
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
  depth: number
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

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

  // Sort: folders first, then files, alphabetical within each group
  const sorted = [...nodes].sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1
    if (!a.is_dir && b.is_dir) return 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      {sorted.map((node) => {
        const isPendingDelete = pendingDeletePath === node.path
        if (node.is_dir && node.children) {
          const isCollapsed = collapsed[node.path] ?? false
          return (
            <div key={node.path}>
              <div
                className="group flex w-full items-center gap-1 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
              >
                <button
                  onClick={() => toggle(node.path)}
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
                      ? `Click again to delete folder ${node.name} and ALL its contents`
                      : `Delete folder ${node.name} (recursive)`
                  }
                />
              </div>
              {!isCollapsed && (
                <SourceTree
                  nodes={node.children}
                  onOpen={onOpen}
                  onIngest={onIngest}
                  onDelete={onDelete}
                  onDeleteFolder={onDeleteFolder}
                  pendingDeletePath={pendingDeletePath}
                  setPendingDeletePath={setPendingDeletePath}
                  ingestingPath={ingestingPath}
                  depth={depth + 1}
                />
              )}
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
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              title="Ingest"
              disabled={ingestingPath === node.path}
              onClick={() => onIngest(node)}
            >
              <BookOpen className="h-4 w-4" />
            </Button>
            <DeleteButton
              isPending={isPendingDelete}
              onClick={() => handleDeleteClick(node)}
              hint={
                isPendingDelete
                  ? `Click again to delete ${node.name}`
                  : `Delete ${node.name}`
              }
            />
          </div>
        )
      })}
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
        Confirm
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
