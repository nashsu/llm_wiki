import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import "katex/dist/katex.min.css"
import { Pencil, Eye, Link2, Sparkles, X } from "lucide-react"
import { parseFrontmatter } from "@/lib/frontmatter"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { WikiReader } from "@/components/editor/wiki-reader"
import { useWikiStore } from "@/stores/wiki-store"
import { PageLinksPanel } from "@/components/editor/page-links-panel"
import { useTranslation } from "react-i18next"
import { buildWordDiff, findDomTextSelection, findUniqueTextSelection, normalizeEditableMarkdown, normalizeSelectionReplacement } from "@/lib/selection-edit"
import { applyTextSelectionEdit, readFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { searchWiki, type SearchResult } from "@/lib/search"
import { normalizePath } from "@/lib/path-utils"

interface EditorSelectionRequest {
  id: string
  filePath: string
  prefix: string
  selectedText: string
  suffix: string
  sourceMapped: boolean
}

interface SelectionConversationTurn {
  question: string
  answer: string
  references: SearchResult[]
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
  // The first action defines the interaction for this selection. Mixing Q&A
  // turns with replacement generation creates ambiguous follow-up semantics.
  const [selectionMode, setSelectionMode] = useState<"ask" | "edit" | null>(null)
  const [showPageLinks, setShowPageLinks] = useState(false)
  const [selectionResult, setSelectionResult] = useState<{ intent: "ask" | "edit"; content: string } | null>(null)
  const [selectionTurns, setSelectionTurns] = useState<SelectionConversationTurn[]>([])
  const [citationPreview, setCitationPreview] = useState<{ path: string; title: string; content: string } | null>(null)
  const [selectionError, setSelectionError] = useState("")
  const [selectionRunning, setSelectionRunning] = useState(false)
  const readerRef = useRef<HTMLDivElement>(null)
  const selectionAbortRef = useRef<AbortController | null>(null)
  const selectionRunIdRef = useRef(0)
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
  const [draftMarkdown, setDraftMarkdown] = useState(() => normalizeEditableMarkdown(editableMarkdown))
  const latestMarkdownRef = useRef(normalizeEditableMarkdown(editableMarkdown))

  useEffect(() => {
    if (mode !== "edit") {
      const normalized = normalizeEditableMarkdown(editableMarkdown)
      setDraftMarkdown(normalized)
      latestMarkdownRef.current = normalized
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
    setSelectionMode(null)
    setSelectionTurns([])
    setCitationPreview(null)
    selectionRunIdRef.current += 1
    selectionAbortRef.current?.abort()
    setSelectionRunning(false)
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
    setSelectionMode(null)
    setSelectionTurns([])
    setCitationPreview(null)
    selectionRunIdRef.current += 1
    selectionAbortRef.current?.abort()
    setSelectionRunning(false)
  }, [bodySourceOffset, editableMarkdown, filePath])

  useEffect(() => () => {
    selectionRunIdRef.current += 1
    selectionAbortRef.current?.abort()
  }, [])

  const submitSelectionToAgent = useCallback(async (intent: "ask" | "edit") => {
    if (!selectionRequest || !selectionInstruction.trim() || selectionRunning) return
    if (selectionMode && selectionMode !== intent) return
    if (intent === "edit" && !selectionRequest.sourceMapped) return
    setSelectionMode(intent)
    if (selectionRequest.sourceMapped) {
      onSave(`${selectionRequest.prefix}${selectionRequest.selectedText}${selectionRequest.suffix}`, { immediate: true })
    }
    const runId = ++selectionRunIdRef.current
    setSelectionRunning(true)
    const instruction = selectionInstruction.trim()
    const projectRoot = project ? normalizePath(project.path).replace(/\/+$/, "") : ""
    const relativeFilePath = projectRoot && normalizePath(selectionRequest.filePath).startsWith(`${projectRoot}/`)
      ? normalizePath(selectionRequest.filePath).slice(projectRoot.length + 1)
      : selectionRequest.filePath
    const references = intent === "ask" && project
      ? await searchWiki(project.path, `${instruction} ${selectionRequest.selectedText.slice(0, 500)}`)
        .then((results) => results.slice(0, 5))
        .catch(() => [])
      : []
    if (runId !== selectionRunIdRef.current) return
    const retrievedContext = references.length > 0
      ? references.map((reference, index) => `[${index + 1}] ${reference.title}\nPath: ${projectRelativePath(projectRoot, reference.path)}\n${reference.snippet}`).join("\n\n")
      : "No additional knowledge-base results were retrieved."
    const prompt = [
      intent === "edit"
        ? "Edit the selected text according to the user's instruction. Return only the replacement text without explanation or an outer Markdown fence."
        : "Answer the user's instruction about the selected text. Use the nearby text only as supporting context.",
      `File: ${relativeFilePath}`,
      `Instruction: ${instruction}`,
      "Context before selection:",
      selectionRequest.sourceMapped ? selectionRequest.prefix.slice(-1200) : "Unavailable because the rendered selection could not be mapped safely to one source range.",
      "<selected_text>",
      selectionRequest.selectedText,
      "</selected_text>",
      "Context after selection:",
      selectionRequest.sourceMapped ? selectionRequest.suffix.slice(0, 1200) : "Unavailable because the rendered selection could not be mapped safely to one source range.",
      "Knowledge-base context:",
      retrievedContext,
      "When knowledge-base context supports the answer, cite it using [1], [2], and so on. Do not invent citations.",
    ].join("\n\n")
    const controller = new AbortController()
    selectionAbortRef.current?.abort()
    selectionAbortRef.current = controller
    setSelectionResult({ intent, content: "" })
    setSelectionError("")
    let accumulated = ""
    const history = selectionTurns.slice(-6).flatMap((turn) => [
      { role: "user" as const, content: turn.question },
      { role: "assistant" as const, content: turn.answer.slice(-6000) },
    ])
    try {
      await streamChat(
        llmConfig,
        [...history, { role: "user", content: prompt }],
        {
          onToken: (token) => {
            if (runId !== selectionRunIdRef.current) return
            accumulated += token
            setSelectionResult({ intent, content: accumulated })
          },
          onDone: () => {
            if (runId !== selectionRunIdRef.current) return
            if (intent === "ask") {
              setSelectionResult(null)
              if (accumulated.trim()) {
                setSelectionTurns((turns) => [...turns, { question: instruction, answer: accumulated, references }])
                setSelectionInstruction("")
              } else {
                setSelectionError(t("editor.selection.emptyResponse"))
              }
            }
            setSelectionRunning(false)
          },
          onError: (error) => {
            if (runId !== selectionRunIdRef.current) return
            console.error("Selection assistant request failed", error)
            setSelectionError(t("editor.selection.requestFailed"))
            setSelectionRunning(false)
          },
        },
        controller.signal,
        { temperature: intent === "edit" ? 0.2 : 0.4 },
      )
    } catch (error) {
      if (runId !== selectionRunIdRef.current) return
      console.error("Selection assistant request failed", error)
      setSelectionError(t("editor.selection.requestFailed"))
      setSelectionRunning(false)
    }
  }, [llmConfig, onSave, project, selectionInstruction, selectionMode, selectionRequest, selectionRunning, selectionTurns, t])

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
      console.error("Failed to apply selection edit", error)
      setSelectionError(
        error instanceof Error && error.message.includes("changed after the selection")
          ? t("editor.selection.sourceChanged")
          : t("editor.selection.applyFailed"),
      )
    }
  }, [project, selectionRequest, selectionResult, t])

  const closeSelectionPanel = useCallback(() => {
    selectionRunIdRef.current += 1
    selectionAbortRef.current?.abort()
    selectionAbortRef.current = null
    setSelectionRunning(false)
    setSelectionRequest(null)
    setSelectionResult(null)
    setSelectionError("")
    setSelectionInstruction("")
    setSelectionMode(null)
    setSelectionTurns([])
    setCitationPreview(null)
  }, [])

  const stopSelectionRun = useCallback(() => {
    selectionRunIdRef.current += 1
    selectionAbortRef.current?.abort()
    selectionAbortRef.current = null
    setSelectionRunning(false)
    setSelectionResult(null)
  }, [])

  const openCitation = useCallback(async (reference: SearchResult) => {
    try {
      setSelectionError("")
      const content = await readFile(reference.path)
      setCitationPreview({ path: reference.path, title: reference.title, content })
    } catch (error) {
      console.error("Failed to open selection reference", error)
      setSelectionError(t("editor.selection.referenceFailed"))
    }
  }, [t])

  return (
    <div
      className="flex h-full overflow-hidden"
      tabIndex={-1}
      onKeyDownCapture={(event) => {
        if (mode !== "edit") return
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault()
          saveLatestNow()
        }
      }}
    >
      <div className="relative min-w-0 flex-1 overflow-hidden">
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
              const normalized = normalizeEditableMarkdown(editableMarkdown)
              setDraftMarkdown(normalized)
              latestMarkdownRef.current = normalized
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
            aria-label={t("editor.rawMarkdownEditor")}
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
      {showPageLinks && filePath && <PageLinksPanel filePath={filePath} onClose={() => setShowPageLinks(false)} />}
      </div>
      {selectionRequest && (
        <aside className="flex h-full w-[360px] max-w-[45%] shrink-0 flex-col border-l border-border bg-background" aria-label={t("editor.selection.askAgent")}>
          <header className="flex min-h-11 items-center gap-2 border-b border-border px-3 py-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{t("editor.selection.askAgent")}</span>
            <button type="button" onClick={closeSelectionPanel} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("editor.selection.askAgent")}>
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto p-3">
            <div className="mb-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {selectionRequest.selectedText}
            </div>
            {!selectionRequest.sourceMapped && (
              <p className="mb-3 rounded-md border border-border bg-muted/40 p-2 text-xs leading-5 text-muted-foreground">
                {t("editor.selection.askOnlyHint")}
              </p>
            )}
            {selectionTurns.map((turn, index) => (
              <div key={`${index}:${turn.question}`} className="mb-4 space-y-2 border-b border-border/60 pb-4">
                <div className="ml-6 rounded-md bg-accent px-2.5 py-1.5 text-xs text-accent-foreground">{turn.question}</div>
                <WikiReader body={turn.answer} filePath={selectionRequest.filePath} />
                {turn.references.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {turn.references.map((reference, referenceIndex) => (
                      <button key={reference.path} type="button" onClick={() => void openCitation(reference)} title={reference.path} className="max-w-full truncate rounded border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">[{referenceIndex + 1}] {reference.title}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {citationPreview && (
              <section className="mb-4 overflow-hidden rounded-md border border-border bg-background">
                <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{citationPreview.title}</span>
                  <button type="button" onClick={() => setCitationPreview(null)} className="text-xs text-muted-foreground hover:text-foreground">{t("editor.selection.closeReference")}</button>
                </div>
                <div className="max-h-72 overflow-auto p-2"><WikiReader body={parseFrontmatter(citationPreview.content).body} filePath={citationPreview.path} /></div>
              </section>
            )}
            {selectionResult && (
              <div className="space-y-3">
                {selectionResult.intent === "edit" && (
                  <div className="rounded-md border border-border bg-muted/20 p-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">{t("editor.selection.wordDiff")}</div>
                    <div className="whitespace-pre-wrap break-words font-mono text-xs leading-5">
                      {buildWordDiff(selectionRequest.selectedText, normalizeSelectionReplacement(selectionResult.content)).map((part, index) => (
                        <span key={`${index}:${part.type}`} className={part.type === "delete" ? "bg-destructive/10 text-destructive line-through" : part.type === "insert" ? "bg-primary/10 text-primary" : "text-foreground/80"}>{part.value}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div className={selectionResult.intent === "edit" ? "rounded-md border border-border bg-muted/20 p-2" : "min-w-0 text-sm text-foreground"}>
                  {selectionResult.intent === "edit" && <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">+ {t("chat.selectionEdit.replacement")}</div>}
                  {selectionResult.intent === "edit" ? (
                    selectionRunning ? <div className="whitespace-pre-wrap break-words">{selectionResult.content || t("editor.selection.generating")}</div> : (
                      <textarea value={selectionResult.content} onChange={(event) => setSelectionResult({ intent: "edit", content: event.target.value })} rows={8} className="w-full resize-y bg-transparent font-mono text-xs leading-5 outline-none" />
                    )
                  ) : selectionResult.content ? (
                    <WikiReader body={selectionResult.content} filePath={selectionRequest.filePath} />
                  ) : selectionRunning ? (
                    <p className="text-muted-foreground">{t("editor.selection.generating")}</p>
                  ) : null}
                </div>
              </div>
            )}
            {selectionError && <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{selectionError}</p>}
          </div>
          <footer className="space-y-2 border-t border-border bg-background p-3">
            {!selectionResult && !selectionRunning && (
              <textarea
                value={selectionInstruction}
                onChange={(event) => setSelectionInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    submitSelectionToAgent(selectionMode ?? "ask")
                  }
                }}
                placeholder={t("editor.selection.placeholder")}
                rows={3}
                className="w-full resize-none rounded-md border border-input bg-background p-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            )}
            <div className="flex min-h-7 justify-end gap-1.5">
              {selectionRunning ? (
                <button type="button" onClick={stopSelectionRun} className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent">{t("editor.selection.stop")}</button>
              ) : selectionResult?.intent === "edit" ? (
                <>
                  <button type="button" onClick={() => setSelectionResult(null)} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">{t("chat.selectionEdit.reject")}</button>
                  <button type="button" onClick={() => void submitSelectionToAgent("edit")} className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent">{t("editor.selection.regenerate")}</button>
                  <button type="button" onClick={() => void acceptSelectionEdit()} disabled={!selectionResult.content} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">{t("chat.selectionEdit.accept")}</button>
                </>
              ) : !selectionResult ? (
                <>
                  {selectionMode !== "edit" && (
                    <button type="button" onClick={() => void submitSelectionToAgent("ask")} disabled={!selectionInstruction.trim()} className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50">{t("editor.selection.ask")}</button>
                  )}
                  {selectionMode !== "ask" && (
                    <button type="button" onClick={() => void submitSelectionToAgent("edit")} disabled={!selectionInstruction.trim() || !selectionRequest.sourceMapped} title={!selectionRequest.sourceMapped ? t("editor.selection.askOnlyHint") : undefined} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">{t("editor.selection.edit")}</button>
                  )}
                </>
              ) : null}
            </div>
          </footer>
        </aside>
      )}
    </div>
  )
}

function editableMarkdownIndex(markdown: string, body: string): number {
  if (!body) return markdown.length
  return markdown.indexOf(body)
}

function projectRelativePath(projectRoot: string, path: string): string {
  const normalized = normalizePath(path)
  return projectRoot && normalized.startsWith(`${projectRoot}/`)
    ? normalized.slice(projectRoot.length + 1)
    : normalized
}
