import { useEffect, useCallback, useRef } from "react"
import { X } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, readTextFileVersioned, writeFileAtomicChecked } from "@/commands/fs"
import { getFileCategory, isBinary, isExtractedTextPreviewFile } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { getFileName } from "@/lib/path-utils"

export function PreviewPanel() {
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const previewContentPath = useWikiStore((s) => s.previewContentPath)
  const externalPreview = useWikiStore((s) => s.externalPreview)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const closePreview = useWikiStore((s) => s.closePreview)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const loadGenerationRef = useRef(0)
  const loadedPathRef = useRef<string | null>(null)
  const loadedRevisionRef = useRef<string | null>(null)
  const revisionsByPathRef = useRef(new Map<string, string>())
  const pendingSaveRef = useRef<{ path: string; markdown: string } | null>(null)
  // Snapshot of what was most recently loaded from disk. Milkdown re-emits
  // `markdownUpdated` on initial parse (before the user types anything),
  // which used to trigger an auto-save that could write back a placeholder
  // marker if read_file had returned one for a missing/locked file. We
  // skip save when the incoming markdown equals the last-loaded content.
  const lastLoadedRef = useRef<string>("")

  useEffect(() => {
    const generation = ++loadGenerationRef.current
    if (!selectedFile) {
      setFileContent("")
      lastLoadedRef.current = ""
      loadedRevisionRef.current = null
      loadedPathRef.current = null
      return
    }
    const category = getFileCategory(selectedFile)
    if (previewContentPath === selectedFile && category !== "markdown") {
      lastLoadedRef.current = fileContent
      return
    }
    if (externalPreview?.path === selectedFile && category !== "markdown") {
      lastLoadedRef.current = fileContent
      return
    }

    if (isBinary(category) && !isExtractedTextPreviewFile(selectedFile)) {
      setFileContent("")
      lastLoadedRef.current = ""
      loadedRevisionRef.current = null
      loadedPathRef.current = null
      return
    }

    const load = category === "markdown"
      ? readTextFileVersioned(selectedFile)
      : readFile(selectedFile).then((contents) => ({ contents, md5: null }))
    load
      .then(({ contents, md5 }) => {
        if (loadGenerationRef.current !== generation) return
        lastLoadedRef.current = contents
        loadedRevisionRef.current = md5
        loadedPathRef.current = selectedFile
        if (md5) revisionsByPathRef.current.set(selectedFile, md5)
        setFileContent(contents)
      })
      .catch((err) => {
        if (loadGenerationRef.current !== generation) return
        lastLoadedRef.current = ""
        loadedRevisionRef.current = null
        loadedPathRef.current = null
        setFileContent(`Error loading file: ${err}`)
      })
  }, [selectedFile, previewContentPath, externalPreview, setFileContent])

  const writeNow = useCallback((path: string, markdown: string, syncStore = false) => {
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!project) return
        const expectedMd5 = revisionsByPathRef.current.get(path)
        if (!expectedMd5) {
          throw new Error("no loaded file revision; reopen the note before saving")
        }
        const nextMd5 = await writeFileAtomicChecked(project.path, path, expectedMd5, markdown)
        revisionsByPathRef.current.set(path, nextMd5)
        if (loadedPathRef.current === path) {
          loadedRevisionRef.current = nextMd5
          lastLoadedRef.current = markdown
          if (syncStore) setFileContent(markdown)
        }
      })
      .catch((err) => console.error("Failed to save:", err))
  }, [project, setFileContent])

  const handleSave = useCallback(
    (markdown: string, options?: { immediate?: boolean }) => {
      if (!selectedFile) return
      // Ignore no-op saves from the editor's initial re-emit. Only write
      // when the user has actually changed the content relative to the
      // last disk read.
      if (markdown === lastLoadedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      pendingSaveRef.current = { path: selectedFile, markdown }
      if (options?.immediate) {
        pendingSaveRef.current = null
        setFileContent(markdown)
        writeNow(selectedFile, markdown, true)
        return
      }
      saveTimerRef.current = setTimeout(() => {
        pendingSaveRef.current = null
        writeNow(selectedFile, markdown, true)
      }, 1000)
    },
    [selectedFile, setFileContent, writeNow]
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const pending = pendingSaveRef.current
      if (pending?.path === selectedFile) {
        pendingSaveRef.current = null
        writeNow(pending.path, pending.markdown, false)
      }
    }
  }, [selectedFile, writeNow])

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
            key={selectedFile}
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
