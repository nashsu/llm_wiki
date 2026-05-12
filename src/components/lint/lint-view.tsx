import { useState, useCallback, useEffect } from "react"
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
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { runStructuralLint, runSemanticLint, type LintResult } from "@/lib/lint"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { WikiHealthReport } from "@/lib/wiki-health-report"

interface SmokeRetentionSummary {
  totalRuns: number
  failedOrGuardedRunCount: number
  deleteCandidateCount: number
  deletedCount: number
  monthlySummary: SmokeMonthlySummary | null
}

interface SmokeMonthlySummary {
  month: string
  path: string
  latestPath: string
  totalRuns: number
  passedRuns: number
  failedOrGuardedRuns: number
}

const typeConfig: Record<string, { icon: typeof AlertTriangle; label: string }> = {
  orphan: { icon: Unlink, label: "Orphan Page" },
  "broken-link": { icon: Link2Off, label: "Broken Link" },
  "no-outlinks": { icon: ArrowUpRight, label: "No Outbound Links" },
  semantic: { icon: BrainCircuit, label: "Semantic Issue" },
}

export function LintView() {
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const [results, setResults] = useState<LintResult[]>([])
  const [running, setRunning] = useState(false)
  const [hasRun, setHasRun] = useState(false)
  const [runSemantic, setRunSemantic] = useState(false)
  const [fixingId, setFixingId] = useState<string | null>(null)
  const [operationalSurface, setOperationalSurface] = useState<WikiHealthReport["operationalSurface"] | null>(null)
  const [smokeRetention, setSmokeRetention] = useState<SmokeRetentionSummary | null>(null)
  const [surfaceError, setSurfaceError] = useState<string | null>(null)

  const loadOperationalSurface = useCallback(async () => {
    if (!project) {
      setOperationalSurface(null)
      setSmokeRetention(null)
      setSurfaceError(null)
      return
    }
    try {
      const pp = normalizePath(project.path)
      const health = JSON.parse(await readFile(`${pp}/.llm-wiki/health.json`)) as Partial<WikiHealthReport>
      setOperationalSurface(health.operationalSurface ?? null)
      setSurfaceError(health.operationalSurface ? null : "Operational surface data is not available yet.")
      const latestPointer = health.operationalSurface?.runtimeProofRetention.liveIngestSmoke.latestPointer
        ?? ".llm-wiki/runtime/codex-live-ingest-smoke-latest.json"
      setSmokeRetention(await loadSmokeRetentionSummary(pp, latestPointer))
    } catch (err) {
      setOperationalSurface(null)
      setSmokeRetention(null)
      setSurfaceError(err instanceof Error ? err.message : String(err))
    }
  }, [project])

  useEffect(() => {
    void loadOperationalSurface()
  }, [loadOperationalSurface])

  const handleOpenRuntimeFile = useCallback(async (relativePath: string) => {
    if (!project) return
    const fullPath = `${normalizePath(project.path)}/${relativePath}`
    setActiveView("wiki")
    setSelectedFile(fullPath)
    setFileContent(await readFile(fullPath))
  }, [project, setActiveView, setFileContent, setSelectedFile])

  const handleRunLint = useCallback(async () => {
    if (!project || running) return
    const pp = normalizePath(project.path)
    setRunning(true)
    setResults([])
    try {
      const structural = await runStructuralLint(pp)
      let all = structural

      if (runSemantic && hasUsableLlm(llmConfig)) {
        const semantic = await runSemanticLint(pp, llmConfig)
        all = [...structural, ...semantic]
      }

      setResults(all)
      setHasRun(true)
      await loadOperationalSurface()
    } catch (err) {
      console.error("Lint failed:", err)
    } finally {
      setRunning(false)
    }
  }, [project, llmConfig, running, runSemantic, loadOperationalSurface])

  async function handleOpenPage(page: string) {
    if (!project) return
    const pp = normalizePath(project.path)
    const candidates = [
      `${pp}/wiki/${page}`,
      `${pp}/wiki/${page}.md`,
    ]
    setActiveView("wiki")
    for (const path of candidates) {
      try {
        const content = await readFile(path)
        setSelectedFile(path)
        setFileContent(content)
        return
      } catch {
        // try next
      }
    }
    setSelectedFile(candidates[0])
    setFileContent(`Unable to load: ${page}`)
  }

  async function handleFix(result: LintResult, index: number) {
    if (!project) return
    const pp = normalizePath(project.path)
    const id = `${result.type}-${index}`
    setFixingId(id)

    try {
      switch (result.type) {
        case "orphan": {
          // Add a link to this page from index.md
          const indexPath = `${pp}/wiki/index.md`
          let indexContent = ""
          try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }

          const pageName = result.page.replace(".md", "").replace(/^.*\//, "")
          const entry = `- [[${pageName}]]`
          if (!indexContent.includes(entry)) {
            indexContent = indexContent.trimEnd() + "\n" + entry + "\n"
            await writeFile(indexPath, indexContent)
          }
          // Remove from results
          setResults((prev) => prev.filter((_, i) => i !== index))
          break
        }

        case "broken-link": {
          // Option: remove the broken link from the page, or send to Review for manual fix
          const pagePath = `${pp}/wiki/${result.page}`
          useReviewStore.getState().addItem({
            type: "confirm",
            title: `Fix broken link in ${result.page}`,
            description: result.detail,
            affectedPages: [result.page],
            options: [
              { label: "Open & Edit", action: `open:${result.page}` },
              { label: "Delete Page", action: `delete:${pagePath}` },
              { label: "Skip", action: "Skip" },
            ],
          })
          setResults((prev) => prev.filter((_, i) => i !== index))
          break
        }

        case "no-outlinks": {
          // Send to Review — user should add links manually
          useReviewStore.getState().addItem({
            type: "suggestion",
            title: `Add cross-references to ${result.page}`,
            description: "This page has no outbound [[wikilinks]] or frontmatter related references. Consider adding cross-references to related entities and concepts.",
            affectedPages: [result.page],
            options: [
              { label: "Open & Edit", action: `open:${result.page}` },
              { label: "Skip", action: "Skip" },
            ],
          })
          setResults((prev) => prev.filter((_, i) => i !== index))
          break
        }

        default: {
          // Semantic issues → send to Review for manual resolution
          useReviewStore.getState().addItem({
            type: "confirm",
            title: result.detail.slice(0, 80),
            description: result.detail,
            affectedPages: result.affectedPages ?? [result.page],
            options: [
              { label: "Open & Edit", action: `open:${result.page}` },
              { label: "Skip", action: "Skip" },
            ],
          })
          setResults((prev) => prev.filter((_, i) => i !== index))
          break
        }
      }

      // Refresh tree
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Fix failed:", err)
    } finally {
      setFixingId(null)
    }
  }

  async function handleDeleteOrphan(result: LintResult, index: number) {
    if (!project) return
    const pp = normalizePath(project.path)
    const pagePath = `${pp}/wiki/${result.page}`
    const confirmed = window.confirm(`Delete orphan page "${result.page}"?`)
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
      setResults((prev) => prev.filter((_, i) => i !== index))
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Delete failed:", err)
    }
  }

  const warnings = results.filter((r) => r.severity === "warning")
  const infos = results.filter((r) => r.severity === "info")

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Wiki Lint</h2>
          {hasRun && results.length > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              {results.length} issue{results.length !== 1 ? "s" : ""}
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
            Semantic (LLM)
          </label>
          <Button
            size="sm"
            onClick={handleRunLint}
            disabled={running || !project}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
            {running ? "Running..." : "Run Lint"}
          </Button>
        </div>
      </div>

      {project && (
        <OperationalSurfaceSummary
          surface={operationalSurface}
          smokeRetention={smokeRetention}
          error={surfaceError}
          onRefresh={loadOperationalSurface}
          onOpenRuntimeFile={handleOpenRuntimeFile}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {!hasRun ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>Run lint to check wiki health</p>
            <p className="text-xs">Checks for orphan pages, broken links, and more</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">All clear!</p>
            <p className="text-xs">No issues found.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {warnings.length > 0 && (
              <SectionHeader icon={AlertTriangle} label="Warnings" count={warnings.length} color="text-amber-500" />
            )}
            {warnings.map((result, i) => (
              <LintCard
                key={`warn-${i}`}
                result={result}
                index={i}
                fixing={fixingId === `${result.type}-${i}`}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={result.type === "orphan" ? handleDeleteOrphan : undefined}
              />
            ))}
            {infos.length > 0 && (
              <SectionHeader icon={Info} label="Info" count={infos.length} color="text-blue-500" />
            )}
            {infos.map((result, i) => {
              const realIndex = warnings.length + i
              return (
                <LintCard
                  key={`info-${i}`}
                  result={result}
                  index={realIndex}
                  fixing={fixingId === `${result.type}-${realIndex}`}
                  onOpenPage={handleOpenPage}
                  onFix={handleFix}
                  onDelete={result.type === "orphan" ? handleDeleteOrphan : undefined}
                />
              )
            })}
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
}: {
  icon: typeof AlertTriangle
  label: string
  count: number
  color: string
}) {
  return (
    <div className={`flex items-center gap-1.5 px-1 py-1 text-xs font-semibold ${color}`}>
      <Icon className="h-3.5 w-3.5" />
      {label} ({count})
    </div>
  )
}

function LintCard({
  result,
  index,
  fixing,
  onOpenPage,
  onFix,
  onDelete,
}: {
  result: LintResult
  index: number
  fixing: boolean
  onOpenPage: (page: string) => void
  onFix: (result: LintResult, index: number) => void
  onDelete?: (result: LintResult, index: number) => void
}) {
  const config = typeConfig[result.type] ?? typeConfig.semantic
  const Icon = config.icon

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-1.5 flex items-start gap-2">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            result.severity === "warning" ? "text-amber-500" : "text-blue-500"
          }`}
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{result.page}</div>
          <div className="text-[11px] text-muted-foreground">{config.label}</div>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted-foreground">{result.detail}</p>

      {result.affectedPages && result.affectedPages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {result.affectedPages.map((page) => (
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
          onClick={() => onOpenPage(result.page)}
        >
          Open
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs gap-1"
          disabled={fixing}
          onClick={() => onFix(result, index)}
        >
          <Wrench className="h-3 w-3" />
          {fixing ? "Fixing..." : "Fix"}
        </Button>
        {onDelete && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-xs gap-1 text-destructive hover:text-destructive"
            onClick={() => onDelete(result, index)}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}

function OperationalSurfaceSummary({
  surface,
  smokeRetention,
  error,
  onRefresh,
  onOpenRuntimeFile,
}: {
  surface: WikiHealthReport["operationalSurface"] | null
  smokeRetention: SmokeRetentionSummary | null
  error: string | null
  onRefresh: () => void
  onOpenRuntimeFile: (relativePath: string) => void
}) {
  const statusClass = surfaceStatusClass(surface?.status ?? (error ? "warn" : "ok"))
  return (
    <div className="border-b bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Operational surface</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}>
            {surface?.status ?? (error ? "warn" : "ok")}
          </span>
          {surface && <RecoveryPill recovery={surface.recovery} />}
        </div>
        <Button size="sm" variant="ghost" onClick={() => onRefresh()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {surface ? (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-6">
          <SurfaceMetric
            label="Ingest surface"
            value={`${formatBytes(surface.ingestPromptSurfaceBytes)} / ${surface.ingestPromptSurfaceStatus}`}
          />
          <SurfaceMetric
            label="Schema"
            value={`${surface.docs.schema.lineCount} lines / ${surface.docs.schema.status}`}
          />
          <SurfaceMetric
            label="Overview"
            value={`${surface.docs.overview.lineCount} lines / ${surface.docs.overview.status}`}
          />
          <SurfaceMetric
            label="Log"
            value={`${surface.docs.log.entryCount} entries / ${surface.docs.log.rolloverNeeded ? "rollover needed" : "rollover ok"}`}
          />
          <SurfaceMetric
            label="Recovery"
            value={`${formatRecoveryTotals(surface.recovery)} · week ${surface.recovery.currentWeek.weekKey}`}
          />
          <SurfaceMetric
            label="Proof retention"
            value={formatSmokeRetention(smokeRetention)}
            note={formatSmokeMonthly(smokeRetention?.monthlySummary ?? null)}
            actionLabel={smokeRetention?.monthlySummary ? "Open" : undefined}
            onAction={smokeRetention?.monthlySummary
              ? () => onOpenRuntimeFile(smokeRetention.monthlySummary!.latestPath)
              : undefined}
          />
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {error ?? "Open or refresh a project health report to show surface status."}
        </p>
      )}
    </div>
  )
}

function RecoveryPill({ recovery }: { recovery: WikiHealthReport["operationalSurface"]["recovery"] }) {
  return (
    <span className="rounded-full bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground">
      This week {formatRecoveryWeek(recovery)}
    </span>
  )
}

function SurfaceMetric({
  label,
  value,
  note,
  actionLabel,
  onAction,
}: {
  label: string
  value: string
  note?: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="rounded border border-border/60 bg-background/60 px-3 py-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
      {(note || onAction) && (
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          {note && <span className="truncate">{note}</span>}
          {onAction && (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 font-medium text-primary hover:underline"
              onClick={onAction}
            >
              {actionLabel ?? "Open"}
              <ArrowUpRight className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function formatRecoveryTotals(recovery: WikiHealthReport["operationalSurface"]["recovery"]) {
  return `${recovery.malformedFileFocusedRetryRecovered}/${recovery.malformedFileFocusedRetryAttempts} retries · ${recovery.oneFileFallbackRecovered}/${recovery.oneFileFallbackAttempts} fallback`
}

function formatRecoveryWeek(recovery: WikiHealthReport["operationalSurface"]["recovery"]) {
  const week = recovery.currentWeek
  return `${week.malformedFileFocusedRetryRecovered}/${week.malformedFileFocusedRetryAttempts} retry · ${week.oneFileFallbackRecovered}/${week.oneFileFallbackAttempts} fallback`
}

function formatSmokeRetention(summary: SmokeRetentionSummary | null) {
  if (!summary) return "not captured"
  const deleted = summary.deletedCount > 0 ? ` · ${summary.deletedCount} deleted` : ""
  return `${summary.deleteCandidateCount} candidates · ${summary.failedOrGuardedRunCount}/${summary.totalRuns} guarded${deleted}`
}

function formatSmokeMonthly(summary: SmokeMonthlySummary | null) {
  if (!summary) return undefined
  return `Monthly ${summary.month} · ${summary.passedRuns}/${summary.totalRuns} passed`
}

async function loadSmokeRetentionSummary(projectPath: string, latestPointer: string): Promise<SmokeRetentionSummary | null> {
  try {
    const proof = JSON.parse(await readFile(`${projectPath}/${latestPointer}`)) as {
      retention?: {
        totalRuns?: number
        failedOrGuardedRuns?: unknown[]
        deleteCandidates?: unknown[]
        deleted?: unknown[]
      }
      monthlySummary?: Partial<SmokeMonthlySummary>
    }
    if (!proof.retention) return null
    return {
      totalRuns: Math.max(0, Number(proof.retention.totalRuns ?? 0)),
      failedOrGuardedRunCount: Array.isArray(proof.retention.failedOrGuardedRuns)
        ? proof.retention.failedOrGuardedRuns.length
        : 0,
      deleteCandidateCount: Array.isArray(proof.retention.deleteCandidates)
        ? proof.retention.deleteCandidates.length
        : 0,
      deletedCount: Array.isArray(proof.retention.deleted) ? proof.retention.deleted.length : 0,
      monthlySummary: normalizeSmokeMonthlySummary(proof.monthlySummary),
    }
  } catch {
    return null
  }
}

function normalizeSmokeMonthlySummary(summary: Partial<SmokeMonthlySummary> | undefined): SmokeMonthlySummary | null {
  if (!summary || typeof summary.latestPath !== "string") return null
  return {
    month: typeof summary.month === "string" ? summary.month : "unknown",
    path: typeof summary.path === "string" ? summary.path : summary.latestPath,
    latestPath: summary.latestPath,
    totalRuns: Math.max(0, Number(summary.totalRuns ?? 0)),
    passedRuns: Math.max(0, Number(summary.passedRuns ?? 0)),
    failedOrGuardedRuns: Math.max(0, Number(summary.failedOrGuardedRuns ?? 0)),
  }
}

function surfaceStatusClass(status: "ok" | "warn" | "fail") {
  if (status === "fail") return "bg-rose-500/15 text-rose-700 dark:text-rose-300"
  if (status === "warn") return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
  return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}
