import { useEffect, useCallback, useRef } from "react"
import { X } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { getRelativePath } from "@/lib/path-utils"

export function PreviewPanel() {
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
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

    const category = getFileCategory(selectedFile)

    if (isBinary(category)) {
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
  }, [selectedFile, setFileContent])

  const handleSave = useCallback(
    (markdown: string) => {
      if (!selectedFile) return
      // Ignore no-op saves from the editor's initial re-emit. Only write
      // when the user has actually changed the content relative to the
      // last disk read.
      if (markdown === lastLoadedRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        writeFile(selectedFile, markdown)
          .then(() => {
            // Our own write becomes the new "last loaded" — subsequent
            // re-emits from Milkdown that match this content must not
            // trigger another save.
            lastLoadedRef.current = markdown
          })
          .catch((err) => console.error("Failed to save:", err))
      }, 1000)
    },
    [selectedFile]
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file to preview
      </div>
    )
  }

  const category = getFileCategory(selectedFile)
  const displayPath = project ? getRelativePath(selectedFile, project.path) : selectedFile

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground" title={selectedFile}>
          {displayPath}
        </span>
        <button
          onClick={() => setSelectedFile(null)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {category === "markdown" ? (
          <WikiEditor
            key={selectedFile}
            content={fileContent}
            onSave={handleSave}
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
