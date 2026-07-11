import { useCallback, useEffect, useRef, useState } from "react"
import { WandSparkles, X } from "lucide-react"
import { readFile, writeFile } from "@/commands/fs"
import { AutoLinkReviewDialog } from "@/components/editor/auto-link-review-dialog"
import { FilePreview } from "@/components/editor/file-preview"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  addIgnoredPair,
  addIgnoredTerm,
} from "@/lib/auto-link-ignore"
import {
  type AutoLinkReviewResult,
  prepareAutoLinkReview,
} from "@/lib/auto-link-review"
import type { AutoLinkSuggestion, LinkEntry } from "@/lib/auto-link-types"
import { applyWikilinks } from "@/lib/enrich-wikilinks"
import {
  getFileCategory,
  isBinary,
  isExtractedTextPreviewFile,
} from "@/lib/file-types"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

interface AutoLinkContext {
  projectId: string
  projectPath: string
  filePath: string
  contentHash?: string
}

export function PreviewPanel() {
  const project = useWikiStore((s) => s.project)
  const fileTree = useWikiStore((s) => s.fileTree)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const previewContentPath = useWikiStore((s) => s.previewContentPath)
  const externalPreview = useWikiStore((s) => s.externalPreview)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const closePreview = useWikiStore((s) => s.closePreview)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingWriteRef = useRef<Promise<void> | null>(null)
  const lastLoadedRef = useRef("")
  const liveDraftRef = useRef("")
  const autoLinkContextRef = useRef<AutoLinkContext | null>(null)

  const [fileLoadFailed, setFileLoadFailed] = useState(false)
  const [hasLiveContent, setHasLiveContent] = useState(false)
  const [autoLinkOpen, setAutoLinkOpen] = useState(false)
  const [autoLinkLoading, setAutoLinkLoading] = useState(false)
  const [autoLinkApplying, setAutoLinkApplying] = useState(false)
  const [autoLinkResult, setAutoLinkResult] =
    useState<AutoLinkReviewResult | null>(null)
  const [autoLinkApplyError, setAutoLinkApplyError] = useState<string | null>(
    null,
  )

  const queueWrite = useCallback((filePath: string, contents: string) => {
    const previousWrite = pendingWriteRef.current
    const writePromise = (previousWrite
      ? previousWrite.catch(() => undefined)
      : Promise.resolve()
    )
      .then(() => writeFile(filePath, contents))
      .then(() => {
        if (useWikiStore.getState().selectedFile === filePath) {
          lastLoadedRef.current = contents
        }
      })

    pendingWriteRef.current = writePromise
    const clearPending = () => {
      if (pendingWriteRef.current === writePromise) {
        pendingWriteRef.current = null
      }
    }
    void writePromise.then(clearPending, clearPending)
    return writePromise
  }, [])

  useEffect(() => {
    let active = true
    const cleanup = () => {
      active = false
      if (!saveTimerRef.current) return
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      if (
        selectedFile &&
        liveDraftRef.current !== lastLoadedRef.current
      ) {
        void queueWrite(selectedFile, liveDraftRef.current).catch((error) => {
          console.error("Failed to save before switching files:", error)
        })
      }
    }

    if (previewContentPath === selectedFile || externalPreview?.path === selectedFile) {
      lastLoadedRef.current = fileContent
      liveDraftRef.current = fileContent
      setHasLiveContent(fileContent.trim().length > 0)
      setFileLoadFailed(false)
      return cleanup
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    lastLoadedRef.current = ""
    liveDraftRef.current = ""
    setFileContent("")
    setHasLiveContent(false)
    setFileLoadFailed(false)

    if (!selectedFile) return cleanup
    const category = getFileCategory(selectedFile)
    if (isBinary(category) && !isExtractedTextPreviewFile(selectedFile)) {
      return cleanup
    }

    readFile(selectedFile)
      .then((content) => {
        if (!active) return
        lastLoadedRef.current = content
        liveDraftRef.current = content
        setFileContent(content)
        setHasLiveContent(content.trim().length > 0)
      })
      .catch((error) => {
        if (!active) return
        setFileLoadFailed(true)
        setFileContent(`Error loading file: ${error}`)
      })

    return cleanup
  }, [
    externalPreview,
    previewContentPath,
    queueWrite,
    selectedFile,
    setFileContent,
  ])

  useEffect(() => {
    autoLinkContextRef.current = null
    setAutoLinkOpen(false)
    setAutoLinkLoading(false)
    setAutoLinkApplying(false)
    setAutoLinkResult(null)
    setAutoLinkApplyError(null)
  }, [project?.id, selectedFile])

  const handleSave = useCallback(
    (markdown: string, options?: { immediate?: boolean }) => {
      if (!selectedFile) return
      liveDraftRef.current = markdown
      setHasLiveContent(markdown.trim().length > 0)
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (markdown === lastLoadedRef.current) return

      const filePath = selectedFile
      if (options?.immediate) {
        setFileContent(markdown)
        void queueWrite(filePath, markdown).catch((error) => {
          console.error("Failed to save:", error)
        })
        return
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        void queueWrite(filePath, markdown).catch((error) => {
          console.error("Failed to save:", error)
        })
      }, 1000)
    },
    [queueWrite, selectedFile, setFileContent],
  )

  const flushPendingSave = useCallback(
    async (filePath: string) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (pendingWriteRef.current) await pendingWriteRef.current
      const draft = liveDraftRef.current
      if (draft !== lastLoadedRef.current) {
        await queueWrite(filePath, draft)
      }
    },
    [queueWrite],
  )

  const isCurrentAutoLinkContext = useCallback(
    (context: AutoLinkContext) => {
      const state = useWikiStore.getState()
      return (
        autoLinkContextRef.current === context &&
        state.project?.id === context.projectId &&
        state.selectedFile === context.filePath
      )
    },
    [],
  )

  const handleAutoLink = useCallback(async () => {
    if (!project || !selectedFile || fileLoadFailed) return
    const context: AutoLinkContext = {
      projectId: project.id,
      projectPath: project.path,
      filePath: selectedFile,
    }
    autoLinkContextRef.current = context
    setAutoLinkOpen(true)
    setAutoLinkLoading(true)
    setAutoLinkResult(null)
    setAutoLinkApplyError(null)

    try {
      await flushPendingSave(context.filePath)
      if (!isCurrentAutoLinkContext(context)) return
      const result = await prepareAutoLinkReview({
        projectPath: context.projectPath,
        filePath: context.filePath,
        fileContent: liveDraftRef.current,
        fileTree,
        llmConfig,
      })
      if (!isCurrentAutoLinkContext(context)) return
      if (result.status === "ready") context.contentHash = result.contentHash
      setAutoLinkResult(result)
    } catch (error) {
      if (!isCurrentAutoLinkContext(context)) return
      setAutoLinkResult({
        status: "error",
        message: errorMessage(error),
      })
    } finally {
      if (isCurrentAutoLinkContext(context)) setAutoLinkLoading(false)
    }
  }, [
    fileLoadFailed,
    fileTree,
    flushPendingSave,
    isCurrentAutoLinkContext,
    llmConfig,
    project,
    selectedFile,
  ])

  const handleApplyAutoLinks = useCallback(
    async (links: LinkEntry[]) => {
      const context = autoLinkContextRef.current
      if (!context || links.length === 0) return
      setAutoLinkApplying(true)
      setAutoLinkApplyError(null)
      try {
        await flushPendingSave(context.filePath)
        if (!isCurrentAutoLinkContext(context)) return
        await applyWikilinks(
          context.projectPath,
          context.filePath,
          links,
          { expectedContentHash: context.contentHash },
        )
        if (!isCurrentAutoLinkContext(context)) return
        const updatedContent = await readFile(context.filePath)
        if (!isCurrentAutoLinkContext(context)) return

        lastLoadedRef.current = updatedContent
        liveDraftRef.current = updatedContent
        setFileContent(updatedContent)
        setHasLiveContent(updatedContent.trim().length > 0)
        setAutoLinkApplying(false)
        setAutoLinkOpen(false)
        setAutoLinkResult(null)
        autoLinkContextRef.current = null
      } catch (error) {
        if (isCurrentAutoLinkContext(context)) {
          setAutoLinkApplyError(errorMessage(error))
        }
      } finally {
        if (isCurrentAutoLinkContext(context)) setAutoLinkApplying(false)
      }
    },
    [flushPendingSave, isCurrentAutoLinkContext, setFileContent],
  )

  const handleIgnoreAutoLinkTerm = useCallback(async (term: string) => {
    const context = autoLinkContextRef.current
    if (!context) return
    setAutoLinkApplyError(null)
    try {
      await addIgnoredTerm(context.projectPath, term)
      if (!isCurrentAutoLinkContext(context)) return
      setAutoLinkResult((current) => {
        if (current?.status !== "ready") return current
        const normalizedTerm = term.trim().toLowerCase()
          return reviewResultAfterFiltering(
            current.suggestions.filter(
            (suggestion) =>
              suggestion.term.trim().toLowerCase() !== normalizedTerm,
            ),
            current.contentHash,
          )
      })
    } catch (error) {
      if (isCurrentAutoLinkContext(context)) {
        setAutoLinkApplyError(errorMessage(error))
      }
    }
  }, [isCurrentAutoLinkContext])

  const handleIgnoreAutoLinkPair = useCallback(
    async (term: string, target: string) => {
      const context = autoLinkContextRef.current
      if (!context) return
      setAutoLinkApplyError(null)
      try {
        await addIgnoredPair(context.projectPath, { term, target })
        if (!isCurrentAutoLinkContext(context)) return
        setAutoLinkResult((current) => {
          if (current?.status !== "ready") return current
          const suggestions = current.suggestions.flatMap(
            (suggestion): AutoLinkSuggestion[] => {
              if (
                suggestion.term.trim().toLowerCase()
                !== term.trim().toLowerCase()
              ) {
                return [suggestion]
              }
              const alternatives = suggestion.alternatives.filter(
                (alternative) =>
                  alternative.target.toLowerCase() !== target.toLowerCase(),
              )
              const selected = alternatives[0]
              if (!selected) return []
              return [{
                ...suggestion,
                id: `${suggestion.term}\u0000${selected.target}`,
                selectedTarget: selected.target,
                preferredTarget:
                  suggestion.preferredTarget?.toLowerCase()
                    === target.toLowerCase()
                    ? null
                    : suggestion.preferredTarget,
                alternatives,
                band: selected.band,
                selectedByDefault: selected.band === "high",
                reason: selected.reason,
              }]
            },
          )
          return reviewResultAfterFiltering(suggestions, current.contentHash)
        })
      } catch (error) {
        if (isCurrentAutoLinkContext(context)) {
          setAutoLinkApplyError(errorMessage(error))
        }
      }
    },
    [isCurrentAutoLinkContext],
  )

  const handleAutoLinkOpenChange = useCallback((open: boolean) => {
    setAutoLinkOpen(open)
    if (open) return
    autoLinkContextRef.current = null
    setAutoLinkLoading(false)
    setAutoLinkApplying(false)
    setAutoLinkResult(null)
    setAutoLinkApplyError(null)
  }, [])

  const handleClosePreview = useCallback(async () => {
    if (!selectedFile) return
    try {
      await flushPendingSave(selectedFile)
      if (useWikiStore.getState().selectedFile === selectedFile) {
        closePreview()
      }
    } catch (error) {
      console.error("Failed to save before closing preview:", error)
    }
  }, [closePreview, flushPendingSave, selectedFile])

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
  const fileName = externalPreview?.path === selectedFile
    ? externalPreview.title
    : getFileName(selectedFile)
  const canAutoLink = Boolean(
    project &&
    externalPreview?.path !== selectedFile &&
    category === "markdown" &&
    isWikiMarkdownFile(selectedFile, project.path),
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={selectedFile}
        >
          {fileName}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {canAutoLink && (
            <TooltipProvider delay={300}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-xs"
                      aria-label="Auto Link"
                      disabled={
                        fileLoadFailed ||
                        !hasLiveContent ||
                        autoLinkLoading ||
                        autoLinkApplying
                      }
                      onClick={() => void handleAutoLink()}
                    />
                  }
                >
                  <WandSparkles />
                </TooltipTrigger>
                <TooltipContent side="bottom">Auto Link</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close preview"
            onClick={() => void handleClosePreview()}
          >
            <X />
          </Button>
        </div>
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

      <AutoLinkReviewDialog
        open={autoLinkOpen}
        result={autoLinkResult}
        loading={autoLinkLoading}
        applying={autoLinkApplying}
        applyError={autoLinkApplyError}
        onOpenChange={handleAutoLinkOpenChange}
        onRetry={handleAutoLink}
        onApply={handleApplyAutoLinks}
        onIgnoreTerm={handleIgnoreAutoLinkTerm}
        onIgnorePair={handleIgnoreAutoLinkPair}
      />
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

function isWikiMarkdownFile(filePath: string, projectPath: string): boolean {
  const file = normalizePath(filePath)
  const project = normalizePath(projectPath).replace(/\/+$/, "")
  return file.startsWith(`${project}/wiki/`) && file.endsWith(".md")
}

function reviewResultAfterFiltering(
  suggestions: AutoLinkSuggestion[],
  contentHash: string,
): AutoLinkReviewResult {
  return suggestions.length > 0
    ? { status: "ready", suggestions, contentHash }
    : { status: "none", message: "No link suggestions found." }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
