import { useEffect, useCallback, useRef, useState } from "react"
import { MoreHorizontal, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary, isExtractedTextPreviewFile } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { getFileName } from "@/lib/path-utils"

export function PreviewPanel() {
  const { t } = useTranslation()
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const previewContentPath = useWikiStore((s) => s.previewContentPath)
  const externalPreview = useWikiStore((s) => s.externalPreview)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const closePreview = useWikiStore((s) => s.closePreview)
  const recentPreviewPaths = useWikiStore((s) => s.recentPreviewPaths)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)
  const closePreviewTab = useWikiStore((s) => s.closePreviewTab)
  const closeOtherPreviewTabs = useWikiStore((s) => s.closeOtherPreviewTabs)
  const closeAllPreviewTabs = useWikiStore((s) => s.closeAllPreviewTabs)
  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Snapshot of what was most recently loaded from disk. Milkdown re-emits
  // `markdownUpdated` on initial parse (before the user types anything),
  // which used to trigger an auto-save that could write back a placeholder
  // marker if read_file had returned one for a missing/locked file. We
  // skip save when the incoming markdown equals the last-loaded content.
  const lastLoadedRef = useRef<string>("")

  useEffect(() => {
    if (!selectedFile) {
      setFileContent("")
      lastLoadedRef.current = ""
      return
    }
    if (previewContentPath === selectedFile) {
      lastLoadedRef.current = fileContent
      return
    }
    if (externalPreview?.path === selectedFile) {
      lastLoadedRef.current = fileContent
      return
    }

    const category = getFileCategory(selectedFile)

    if (isBinary(category) && !isExtractedTextPreviewFile(selectedFile)) {
      setFileContent("")
      lastLoadedRef.current = ""
      return
    }

    readFile(selectedFile)
      .then((content) => {
        lastLoadedRef.current = content
        setFileContent(content)
      })
      .catch((err) => {
        lastLoadedRef.current = ""
        setFileContent(`Error loading file: ${err}`)
      })
  }, [selectedFile, previewContentPath, externalPreview, setFileContent])

  const writeNow = useCallback((path: string, markdown: string, syncStore = false) => {
    writeFile(path, markdown)
      .then(() => {
        lastLoadedRef.current = markdown
        if (syncStore) setFileContent(markdown)
      })
      .catch((err) => console.error("Failed to save:", err))
  }, [setFileContent])

  const handleSave = useCallback(
    (markdown: string, options?: { immediate?: boolean }) => {
      if (!selectedFile) return
      // Ignore no-op saves from the editor's initial re-emit. Only write
      // when the user has actually changed the content relative to the
      // last disk read.
      if (markdown === lastLoadedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (options?.immediate) {
        setFileContent(markdown)
        writeNow(selectedFile, markdown, true)
        return
      }
      saveTimerRef.current = setTimeout(() => {
        writeNow(selectedFile, markdown, true)
      }, 1000)
    },
    [selectedFile, setFileContent, writeNow]
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  // 关闭单个标签：关的是当前文件则切到相邻标签（原位置右侧优先，否则左侧）；
  // 没有相邻标签则关闭整个预览。
  const handleCloseTab = useCallback((path: string) => {
    const before = useWikiStore.getState().recentPreviewPaths
    const index = before.indexOf(path)
    const remaining = before.filter((p) => p !== path)
    closePreviewTab(path)
    if (path === useWikiStore.getState().selectedFile) {
      const next = remaining[index] ?? remaining[index - 1] ?? null
      if (next) openPathInPreview(next)
      else closePreview()
    }
  }, [closePreviewTab, openPathInPreview, closePreview])

  const handleCloseOtherTabs = useCallback((path: string) => {
    closeOtherPreviewTabs(path)
    if (useWikiStore.getState().selectedFile !== path) openPathInPreview(path)
  }, [closeOtherPreviewTabs, openPathInPreview])

  const handleCloseAllTabs = useCallback(() => {
    closeAllPreviewTabs()
    closePreview()
  }, [closeAllPreviewTabs, closePreview])

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file to preview
      </div>
    )
  }

  const category = getFileCategory(selectedFile)
  const fileName = externalPreview?.path === selectedFile
    ? externalPreview.title
    : getFileName(selectedFile)

  return (
    <div className="flex h-full flex-col">
      {recentPreviewPaths.length > 0 && (
        <div className="flex items-center border-b bg-muted/20 px-1 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {recentPreviewPaths.map((path) => {
            const isActive = path === selectedFile
            return (
              <div
                key={path}
                className={`group flex max-w-[160px] shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs ${
                  isActive
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
                onClick={() => {
                  if (!isActive) openPathInPreview(path)
                }}
                title={path}
              >
                <span className="truncate">{getFileName(path)}</span>
                <button
                  className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCloseTab(path)
                  }}
                  title={t("preview.closeTab")}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
          </div>
          <div className="relative ml-auto shrink-0">
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setTabMenuOpen((open) => !open)}
              onBlur={() => setTabMenuOpen(false)}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {tabMenuOpen && (
              <div
                className="absolute right-0 top-full z-10 mt-1 w-36 rounded-md border border-border bg-background py-1 text-xs shadow-md"
                onMouseDown={(e) => e.preventDefault()}
              >
                <button
                  className="w-full px-3 py-1.5 text-start hover:bg-accent"
                  onClick={() => {
                    setTabMenuOpen(false)
                    if (selectedFile) handleCloseOtherTabs(selectedFile)
                  }}
                >
                  {t("preview.closeOtherTabs")}
                </button>
                <button
                  className="w-full px-3 py-1.5 text-start hover:bg-accent"
                  onClick={() => {
                    setTabMenuOpen(false)
                    handleCloseAllTabs()
                  }}
                >
                  {t("preview.closeAllTabs")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground" title={selectedFile}>
          {fileName}
        </span>
        <button
          onClick={closePreview}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {externalPreview?.path === selectedFile ? (
          <ExternalReferencePreview
            source={externalPreview.source}
            title={externalPreview.title}
            path={externalPreview.url}
            snippet={externalPreview.snippet || fileContent}
          />
        ) : category === "markdown" ? (
          <WikiEditor
            content={fileContent}
            onSave={handleSave}
            filePath={selectedFile}
          />
        ) : (
          <FilePreview
            key={selectedFile}
            filePath={selectedFile}
            textContent={fileContent}
          />
        )}
      </div>
    </div>
  )
}

function ExternalReferencePreview({
  source,
  title,
  path,
  snippet,
}: {
  source: string
  title: string
  path: string
  snippet: string
}) {
  return (
    <div className="flex h-full flex-col overflow-auto p-6">
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
            {source}
          </span>
          <h3 className="truncate text-sm font-medium" title={title}>{title}</h3>
        </div>
        <div className="break-all rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {path}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/60 bg-background p-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">
          {snippet || "(No preview fragment returned.)"}
        </pre>
      </div>
    </div>
  )
}
