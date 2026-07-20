import { useState, useCallback, useEffect, useMemo, useRef } from "react"
import {
  Link2Off,
  Unlink,
  ArrowUpRight,
  AlertTriangle,
  Info,
  RefreshCw,
  CheckCircle2,
  BrainCircuit,
  Wrench,
  Trash2,
  Link,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { runStructuralLint, runSemanticLint } from "@/lib/lint"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import {
  appendWikilink,
  ensureBrokenLinkStub,
  rewriteWikilinkTarget,
} from "@/lib/lint-fixes"
import { useTranslation } from "react-i18next"

export function groupLintResultsForDisplay(results: readonly LintItem[]): {
  warnings: LintItem[]
  infos: LintItem[]
} {
  const warnings: LintItem[] = []
  const infos: LintItem[] = []

  results.forEach((result) => {
    if (result.severity === "warning") {
      warnings.push(result)
    } else {
      infos.push(result)
    }
  })

  return { warnings, infos }
}

export function shouldShowLintResults(hasRun: boolean, itemCount: number): boolean {
  return hasRun || itemCount > 0
}

export function LintView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)

  // Dynamic type config based on i18n
  const typeConfig = useMemo(() => ({
    orphan: { icon: Unlink, label: t("lint.typeLabels.orphan") },
    "broken-link": { icon: Link2Off, label: t("lint.typeLabels.broken-link") },
    "no-outlinks": { icon: ArrowUpRight, label: t("lint.typeLabels.no-outlinks") },
    semantic: { icon: BrainCircuit, label: t("lint.typeLabels.semantic") },
  }), [t])

  const items = useLintStore((s) => s.items)
  const addLintItems = useLintStore((s) => s.addItems)
  const removeLintItems = useLintStore((s) => s.removeItems)
  const clearLintItems = useLintStore((s) => s.clearItems)

  const [running, setRunning] = useState(false)
  const [lintProgress, setLintProgress] = useState<{ completed: number; total: number } | null>(null)
  const [hasRun, setHasRun] = useState(false)
  const [runSemantic, setRunSemantic] = useState(false)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [batchFixing, setBatchFixing] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [selectedLintIds, setSelectedLintIds] = useState<Set<string>>(() => new Set())
  const lintAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => lintAbortRef.current?.abort(), [])

  const handleRunLint = useCallback(async () => {
    if (!project || running) return
    const pp = normalizePath(project.path)
    setRunning(true)
    setFixError(null)
    setLintProgress(null)
    setSelectedLintIds(new Set())
    clearLintItems()
    const controller = new AbortController()
    lintAbortRef.current = controller
    try {
      const structural = await runStructuralLint(pp, {
        signal: controller.signal,
        onProgress: (completed, total) => setLintProgress({ completed, total }),
      })
      let all = structural

      if (runSemantic && hasUsableLlm(llmConfig)) {
        const semantic = await runSemanticLint(pp, llmConfig, controller.signal)
        all = [...structural, ...semantic]
      }

      addLintItems(all)
      setHasRun(true)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        console.error("Lint failed:", err)
      }
    } finally {
      lintAbortRef.current = null
      setRunning(false)
      setLintProgress(null)
    }
  }, [project, llmConfig, running, runSemantic, addLintItems, clearLintItems])

  async function handleOpenPage(page: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/${page}`,
      `${pp}/wiki/${page}.md`,
    ]
    for (const path of candidates) {
      try {
        const content = await readFile(path)
        openFileInPreview(path, content)
        return
      } catch {
        // try next
      }
    }
    openFileInPreview(candidates[0], `Unable to load: ${page}`)
  }

  const addLintItemToReview = useCallback((item: LintItem) => {
    switch (item.type) {
      case "broken-link": {
        const pp = project ? normalizePath(project.path) : ""
        useReviewStore.getState().addItem({
          type: "confirm",
          title: t("lint.fixBrokenLink", { page: item.page }),
          description: item.detail,
          affectedPages: [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            ...(pp ? [{ label: t("lint.deletePage"), action: `delete:${pp}/wiki/${item.page}` }] : []),
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
        break
      }
      case "orphan":
      case "no-outlinks": {
        useReviewStore.getState().addItem({
          type: "suggestion",
          title: t("lint.addCrossRefs", { page: item.page }),
          description: item.type === "no-outlinks" ? t("lint.addCrossRefsDescription") : item.detail,
          affectedPages: [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
        break
      }
      default: {
        useReviewStore.getState().addItem({
          type: "confirm",
          title: item.detail.slice(0, 80),
          description: item.detail,
          affectedPages: item.affectedPages ?? [item.page],
          options: [
            { label: t("lint.openEdit"), action: `open:${item.page}` },
            { label: t("lint.skip"), action: "Skip" },
          ],
        })
      }
    }
  }, [project, t])

  async function handleFix(item: LintItem, refreshTree = true) {
    if (!project) return
    const pp = normalizePath(project.path)
    setFixingId(item.id)
    setFixError(null)

    try {
      switch (item.type) {
        case "orphan": {
          if (item.suggestedSource) {
            const sourcePath = `${pp}/wiki/${item.suggestedSource}`
            const content = await readFile(sourcePath)
            await writeFile(sourcePath, appendWikilink(content, item.page))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "broken-link": {
          const pagePath = `${pp}/wiki/${item.page}`
          if (item.brokenTarget && item.suggestedTarget) {
            const content = await readFile(pagePath)
            await writeFile(pagePath, rewriteWikilinkTarget(content, item.brokenTarget, item.suggestedTarget))
          } else if (item.brokenTarget) {
            const content = await readFile(pagePath)
            const stub = await ensureBrokenLinkStub(pp, item.brokenTarget)
            await writeFile(pagePath, rewriteWikilinkTarget(content, item.brokenTarget, stub.relativePath))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "no-outlinks": {
          if (item.suggestedTarget) {
            const pagePath = `${pp}/wiki/${item.page}`
            const content = await readFile(pagePath)
            await writeFile(pagePath, appendWikilink(content, item.suggestedTarget))
          } else {
            addLintItemToReview(item)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        default: {
          // Semantic issues → send to Review for manual resolution
          addLintItemToReview(item)
          useLintStore.getState().removeItem(item.id)
          break
        }
      }

      if (refreshTree) {
        await refreshProjectFileTree(pp, {
          projectId: project.id,
          bumpDataVersion: true,
        })
      }
    } catch (err) {
      console.error("Fix failed:", err)
      setFixError(err instanceof Error ? err.message : String(err))
    } finally {
      setFixingId(null)
    }
  }

  async function handleDeleteOrphan(item: LintItem) {
    if (!project) return
    const pp = normalizePath(project.path)
    const pagePath = `${pp}/wiki/${item.page}`
    const confirmed = window.confirm(t("lint.deleteOrphanConfirm", { page: item.page }))
    if (!confirmed) return

    try {
      // Full cascade: file + embedding chunks + every reference to
      // the page across the wiki (body wikilinks, index.md listing,
      // `related:` frontmatter arrays). Even though "orphan" by lint
      // means no incoming wikilinks were detected, `related:` slugs
      // and index.md entries can still point at it — the orphan
      // detector only walks body refs.
      const { cascadeDeleteWikiPagesWithRefs } = await import(
        "@/lib/wiki-page-delete"
      )
      await cascadeDeleteWikiPagesWithRefs(pp, [pagePath])
      useLintStore.getState().removeItem(item.id)
      await refreshProjectFileTree(pp, {
        projectId: project.id,
        bumpDataVersion: true,
      })
    } catch (err) {
      console.error("Delete failed:", err)
    }
  }

  const { warnings, infos } = useMemo(
    () => groupLintResultsForDisplay(items),
    [items],
  )
  const showResults = shouldShowLintResults(hasRun, items.length)
  const selectedLintItems = useMemo(
    () => items.filter((item) => selectedLintIds.has(item.id)),
    [items, selectedLintIds],
  )
  const allLintSelected = items.length > 0 && selectedLintItems.length === items.length
  const isFixing = fixingId !== null || batchFixing

  const setLintSelected = useCallback((id: string, selected: boolean) => {
    setSelectedLintIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const toggleAllLint = useCallback(() => {
    setSelectedLintIds((prev) => {
      const next = new Set(prev)
      if (allLintSelected) {
        for (const item of items) next.delete(item.id)
      } else {
        for (const item of items) next.add(item.id)
      }
      return next
    })
  }, [allLintSelected, items])

  const handleBatchDismiss = useCallback(() => {
    const ids = selectedLintItems.map((item) => item.id)
    removeLintItems(ids)
    setSelectedLintIds(new Set())
  }, [removeLintItems, selectedLintItems])

  const handleBatchSendToReview = useCallback(() => {
    for (const item of selectedLintItems) {
      addLintItemToReview(item)
    }
    removeLintItems(selectedLintItems.map((item) => item.id))
    setSelectedLintIds(new Set())
  }, [addLintItemToReview, removeLintItems, selectedLintItems])

  const handleBatchFix = useCallback(async () => {
    if (!project || batchFixing || selectedLintItems.length === 0) return
    setBatchFixing(true)
    setFixError(null)
    const pp = normalizePath(project.path)
    let filesystemChanged = false
    try {
      const edits = new Map<string, Array<{ id: string; apply: (content: string) => string }>>()
      const queueEdit = (path: string, id: string, apply: (content: string) => string) => {
        const pending = edits.get(path) ?? []
        pending.push({ id, apply })
        edits.set(path, pending)
      }

      for (const item of selectedLintItems) {
        if (item.type === "orphan" && item.suggestedSource) {
          queueEdit(`${pp}/wiki/${item.suggestedSource}`, item.id, (content) => appendWikilink(content, item.page))
        } else if (item.type === "no-outlinks" && item.suggestedTarget) {
          queueEdit(`${pp}/wiki/${item.page}`, item.id, (content) => appendWikilink(content, item.suggestedTarget!))
        } else if (item.type === "broken-link" && item.brokenTarget) {
          const stub = item.suggestedTarget ? null : await ensureBrokenLinkStub(pp, item.brokenTarget)
          if (stub) filesystemChanged = true
          const target = item.suggestedTarget ?? stub!.relativePath
          queueEdit(`${pp}/wiki/${item.page}`, item.id, (content) =>
            rewriteWikilinkTarget(content, item.brokenTarget!, target))
        } else {
          addLintItemToReview(item)
          removeLintItems([item.id])
        }
      }

      // Multiple findings can target the same page. Apply their transforms in
      // memory and write that page once, avoiding lost updates and N full reads.
      for (const [path, pending] of edits) {
        const original = await readFile(path)
        const updated = pending.reduce((content, edit) => edit.apply(content), original)
        if (updated !== original) {
          await writeFile(path, updated)
          filesystemChanged = true
        }
        removeLintItems(pending.map((edit) => edit.id))
      }
      setSelectedLintIds(new Set())
    } catch (err) {
      console.error("Batch fix failed:", err)
      setFixError(err instanceof Error ? err.message : String(err))
    } finally {
      // Refresh even after a partial failure: earlier files or stubs may have
      // been written successfully. The expensive recursive rebuild still runs
      // at most once for the whole batch.
      if (filesystemChanged) {
        await refreshProjectFileTree(pp, {
          projectId: project.id,
          bumpDataVersion: true,
        })
      }
      setBatchFixing(false)
    }
  }, [addLintItemToReview, batchFixing, project, removeLintItems, selectedLintItems])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t("lint.title")}</h2>
          {showResults && items.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {items.length === 1 ? t("lint.issues", { count: items.length }) : t("lint.issues_plural", { count: items.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={runSemantic}
              onChange={(e) => setRunSemantic(e.target.checked)}
            />
            {t("lint.semantic")}
          </label>
          <Button
            size="sm"
            variant={running ? "outline" : "default"}
            onClick={running ? () => lintAbortRef.current?.abort() : handleRunLint}
            disabled={!project}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
            {running
              ? lintProgress && lintProgress.total > 0
                ? t("lint.cancelProgress", { completed: lintProgress.completed, total: lintProgress.total })
                : t("lint.cancel")
              : t("lint.runLint")}
          </Button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2 text-xs">
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={allLintSelected}
              onChange={toggleAllLint}
            />
            {t("lint.selectAll")}
          </label>
          <span className="text-muted-foreground">
            {t("lint.selectedCount", { count: selectedLintItems.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchFix}
          >
            {batchFixing ? t("lint.fixing") : t("lint.fixSelected")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchSendToReview}
          >
            {t("lint.sendSelectedToReview")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            disabled={selectedLintItems.length === 0 || isFixing}
            onClick={handleBatchDismiss}
          >
            {t("lint.ignoreSelected")}
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {fixError && (
          <div className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("lint.fixFailed", { error: fixError })}
          </div>
        )}
        {!showResults ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>{t("lint.runLintHint")}</p>
            <p className="text-xs">{t("lint.runLintDescription")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">{t("lint.allClear")}</p>
            <p className="text-xs">{t("lint.noIssues")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {warnings.length > 0 && (
              <SectionHeader icon={AlertTriangle} label={t("lint.warnings")} count={warnings.length} color="text-amber-500" t={t} />
            )}
            {warnings.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                selected={selectedLintIds.has(item.id)}
                onSelectedChange={setLintSelected}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
            {infos.length > 0 && (
              <SectionHeader icon={Info} label={t("lint.info")} count={infos.length} color="text-blue-500" t={t} />
            )}
            {infos.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                selected={selectedLintIds.has(item.id)}
                onSelectedChange={setLintSelected}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  color,
  t,
}: {
  icon: typeof AlertTriangle
  label: string
  count: number
  color: string
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <div className={`flex items-center gap-1.5 px-1 py-1 text-xs font-semibold ${color}`}>
      <Icon className="h-3.5 w-3.5" />
      {t("lint.sectionCount", { label, count })}
    </div>
  )
}

function LintCard({
  item,
  fixing,
  selected,
  onSelectedChange,
  onOpenPage,
  onFix,
  onDelete,
  typeConfig,
  t,
}: {
  item: LintItem
  fixing: boolean
  selected: boolean
  onSelectedChange: (id: string, selected: boolean) => void
  onOpenPage: (page: string) => void
  onFix: (item: LintItem) => void
  onDelete?: (item: LintItem) => void
  typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }>
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const config = typeConfig[item.type] ?? typeConfig.semantic
  const Icon = config.icon

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-1.5 flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5"
          checked={selected}
          onChange={(event) => onSelectedChange(item.id, event.target.checked)}
          aria-label={t("lint.selectItem", { page: item.page })}
        />
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            item.severity === "warning" ? "text-amber-500" : "text-blue-500"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{item.page}</div>
          <div className="text-[11px] text-muted-foreground">{config.label}</div>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{item.detail}</p>

      {(item.suggestedTarget || item.suggestedSource) && (
        <div className="mb-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
          <div className="flex items-start gap-1.5">
            <Link className="mt-0.5 h-3 w-3 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">
                {item.suggestedSource
                  ? t("lint.suggestedSource", { page: item.suggestedSource })
                  : t("lint.suggestedTarget", { page: item.suggestedTarget })}
              </div>
            </div>
          </div>
        </div>
      )}

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {item.affectedPages.map((page) => (
            <button
              key={page}
              type="button"
              onClick={() => onOpenPage(page)}
              className="inline-flex items-center gap-0.5 rounded bg-accent/60 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-accent transition-colors"
            >
              {page}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          onClick={() => onOpenPage(item.page)}
        >
          {t("lint.open")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          disabled={fixing}
          onClick={() => onFix(item)}
        >
          <Wrench className="h-3 w-3" />
          {fixing ? t("lint.fixing") : t("lint.fix")}
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
            onClick={() => onDelete(item)}
          >
            <Trash2 className="h-3 w-3" />
            {t("lint.delete")}
          </Button>
        )}
      </div>
    </div>
  )
}
