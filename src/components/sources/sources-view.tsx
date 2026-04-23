import { useState, useEffect, useCallback } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import { Plus, FileText, RefreshCw, BookOpen, Trash2, Folder, ChevronRight, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { copyFile, listDirectory, readFile, writeFile, deleteFile, findRelatedWikiPages, preprocessFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { startIngest } from "@/lib/ingest"
import { enqueueIngest, enqueueBatch } from "@/lib/ingest-queue"
import { useTranslation } from "react-i18next"
import { normalizePath, getFileName } from "@/lib/path-utils"
import {
  buildDeletedKeys,
  cleanIndexListing,
  stripDeletedWikilinks,
  extractFrontmatterTitle,
  type DeletedPageInfo,
} from "@/lib/wiki-cleanup"
import { parseSources, writeSources } from "@/lib/sources-merge"
import { decidePageFate } from "@/lib/source-delete-decision"

export function SourcesView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setChatExpanded = useWikiStore((s) => s.setChatExpanded)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [sources, setSources] = useState<FileNode[]>([])
  const [importing, setImporting] = useState(false)
  const [ingestingPath, setIngestingPath] = useState<string | null>(null)

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
      const destPath = await getUniqueDestPath(`${pp}/raw/sources`, originalName)
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
    if (llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom") {
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
    const folderName = getFileName(selected) || "imported"
    const destDir = `${pp}/raw/sources/${folderName}`

    try {
      // Recursively copy the folder
      const copiedFiles: string[] = await invoke("copy_directory", {
        source: selected,
        destination: destDir,
      })

      console.log(`[Folder Import] Copied ${copiedFiles.length} files from ${folderName}`)

      // Preprocess all files
      for (const filePath of copiedFiles) {
        preprocessFile(filePath).catch(() => {})
      }

      setImporting(false)
      await loadSources()

      // Build ingest tasks with folder context
      if (llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom") {
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
              ? `${folderName} > ${parts.join(" > ")}`
              : folderName
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
    const fileName = node.name
    const confirmed = window.confirm(
      t("sources.deleteConfirm", { name: fileName })
    )
    if (!confirmed) return

    try {
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
      const actuallyDeleted: string[] = []
      const deletedInfos: DeletedPageInfo[] = []
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

          // action === "delete": the page's sole source was this file.
          // Capture slug + title before deletion so stale references
          // can be cleaned from index / overview / sibling pages.
          const slug = getFileName(pagePath).replace(/\.md$/, "")
          const title = extractFrontmatterTitle(content)
          deletedInfos.push({ slug, title })
          await deleteFile(pagePath)
          actuallyDeleted.push(pagePath)
        } catch (err) {
          console.error(`Failed to process wiki page ${pagePath}:`, err)
        }
      }

      // Steps 5 & 6: clean stale references from every wiki file.
      //
      // index.md  → drop list-item lines whose primary `[[target]]` is
      //             a deleted page (title OR slug form matches).
      // overview.md + everything else → strip `[[deleted]]` occurrences
      //             in prose, replacing them with plain text (or with
      //             the pipe display when present).
      //
      // Using normalized-key matching rather than the old substring
      // `includes` check avoids two classes of real bugs: stale
      // title-form refs surviving (`[[KV Cache]]` vs slug `kv-cache`),
      // and innocent siblings getting wiped collaterally (deleting
      // `ai.md` must not take `[[OpenAI]]` / `[[AI Safety]]` down).
      const deletedKeys = buildDeletedKeys(deletedInfos)
      if (deletedKeys.size > 0) {
        try {
          const wikiTree = await listDirectory(`${pp}/wiki`)
          const allMdFiles = flattenMdFiles(wikiTree)
          for (const file of allMdFiles) {
            try {
              const content = await readFile(file.path)
              const isIndex = file.path === `${pp}/wiki/index.md` ||
                file.name === "index.md"
              // For index: first drop whole entry lines for deleted
              // pages, then still strip any secondary `[[...]]` refs
              // to deleted pages that may appear in surviving rows.
              const afterListing = isIndex
                ? cleanIndexListing(content, deletedKeys)
                : content
              const updated = stripDeletedWikilinks(afterListing, deletedKeys)
              if (updated !== content) {
                await writeFile(file.path, updated)
              }
            } catch {
              // skip individual file failures — best-effort cleanup
            }
          }
        } catch {
          // non-critical
        }
      }

      // Step 7: Append deletion record to log.md
      try {
        const logPath = `${pp}/wiki/log.md`
        const logContent = await readFile(logPath).catch(() => "# Wiki Log\n")
        const date = new Date().toISOString().slice(0, 10)
        const keptCount = relatedPages.length - actuallyDeleted.length
        const logEntry = `\n## [${date}] delete | ${fileName}\n\nDeleted source file and ${actuallyDeleted.length} wiki pages.${keptCount > 0 ? ` ${keptCount} shared pages kept (have other sources).` : ""}\n`
        await writeFile(logPath, logContent.trimEnd() + logEntry)
      } catch {
        // non-critical
      }

      // Step 8: Refresh everything
      await loadSources()
      const tree = await listDirectory(pp)
      setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()

      // Clear selected file if it was the deleted one
      if (selectedFile === node.path || actuallyDeleted.includes(selectedFile ?? "")) {
        setSelectedFile(null)
      }
    } catch (err) {
      console.error("Failed to delete source:", err)
      window.alert(`Failed to delete: ${err}`)
    }
  }

  async function handleIngest(node: FileNode) {
    if (!project || ingestingPath) return
    setIngestingPath(node.path)
    try {
      setChatExpanded(true)
      setActiveView("wiki")
      await startIngest(normalizePath(project.path), node.path, llmConfig)
    } catch (err) {
      console.error("Failed to start ingest:", err)
    } finally {
      setIngestingPath(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
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

      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
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
  ingestingPath,
  depth,
}: {
  nodes: FileNode[]
  onOpen: (node: FileNode) => void
  onIngest: (node: FileNode) => void
  onDelete: (node: FileNode) => void
  ingestingPath: string | null
  depth: number
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = (path: string) => {
    setCollapsed((prev) => ({ ...prev, [path]: !prev[path] }))
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
        if (node.is_dir && node.children) {
          const isCollapsed = collapsed[node.path] ?? false
          return (
            <div key={node.path}>
              <button
                onClick={() => toggle(node.path)}
                className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                style={{ paddingLeft: `${depth * 16 + 4}px` }}
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
              {!isCollapsed && (
                <SourceTree
                  nodes={node.children}
                  onOpen={onOpen}
                  onIngest={onIngest}
                  onDelete={onDelete}
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
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
              title="Delete"
              onClick={() => onDelete(node)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )
      })}
    </>
  )
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}
