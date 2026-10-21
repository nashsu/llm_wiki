import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, X, Check } from "lucide-react"
import { useTranslation } from "react-i18next"
import { readFile, applyTextSelectionEdit } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { searchWiki } from "@/lib/search"
import { streamChat } from "@/lib/llm-client"
import { buildWordDiff, normalizeSelectionReplacement } from "@/lib/selection-edit"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { normalizePath } from "@/lib/path-utils"

/**
 * Knowledge-base assisted edit for a review item.
 *
 * Mirrors the wiki-editor's selection-edit flow but at whole-file scope:
 * the review's target file (sourcePath ?? first affectedPage) is read,
 * relevant knowledge-base context is retrieved, and an LLM rewrites the
 * file according to the user's instruction. The result is shown as a
 * diff and applied via the same atomic applyTextSelectionEdit used by
 * the editor, so the file tree refreshes and the review can resolve.
 */
export function ReviewEditPanel({
  item,
  projectPath,
  onClose,
}: {
  item: ReviewItem
  projectPath: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const resolveItem = useReviewStore((s) => s.resolveItem)

  const [filePath, setFilePath] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState("")
  const [instruction, setInstruction] = useState("")
  const [generated, setGenerated] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState("")
  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)

  // Resolve the target file once on mount. Mirrors the candidates logic in
  // review-view's "open:" handler: an absolute path is used as-is, a
  // wiki/raw-relative path is joined to the project root, and any other
  // bare id is assumed to live under wiki/ (with a .md fallback).
  useEffect(() => {
    const target = item.sourcePath ?? item.affectedPages?.[0]
    if (!target) {
      setError(t("review.edit.noTarget"))
      return
    }
    const pp = normalizePath(projectPath).replace(/\/+$/, "")
    const normalized = normalizePath(target)
    const candidates = normalized.startsWith(pp)
      ? [normalized]
      : normalized.startsWith("wiki/") || normalized.startsWith("raw/")
        ? [`${pp}/${normalized}`, `${pp}/${normalized}.md`]
        : [`${pp}/wiki/${normalized}`, `${pp}/wiki/${normalized}.md`]
    ;(async () => {
      for (const candidate of candidates) {
        try {
          const content = await readFile(candidate)
          setFilePath(candidate)
          setOriginalContent(content)
          return
        } catch {
          // try next
        }
      }
      setError(t("review.edit.fileUnreadable"))
    })()
  }, [item, projectPath, t])

  const stop = useCallback(() => {
    runIdRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }, [])

  useEffect(() => () => { runIdRef.current += 1; abortRef.current?.abort() }, [])

  const generate = useCallback(async () => {
    if (!filePath || !originalContent || !instruction.trim() || running) return
    const runId = ++runIdRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setError("")
    setGenerated("")

    const pp = normalizePath(projectPath).replace(/\/+$/, "")
    const relative = filePath.startsWith(`${pp}/`) ? filePath.slice(pp.length + 1) : filePath

    const references = await searchWiki(projectPath, `${instruction} ${item.title} ${item.description.slice(0, 300)}`)
      .then((results) => results.slice(0, 5))
      .catch(() => [])
    if (runId !== runIdRef.current) return

    const kbContext = references.length > 0
      ? references.map((r, i) => `[${i + 1}] ${r.title}\nPath: ${r.path.startsWith(`${pp}/`) ? r.path.slice(pp.length + 1) : r.path}\n${r.snippet}`).join("\n\n")
      : "No additional knowledge-base results were retrieved."

    const prompt = [
      `You are editing a wiki page to address a review item.`,
      `File: ${relative}`,
      `Review type: ${item.type}`,
      `Review title: ${item.title}`,
      item.description ? `Review description: ${item.description}` : "",
      `User instruction: ${instruction}`,
      "",
      "Current file content:",
      "<file>",
      originalContent,
      "</file>",
      "",
      "Knowledge-base context:",
      kbContext,
      "",
      "Rewrite the file content to address the review per the user's instruction.",
      "Return ONLY the complete new file content inside the <file>...</file> tags. Keep the YAML frontmatter intact unless the instruction requires changing it. Do not add commentary.",
    ].filter(Boolean).join("\n\n")

    let accumulated = ""
    try {
      await streamChat(
        llmConfig,
        [{ role: "user", content: prompt }],
        {
          onToken: (token) => {
            if (runId !== runIdRef.current) return
            accumulated += token
            setGenerated(accumulated)
          },
          onDone: () => {
            if (runId !== runIdRef.current) return
            setRunning(false)
          },
          onError: (err) => {
            if (runId !== runIdRef.current) return
            console.error("Review edit LLM error:", err)
            setError(t("review.edit.generateFailed"))
            setRunning(false)
          },
        },
        controller.signal,
        { temperature: 0.2 },
      )
    } catch (err) {
      if (runId !== runIdRef.current) return
      console.error("Review edit request failed:", err)
      setError(t("review.edit.generateFailed"))
      setRunning(false)
    }
  }, [filePath, originalContent, instruction, running, projectPath, item, llmConfig, t])

  const apply = useCallback(async () => {
    if (!filePath || !originalContent || !generated || applying) return
    setApplying(true)
    setError("")
    try {
      const replacement = normalizeSelectionReplacement(generated)
        .replace(/^<file>\n?/, "")
        .replace(/\n?<\/file>$/, "")
      await applyTextSelectionEdit({
        projectPath,
        filePath,
        prefix: "",
        selectedText: originalContent,
        suffix: "",
        replacement,
      })
      await refreshProjectFileTree(projectPath, { bumpDataVersion: true })
      resolveItem(item.id, "Edited")
      onClose()
    } catch (err) {
      console.error("Failed to apply review edit:", err)
      setError(t("review.edit.applyFailed"))
    } finally {
      setApplying(false)
    }
  }, [filePath, originalContent, generated, applying, projectPath, item.id, resolveItem, onClose, t])

  const diff = generated !== null && originalContent
    ? buildWordDiff(originalContent, normalizeSelectionReplacement(generated).replace(/^<file>\n?/, "").replace(/\n?<\/file>$/, ""))
    : null

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">{t("review.edit.title")}</div>
          {filePath && (
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={filePath}>
              {filePath}
            </div>
          )}
        </div>
        <button onClick={onClose} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted" aria-label={t("review.edit.close")}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {filePath && originalContent && !error && (
        <>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            placeholder={t("review.edit.instructionPlaceholder")}
            className="mb-2 w-full resize-y rounded border border-border bg-background px-2 py-1.5 font-mono text-xs leading-5 outline-none focus:border-primary"
          />
          <div className="mb-2 flex items-center gap-2">
            {running ? (
              <button onClick={stop} className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent">
                {t("review.edit.stop")}
              </button>
            ) : generated === null ? (
              <button
                onClick={generate}
                disabled={!instruction.trim()}
                className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
              >
                {t("review.edit.generate")}
              </button>
            ) : (
              <>
                <button onClick={() => { setGenerated(null); setError("") }} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                  {t("review.edit.reject")}
                </button>
                <button onClick={apply} disabled={applying} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">
                  {applying ? (
                    <>
                      <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                      {t("review.edit.applying")}
                    </>
                  ) : (
                    <>
                      <Check className="mr-1 inline h-3 w-3" />
                      {t("review.edit.apply")}
                    </>
                  )}
                </button>
              </>
            )}
          </div>

          {running && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>
                {generated
                  ? t("review.edit.generatingWithDiff", "Generating…")
                  : t("review.edit.searchingContext", "Searching knowledge base…")}
              </span>
            </div>
          )}

          {diff && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded border border-border bg-background p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                {t("review.edit.diffTitle")}
              </div>
              <div className="space-y-0.5 font-mono text-[11px] leading-5">
                {diff.map((part, i) => {
                  if (part.type === "equal") return <span key={i}>{part.value}</span>
                  if (part.type === "insert") {
                    return (
                      <span key={i} className="whitespace-pre-wrap rounded bg-emerald-500/20 text-emerald-700">
                        {part.value}
                      </span>
                    )
                  }
                  return (
                    <span key={i} className="whitespace-pre-wrap rounded bg-red-500/20 text-red-600 line-through">
                      {part.value}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
