import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import "katex/dist/katex.min.css"
import { Pencil, Eye, Link2, Sparkles, X } from "lucide-react"
import { parseFrontmatter } from "@/lib/frontmatter"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { WikiReader } from "@/components/editor/wiki-reader"
import { useWikiStore } from "@/stores/wiki-store"
import { PageLinksPanel } from "@/components/editor/page-links-panel"
import { useTranslation } from "react-i18next"
import { findDomTextSelection, findUniqueTextSelection, normalizeSelectionReplacement } from "@/lib/selection-edit"
import { applyTextSelectionEdit } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

interface EditorSelectionRequest {
  id: string
  filePath: string
  prefix: string
  selectedText: string
  suffix: string
  sourceMapped: boolean
}

interface WikiEditorProps {
  content: string
  onSave: (markdown: string, options?: { immediate?: boolean }) => void
  /** Absolute path of the file, threaded to WikiReader so relative
   *  image references resolve against the file's own directory. */
  filePath?: string
}

// Selection actions update the parent editor state. Keeping the rendered body
// stable prevents React from replacing selected text nodes and clearing the
// browser's visible selection highlight when the side panel opens.
const StableWikiReader = memo(WikiReader)
const StableFrontmatterPanel = memo(FrontmatterPanel)

export function WikiEditor({ content, onSave, filePath }: WikiEditorProps) {
  const { t } = useTranslation()
  // Default to read mode (ReactMarkdown render). Edit mode is a raw Markdown
  // textarea so metadata/frontmatter can be edited without a WYSIWYG serializer
  // rewriting YAML, wikilinks, or other wiki-specific source syntax.
  const [mode, setMode] = useState<"read" | "edit">("read")
  const [selectionRequest, setSelectionRequest] = useState<EditorSelectionRequest | null>(null)
  const [selectionInstruction, setSelectionInstruction] = useState("")
  const [showPageLinks, setShowPageLinks] = useState(false)
  const [selectionResult, setSelectionResult] = useState<{ intent: "ask" | "edit"; content: string } | null>(null)
  const [selectionError, setSelectionError] = useState("")
  const [selectionRunning, setSelectionRunning] = useState(false)
  const readerRef = useRef<HTMLDivElement>(null)
  const selectionAbortRef = useRef<AbortController | null>(null)
  const project = useWikiStore((state) => state.project)
  const llmConfig = useWikiStore((state) => state.llmConfig)

  // Read mode renders frontmatter as UI plus the Markdown body. Edit mode uses
  // a plain-text Markdown editor for the full file so frontmatter can be edited
  // without passing YAML through Milkdown's CommonMark serializer.
  const { frontmatter, body } = useMemo(
    () => parseFrontmatter(content),
    [content],
  )
  const bodySourceOffset = useMemo(() => editableMarkdownIndex(content, body), [body, content])

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

  const captureSelection = useCallback((markdown: string, start: number, end: number) => {
    if (!filePath || start === end) {
      setSelectionRequest(null)
      return
    }
    const selectedText = markdown.slice(start, end)
    if (!selectedText.trim()) {
      setSelectionRequest(null)
      return
    }
    setSelectionRequest({
      id: `selection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      prefix: markdown.slice(0, start),
      selectedText,
      suffix: markdown.slice(end),
      sourceMapped: true,
    })
    setSelectionResult(null)
    setSelectionError("")
    setSelectionInstruction("")
  }, [filePath])

  const captureRenderedSelection = useCallback(() => {
    if (!filePath) {
      setSelectionRequest(null)
      return
    }
    const root = readerRef.current
    const selection = window.getSelection()
    if (!root || !selection || selection.isCollapsed || !selection.anchorNode || !root.contains(selection.anchorNode)) {
      setSelectionRequest(null)
      return
    }
    const renderedSelection = selection.toString().trim()
    if (!renderedSelection) {
      setSelectionRequest(null)
      return
    }
    const snapshot = bodySourceOffset >= 0
      ? findDomTextSelection(editableMarkdown, selection, root)
      : null
    const fallbackSnapshot = snapshot ?? findUniqueTextSelection(editableMarkdown, renderedSelection)
    setShowPageLinks(false)
    setSelectionRequest({
      id: `selection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      prefix: fallbackSnapshot?.prefix ?? "",
      selectedText: fallbackSnapshot?.selectedText ?? renderedSelection,
      suffix: fallbackSnapshot?.suffix ?? "",
      sourceMapped: Boolean(fallbackSnapshot),
    })
    setSelectionResult(null)
    setSelectionError("")
    setSelectionInstruction("")
  }, [bodySourceOffset, editableMarkdown, filePath])

  useEffect(() => () => selectionAbortRef.current?.abort(), [])

  const submitSelectionToAgent = useCallback(async (intent: "ask" | "edit") => {
    if (!selectionRequest || !selectionInstruction.trim() || selectionRunning) return
    if (intent === "edit" && !selectionRequest.sourceMapped) return
    if (selectionRequest.sourceMapped) {
      onSave(`${selectionRequest.prefix}${selectionRequest.selectedText}${selectionRequest.suffix}`, { immediate: true })
    }
    const instruction = selectionInstruction.trim()
    const prompt = [
      intent === "edit"
        ? "Edit the selected text according to the user's instruction. Return only the replacement text without explanation or an outer Markdown fence."
        : "Answer the user's instruction about the selected text. Use the nearby text only as supporting context.",
      `File: ${selectionRequest.filePath}`,
      `Instruction: ${instruction}`,
      "Context before selection:",
      selectionRequest.sourceMapped ? selectionRequest.prefix.slice(-1200) : "Unavailable because the rendered selection could not be mapped safely to one source range.",
      "<selected_text>",
      selectionRequest.selectedText,
      "</selected_text>",
      "Context after selection:",
      selectionRequest.sourceMapped ? selectionRequest.suffix.slice(0, 1200) : "Unavailable because the rendered selection could not be mapped safely to one source range.",
    ].join("\n\n")
    const controller = new AbortController()
    selectionAbortRef.current?.abort()
    selectionAbortRef.current = controller
    setSelectionResult({ intent, content: "" })
    setSelectionError("")
    setSelectionRunning(true)
    try {
      await streamChat(
        llmConfig,
        [{ role: "user", content: prompt }],
        {
          onToken: (token) => setSelectionResult((current) => current ? { ...current, content: current.content + token } : { intent, content: token }),
          onDone: () => setSelectionRunning(false),
          onError: (error) => {
            setSelectionError(error.message)
            setSelectionRunning(false)
          },
        },
        controller.signal,
        { temperature: intent === "edit" ? 0.2 : 0.4 },
      )
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : String(error))
      setSelectionRunning(false)
    }
  }, [llmConfig, onSave, selectionInstruction, selectionRequest, selectionRunning])

  const acceptSelectionEdit = useCallback(async () => {
    if (!project || !selectionRequest?.sourceMapped || selectionResult?.intent !== "edit") return
    const replacement = normalizeSelectionReplacement(selectionResult.content)
    try {
      setSelectionError("")
      const updated = await applyTextSelectionEdit({
        projectPath: project.path,
        filePath: selectionRequest.filePath,
        prefix: selectionRequest.prefix,
        selectedText: selectionRequest.selectedText,
        suffix: selectionRequest.suffix,
        replacement,
      })
      if (useWikiStore.getState().selectedFile === selectionRequest.filePath) {
        useWikiStore.getState().setFileContent(updated)
      }
      setSelectionRequest(null)
      setSelectionResult(null)
      setSelectionInstruction("")
      await refreshProjectFileTree(project.path, { bumpDataVersion: true })
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : String(error))
    }
  }, [project, selectionRequest, selectionResult])

  const closeSelectionPanel = useCallback(() => {
    selectionAbortRef.current?.abort()
    selectionAbortRef.current = null
    setSelectionRunning(false)
    setSelectionRequest(null)
    setSelectionResult(null)
    setSelectionError("")
    setSelectionInstruction("")
  }, [])

  return (
    <div
      className="relative h-full overflow-hidden"
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (mode !== "edit") return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault()
          saveLatestNow()
        }
      }}
    >
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1">
        {filePath && (
          <button type="button" onClick={() => { setSelectionRequest(null); setShowPageLinks((shown) => !shown) }} title={t("editor.pageLinks.title")} className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground">
            <Link2 className="h-3.5 w-3.5" />
            {t("editor.pageLinks.button")}
          </button>
        )}
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
          title={mode === "read" ? t("editor.editRaw") : t("editor.doneEditing")}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
        >
          {mode === "read" ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {mode === "read" ? t("editor.edit") : t("editor.done")}
        </button>
      </div>

      {mode === "read" ? (
        <div ref={readerRef} className="h-full overflow-auto px-6 py-6" onMouseUp={captureRenderedSelection}>
          {frontmatter && <StableFrontmatterPanel data={frontmatter} />}
          <StableWikiReader
            body={body}
            sourceBody={bodySourceOffset >= 0 ? body : undefined}
            sourceOffset={bodySourceOffset >= 0 ? bodySourceOffset : undefined}
            filePath={filePath}
          />
        </div>
      ) : (
        <div className="h-full overflow-auto p-6">
          <textarea
            aria-label="Raw Markdown editor"
            value={draftMarkdown}
            onChange={(event) => {
              const next = event.currentTarget.value
              setDraftMarkdown(next)
              latestMarkdownRef.current = next
              onSave(next)
            }}
            onSelect={(event) => {
              captureSelection(
                draftMarkdown,
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
              )
            }}
            spellCheck={false}
            className="h-full min-h-[60vh] w-full resize-none rounded-md border border-border/60 bg-background/70 p-4 font-mono text-sm leading-6 text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
        </div>
      )}
      {selectionRequest && (
        <aside className="absolute inset-y-0 right-0 z-20 flex w-[min(22rem,90%)] flex-col border-l border-border bg-background shadow-xl" aria-label={t("editor.selection.askAgent")}>
          <header className="flex h-11 items-center gap-2 border-b border-border px-3">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="min-w-0 flex-1 truncate">{t("editor.selection.askAgent")}</span>
            <button type="button" onClick={closeSelectionPanel} className="p-1 text-muted-foreground hover:text-foreground" aria-label={t("editor.selection.askAgent")}>
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto p-3">
            <div className="mb-3 border-l-2 border-primary/40 bg-muted/30 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
              {selectionRequest.selectedText}
            </div>
            {!selectionRequest.sourceMapped && (
              <p className="mb-3 border border-amber-500/30 bg-amber-500/5 p-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                {t("editor.selection.askOnlyHint")}
              </p>
            )}
            {!selectionResult && <textarea
              value={selectionInstruction}
              onChange={(event) => setSelectionInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  submitSelectionToAgent("ask")
                }
              }}
              placeholder={t("editor.selection.placeholder")}
              rows={5}
              className="w-full resize-none border border-border bg-background p-2 text-sm outline-none focus:border-primary"
            />}
            {selectionResult && (
              <div className="space-y-3">
                {selectionResult.intent === "edit" && (
                  <div className="border border-red-500/20 bg-red-500/5 p-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase text-red-600 dark:text-red-400">- {t("chat.selectionEdit.original")}</div>
                    <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground/80">{selectionRequest.selectedText}</pre>
                  </div>
                )}
                <div className={selectionResult.intent === "edit" ? "border border-green-500/20 bg-green-500/5 p-2" : "min-w-0 text-sm text-foreground"}>
                  {selectionResult.intent === "edit" && <div className="mb-1 text-[10px] font-semibold uppercase text-green-700 dark:text-green-400">+ {t("chat.selectionEdit.replacement")}</div>}
                  {selectionResult.intent === "edit" ? (
                    <div className="whitespace-pre-wrap break-words">{selectionResult.content || (selectionRunning ? t("editor.selection.generating") : "")}</div>
                  ) : selectionResult.content ? (
                    <WikiReader body={selectionResult.content} filePath={selectionRequest.filePath} />
                  ) : selectionRunning ? (
                    <p className="text-muted-foreground">{t("editor.selection.generating")}</p>
                  ) : null}
                </div>
              </div>
            )}
            {selectionError && <p className="mt-3 border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{selectionError}</p>}
          </div>
          <footer className="flex justify-end gap-1.5 border-t border-border p-3">
            {selectionRunning ? (
              <button type="button" onClick={() => selectionAbortRef.current?.abort()} className="border border-border px-2 py-1 text-xs text-foreground hover:bg-accent">{t("editor.selection.stop")}</button>
            ) : selectionResult?.intent === "edit" ? (
              <>
                <button type="button" onClick={() => setSelectionResult(null)} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">{t("chat.selectionEdit.reject")}</button>
                <button type="button" onClick={() => void acceptSelectionEdit()} disabled={!selectionResult.content} className="bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">{t("chat.selectionEdit.accept")}</button>
              </>
            ) : selectionResult ? (
              <button type="button" onClick={() => setSelectionResult(null)} className="border border-border px-2 py-1 text-xs text-foreground hover:bg-accent">{t("editor.selection.askAgain")}</button>
            ) : (
              <>
                <button type="button" onClick={() => void submitSelectionToAgent("ask")} disabled={!selectionInstruction.trim()} className="border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50">{t("editor.selection.ask")}</button>
                <button type="button" onClick={() => void submitSelectionToAgent("edit")} disabled={!selectionInstruction.trim() || !selectionRequest.sourceMapped} title={!selectionRequest.sourceMapped ? t("editor.selection.askOnlyHint") : undefined} className="bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">{t("editor.selection.edit")}</button>
              </>
            )}
          </footer>
        </aside>
      )}
      {showPageLinks && filePath && <PageLinksPanel filePath={filePath} onClose={() => setShowPageLinks(false)} />}
    </div>
  )
}

function editableMarkdownIndex(markdown: string, body: string): number {
  if (!body) return markdown.length
  return markdown.indexOf(body)
}
