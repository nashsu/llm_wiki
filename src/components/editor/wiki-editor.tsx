import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import "katex/dist/katex.min.css"
import { Pencil, Eye } from "lucide-react"
import { parseFrontmatter } from "@/lib/frontmatter"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { WikiReader } from "@/components/editor/wiki-reader"

interface WikiEditorProps {
  content: string
  onSave: (markdown: string, options?: { immediate?: boolean }) => void
  /** Absolute path of the file, threaded to WikiReader so relative
   *  image references resolve against the file's own directory. */
  filePath?: string
}

export function WikiEditor({ content, onSave, filePath }: WikiEditorProps) {
  // Default to read mode (ReactMarkdown render). Edit mode is a raw Markdown
  // textarea so metadata/frontmatter can be edited without a WYSIWYG serializer
  // rewriting YAML, wikilinks, or other wiki-specific source syntax.
  const [mode, setMode] = useState<"read" | "edit">("read")

  // Read mode renders frontmatter as UI plus the Markdown body. Edit mode uses
  // a plain-text Markdown editor for the full file so frontmatter can be edited
  // without passing YAML through Milkdown's CommonMark serializer.
  const { frontmatter, body } = useMemo(
    () => parseFrontmatter(content),
    [content],
  )

  const editableMarkdown = content
  const [draftMarkdown, setDraftMarkdown] = useState(editableMarkdown)
  const latestMarkdownRef = useRef(editableMarkdown)

  useEffect(() => {
    if (mode !== "edit") {
      setDraftMarkdown(editableMarkdown)
      latestMarkdownRef.current = editableMarkdown
    }
  }, [editableMarkdown, mode])

  const saveLatestNow = useCallback(() => {
    onSave(latestMarkdownRef.current, { immediate: true })
  }, [onSave])

  return (
    <div
      className="relative h-full overflow-auto"
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (mode !== "edit") return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault()
          saveLatestNow()
        }
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (mode === "edit") saveLatestNow()
          if (mode === "read") {
            // Seed edit mode from the latest raw file content before switching;
            // the sync effect intentionally does not reset drafts while editing.
            setDraftMarkdown(editableMarkdown)
            latestMarkdownRef.current = editableMarkdown
          }
          setMode((m) => (m === "read" ? "edit" : "read"))
        }}
        title={mode === "read" ? "Edit (raw markdown)" : "Done editing"}
        className="absolute right-3 top-3 z-10 inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
      >
        {mode === "read" ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        {mode === "read" ? "Edit" : "Done"}
      </button>

      {mode === "read" ? (
        <div className="px-6 py-6">
          {frontmatter && <FrontmatterPanel data={frontmatter} />}
          <WikiReader body={body} filePath={filePath} />
        </div>
      ) : (
        <div className="h-full p-6">
          <textarea
            aria-label="Raw Markdown editor"
            value={draftMarkdown}
            onChange={(event) => {
              const next = event.currentTarget.value
              setDraftMarkdown(next)
              latestMarkdownRef.current = next
              onSave(next)
            }}
            spellCheck={false}
            className="h-full min-h-[60vh] w-full resize-none rounded-md border border-border/60 bg-background/70 p-4 font-mono text-sm leading-6 text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
        </div>
      )}
    </div>
  )
}
