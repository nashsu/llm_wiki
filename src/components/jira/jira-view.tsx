import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { openUrl } from "@tauri-apps/plugin-opener"
import { AlertTriangle, ExternalLink, FileText, FolderOpen, RefreshCw, Search as SearchIcon, X } from "lucide-react"
import { readFile, revealInFileManager } from "@/commands/fs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { JiraApiError, JiraClient } from "@/lib/jira-api"
import { isJiraConfigured, jiraBrowseUrl, resolveJiraExportDir } from "@/lib/jira-config"
import {
  exportJiraIssue,
  listExportedJiraIssues,
  type ExportedJiraIssue,
  type JiraExportProgress,
} from "@/lib/jira-export"
import {
  applyJiraFilters,
  buildJiraSearchJql,
  dedupeJiraIssuesByKey,
  effectiveJiraFilters,
  EMPTY_JIRA_FILTERS,
  extractJiraFilterOptions,
  filterJiraIssues,
  filterJqlClauses,
  hasActiveJiraFilters,
  JIRA_FILTER_KEYS,
  jiraHighlightTokens,
  mergeJiraResults,
  sanitizeJqlTextTerm,
  shouldRunSweep,
  type JiraFilterKey,
  type JiraIssueFilters,
} from "@/lib/jira-search"
import { JiraFilterCombobox } from "@/components/jira/jira-filter-combobox"
import { saveJiraConfig } from "@/lib/project-store"
import { useAppDialog } from "@/stores/app-dialog-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { JiraIssueSummary } from "@/types/jira"

const SEARCH_DEBOUNCE_MS = 300
const NARROW_RESULT_LIMIT = 50
/**
 * Fields the option-pool inventory asks for — just the five filter dimensions,
 * a fraction of the full search payload, so paging through ~1000 issues stays
 * cheap on an intranet link.
 */
const INVENTORY_FIELDS = ["project", "issuetype", "status", "assignee", "reporter"] as const
/** Hard cap on inventory pages so a misbehaving instance can't loop forever. */
const INVENTORY_MAX_PAGES = 20

type SearchStatus = "idle" | "unconfigured" | "loading" | "ready" | "error"
type ViewMode = "search" | "exported"

interface ExportCardState {
  phase: "exporting" | "done" | "error"
  completed: number
  total: number
  error?: string
}

interface SweepCursor {
  nextStartAt: number
  total: number
}

export function jiraCardMetaLine(issue: JiraIssueSummary): string {
  return [
    issue.fields?.project?.key,
    issue.fields?.issuetype?.name,
    issue.fields?.status?.name,
    issue.fields?.assignee?.displayName,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ")
}

export function exportButtonLabelKey(state: ExportCardState | undefined): string {
  if (state?.phase === "exporting") return "jira.export.exporting"
  if (state?.phase === "done") return "jira.export.reExport"
  if (state?.phase === "error") return "jira.export.retry"
  return "jira.export.export"
}

/**
 * The sweep is what turns a bare `BOX` into a hit on `DAB_box 收音`, so when it
 * actually ran the user should see how far back it looked rather than assuming
 * the list is everything that exists.
 */
export function shouldShowSweepNotice(input: {
  swept: boolean
  query: string
  scanned: number
}): boolean {
  return input.swept && sanitizeJqlTextTerm(input.query).length > 0 && input.scanned > 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Split around the matched tokens; `String.split` puts captures at odd indices. */
export function splitHighlight(
  text: string,
  tokens: readonly string[],
  matchCase: boolean,
): { value: string; match: boolean }[] {
  if (tokens.length === 0) return text ? [{ value: text, match: false }] : []
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, matchCase ? "g" : "gi")
  const parts: { value: string; match: boolean }[] = []
  text.split(pattern).forEach((value, index) => {
    if (value) parts.push({ value, match: index % 2 === 1 })
  })
  return parts
}

function JiraHighlight({ text, tokens, matchCase }: { text: string; tokens: readonly string[]; matchCase: boolean }) {
  const parts = splitHighlight(text, tokens, matchCase)
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="bg-amber-200/70 text-inherit dark:bg-amber-500/30">
            {part.value}
          </mark>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  )
}

function errorKindKey(errorKind: string | undefined): string {
  switch (errorKind) {
    case "config":
      return "jira.error.config"
    case "auth":
      return "jira.error.auth"
    case "not-found":
      return "jira.error.notFound"
    default:
      return "jira.error.network"
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof JiraApiError) return error.describe()
  return error instanceof Error ? error.message : String(error)
}

export function JiraView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const config = useWikiStore((s) => s.jiraConfig)
  const setJiraConfig = useWikiStore((s) => s.setJiraConfig)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)
  const appDialog = useAppDialog()

  const [mode, setMode] = useState<ViewMode>("search")
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [filters, setFilters] = useState<JiraIssueFilters>(EMPTY_JIRA_FILTERS)
  /** 0 until the user presses Search — an empty query alone never browses. */
  const [searchNonce, setSearchNonce] = useState(0)
  const [resultLimit, setResultLimit] = useState(NARROW_RESULT_LIMIT)
  const [status, setStatus] = useState<SearchStatus>("idle")
  const [errorText, setErrorText] = useState("")
  const [narrowIssues, setNarrowIssues] = useState<JiraIssueSummary[]>([])
  const [sweepIssues, setSweepIssues] = useState<JiraIssueSummary[]>([])
  const [sweepCursor, setSweepCursor] = useState<SweepCursor | null>(null)
  const [sweepRan, setSweepRan] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [inventoryIssues, setInventoryIssues] = useState<JiraIssueSummary[]>([])
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [exportStates, setExportStates] = useState<Record<string, ExportCardState>>({})
  const [exported, setExported] = useState<ExportedJiraIssue[]>([])
  const [exportedLoading, setExportedLoading] = useState(false)
  const [exportsVersion, setExportsVersion] = useState(0)
  const [notice, setNotice] = useState("")

  const configured = isJiraConfigured(config)
  // Identifies the query the current results belong to. `loadMoreSweep` runs
  // outside the search effect's AbortController, so it has to check this before
  // appending — otherwise a page that arrives after the user retyped would be
  // merged into the new query's list.
  const sweepSignatureRef = useRef("")

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  /**
   * Option-pool inventory: page through the scoped recent window (up to
   * maxSweepIssues, dimension fields only) once per config/refresh so the
   * dropdowns offer every person/project/type/status that actually occurs —
   * not just what the current 50-result page happens to contain. Failure is
   * silent: the pool falls back to the loaded results.
   */
  useEffect(() => {
    if (!configured) {
      setInventoryIssues([])
      return
    }
    const controller = new AbortController()
    const client = new JiraClient(config)
    const jql = buildJiraSearchJql({ query: "", scopeJql: config.scopeJql, mode: "sweep" })
    const pageSize = Math.min(Math.max(config.sweepPageSize, 50), 200)
    const ceiling = Math.max(config.maxSweepIssues, pageSize)
    setInventoryLoading(true)
    void (async () => {
      const collected: JiraIssueSummary[] = []
      let startAt = 0
      try {
        for (let page = 0; page < INVENTORY_MAX_PAGES; page += 1) {
          const response = await client.search({
            jql,
            startAt,
            maxResults: pageSize,
            fields: INVENTORY_FIELDS,
            signal: controller.signal,
          })
          collected.push(...response.issues)
          const next = startAt + response.issues.length
          if (response.issues.length === 0 || next >= Math.min(response.total, ceiling)) break
          startAt = next
        }
        if (!controller.signal.aborted) setInventoryIssues(collected)
      } catch {
        if (!controller.signal.aborted) setInventoryIssues([])
      } finally {
        if (!controller.signal.aborted) setInventoryLoading(false)
      }
    })()
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    configured,
    config.baseUrl,
    config.username,
    config.password,
    config.scopeJql,
    config.sweepPageSize,
    config.maxSweepIssues,
    exportsVersion,
  ])

  const candidates = useMemo(
    () => mergeJiraResults(narrowIssues, sweepIssues),
    [narrowIssues, sweepIssues],
  )
  const filterOptions = useMemo(
    () => extractJiraFilterOptions(dedupeJiraIssuesByKey(inventoryIssues, candidates), t("jira.filter.unassigned")),
    [inventoryIssues, candidates, t],
  )
  // A selection from the previous result set that the new results can't
  // represent would show as a blank select AND filter everything out; drop it
  // instead. The comboboxes render from this value so UI and filtering agree.
  const effectiveFilters = useMemo(
    () => effectiveJiraFilters(filters, filterOptions),
    [filters, filterOptions],
  )
  const filterClauses = useMemo(
    () => filterJqlClauses(effectiveFilters, filterOptions),
    [effectiveFilters, filterOptions],
  )
  // Arrays are new references every render — the effect below depends on this
  // stable string instead. JQL clauses cannot contain NUL.
  const filterClausesKey = filterClauses.join("\u0000")

  // `matchCase` is deliberately not a dependency: it only filters the cached
  // candidates, so toggling it must not re-query the company's Jira.
  // `filterClausesKey` IS one: a dropdown selection narrows the JQL itself, so
  // the server returns the right rows instead of the client trimming 50.
  //
  // Search is explicit: a non-empty query still auto-searches after the
  // debounce, but an empty query never loads anything by itself — the "recent
  // issues" browse happens only when the user presses Search (searchNonce > 0).
  useEffect(() => {
    const term = debouncedQuery.trim()
    const clauses = filterClausesKey ? filterClausesKey.split("\u0000") : []
    sweepSignatureRef.current = `${config.scopeJql}\u0000${term}\u0000${filterClausesKey}`
    if (!configured) {
      setStatus("unconfigured")
      setNarrowIssues([])
      setSweepIssues([])
      setSweepCursor(null)
      setSweepRan(false)
      return
    }
    if (!term && searchNonce === 0) {
      setStatus("idle")
      setNarrowIssues([])
      setSweepIssues([])
      setSweepCursor(null)
      setSweepRan(false)
      return
    }
    const controller = new AbortController()
    const client = new JiraClient(config)
    setStatus("loading")
    setErrorText("")
    void (async () => {
      try {
        const narrowResponse = await client.search({
          jql: buildJiraSearchJql({
            query: term,
            scopeJql: config.scopeJql,
            mode: "narrow",
            filterClauses: clauses,
            dimensions: config.searchDims,
          }),
          maxResults: resultLimit,
          signal: controller.signal,
        })
        let sweep: JiraIssueSummary[] = []
        let cursor: SweepCursor | null = null
        const runSweep = shouldRunSweep(narrowResponse.issues.length, term, config.sweepThreshold)
        if (runSweep) {
          const sweepResponse = await client.search({
            jql: buildJiraSearchJql({
              query: term,
              scopeJql: config.scopeJql,
              mode: "sweep",
              filterClauses: clauses,
            }),
            maxResults: config.sweepPageSize,
            signal: controller.signal,
          })
          sweep = sweepResponse.issues
          const ceiling = Math.min(sweepResponse.total, config.maxSweepIssues)
          if (sweep.length < ceiling) {
            cursor = { nextStartAt: sweep.length, total: sweepResponse.total }
          }
        }
        if (controller.signal.aborted) return
        setNarrowIssues(narrowResponse.issues)
        setSweepIssues(sweep)
        setSweepCursor(cursor)
        setSweepRan(runSweep)
        setStatus("ready")
      } catch (error) {
        if (controller.signal.aborted) return
        setErrorText(describeFailure(error))
        setStatus("error")
      }
    })()
    return () => controller.abort()
  }, [
    configured,
    debouncedQuery,
    filterClausesKey,
    searchNonce,
    resultLimit,
    config.baseUrl,
    config.username,
    config.password,
    config.scopeJql,
    config.sweepPageSize,
    config.sweepThreshold,
    config.maxSweepIssues,
    config.searchDims.title,
    config.searchDims.keyword,
    config.searchDims.issueKey,
  ])

  useEffect(() => {
    if (!project) return
    let cancelled = false
    setExportedLoading(true)
    listExportedJiraIssues(resolveJiraExportDir(project.path, config.exportDir))
      .then((items) => {
        if (!cancelled) setExported(items)
      })
      .catch(() => {
        if (!cancelled) setExported([])
      })
      .finally(() => {
        if (!cancelled) setExportedLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project, config.exportDir, exportsVersion])

  const visible = useMemo(
    () =>
      applyJiraFilters(
        filterJiraIssues(candidates, debouncedQuery, config.matchCase, config.searchDims),
        effectiveFilters,
      ),
    [candidates, debouncedQuery, config.matchCase, config.searchDims, effectiveFilters],
  )
  const tokens = useMemo(
    () => jiraHighlightTokens(debouncedQuery, config.matchCase),
    [debouncedQuery, config.matchCase],
  )

  async function handleToggleMatchCase() {
    const next = { ...config, matchCase: !config.matchCase }
    setJiraConfig(next)
    try {
      await saveJiraConfig(next)
    } catch (error) {
      console.warn("Failed to persist the Jira match-case setting:", error)
    }
  }

  /** Toggling a search dimension re-queries immediately, like the dropdowns do. */
  async function handleToggleSearchDim(dim: "title" | "keyword" | "issueKey") {
    const next = {
      ...config,
      searchDims: { ...config.searchDims, [dim]: !config.searchDims[dim] },
    }
    setJiraConfig(next)
    try {
      await saveJiraConfig(next)
    } catch (error) {
      console.warn("Failed to persist the Jira search-dimension setting:", error)
    }
  }

  async function loadMoreSweep() {
    if (!sweepCursor || loadingMore || !configured) return
    const signature = sweepSignatureRef.current
    setLoadingMore(true)
    try {
      const response = await new JiraClient(config).search({
        jql: buildJiraSearchJql({
          query: debouncedQuery,
          scopeJql: config.scopeJql,
          mode: "sweep",
          filterClauses,
        }),
        startAt: sweepCursor.nextStartAt,
        maxResults: config.sweepPageSize,
      })
      // The user retyped while this page was in flight — the search effect has
      // already replaced the list, so appending would mix two queries together.
      if (sweepSignatureRef.current !== signature) return
      const scanned = sweepCursor.nextStartAt + response.issues.length
      const ceiling = Math.min(response.total, config.maxSweepIssues)
      setSweepIssues((previous) => [...previous, ...response.issues])
      setSweepCursor(scanned < ceiling ? { nextStartAt: scanned, total: response.total } : null)
    } catch (error) {
      if (sweepSignatureRef.current !== signature) return
      setErrorText(describeFailure(error))
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleExport(key: string) {
    if (!project) return
    setNotice("")
    setExportStates((previous) => ({ ...previous, [key]: { phase: "exporting", completed: 0, total: 0 } }))
    const onProgress = ({ phase, completed, total }: JiraExportProgress) => {
      if (phase === "fetching") return
      setExportStates((previous) => ({ ...previous, [key]: { phase: "exporting", completed, total } }))
    }
    const first = await exportJiraIssue({
      projectPath: project.path,
      key,
      config,
      onProgress,
    })
    let result = first
    if (first.status === "needs-confirm") {
      const confirmed = await appDialog.confirm({
        message: t("jira.export.overwriteMessage", { path: first.existingPath }),
        confirmLabel: t("jira.export.overwriteConfirm"),
        variant: "destructive",
      })
      if (!confirmed) {
        setExportStates((previous) => {
          const next = { ...previous }
          delete next[key]
          return next
        })
        return
      }
      result = await exportJiraIssue({
        projectPath: project.path,
        key,
        config,
        overwrite: true,
        onProgress,
      })
    }
    if (result.status === "exported") {
      setExportStates((previous) => ({
        ...previous,
        [key]: { phase: "done", completed: 0, total: 0, error: undefined },
      }))
      setNotice(t("jira.export.done", { path: result.path ?? "" }))
      setExportsVersion((version) => version + 1)
      return
    }
    setExportStates((previous) => ({
      ...previous,
      [key]: {
        phase: "error",
        completed: 0,
        total: 0,
        error: result.error ?? t(errorKindKey(result.errorKind)),
      },
    }))
  }

  async function handleOpenDocument(path: string) {
    try {
      const content = await readFile(path)
      openFileInPreview(path, content)
    } catch (error) {
      await appDialog.alert({ message: t("jira.exported.openFailed", { error: describeFailure(error) }) })
    }
  }

  function handleOpenJira(key: string) {
    void openUrl(jiraBrowseUrl(config.baseUrl, key)).catch((error: unknown) => {
      console.warn("Failed to open the Jira issue in the browser:", error)
    })
  }

  function handleReveal(path: string) {
    void revealInFileManager(path).catch((error: unknown) => {
      console.warn("Failed to reveal the exported file:", error)
    })
  }

  function renderFilterCombobox(key: JiraFilterKey) {
    const options = filterOptions[key]
    if (options.length === 0) return null
    return (
      <JiraFilterCombobox
        dimension={t(`jira.filter.${key}`)}
        value={effectiveFilters[key]}
        options={options}
        allLabel={t("jira.filter.all")}
        searchPlaceholder={t("jira.filter.searchPlaceholder")}
        onChange={(value) => setFilters((previous) => ({ ...previous, [key]: value }))}
      />
    )
  }

  function renderSearch() {
    if (!configured) {
      return (
        <p className="mx-auto max-w-md text-sm text-muted-foreground">{t("jira.search.unconfigured")}</p>
      )
    }
    if (status === "error") {
      return (
        <div className="mx-auto flex max-w-xl items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="font-medium">{t("jira.error.title")}</p>
            <p className="break-all text-muted-foreground">{errorText}</p>
          </div>
        </div>
      )
    }
    if (status === "loading" && candidates.length === 0) {
      return <p className="text-sm text-muted-foreground">{t("jira.search.searching")}</p>
    }
    if (visible.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          {candidates.length > 0 ? t("jira.search.noMatch") : t("jira.search.empty")}
        </p>
      )
    }
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("jira.search.found", { count: visible.length })}</p>
        {shouldShowSweepNotice({ swept: sweepRan, query: debouncedQuery, scanned: sweepIssues.length }) && (
          <p className="text-xs text-muted-foreground">
            {t("jira.search.swept", { count: sweepIssues.length })}
            {sweepCursor === null && sweepIssues.length >= config.maxSweepIssues
              ? ` · ${t("jira.search.limitReached", { count: config.maxSweepIssues })}`
              : ""}
          </p>
        )}
        {visible.map((issue) => {
          const exportState = exportStates[issue.key]
          return (
            <div key={issue.key} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium">
                    <span className="mr-2 font-mono text-xs text-muted-foreground">{issue.key}</span>
                    <JiraHighlight
                      text={issue.fields?.summary ?? ""}
                      tokens={tokens}
                      matchCase={config.matchCase}
                    />
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{jiraCardMetaLine(issue)}</p>
                  {(issue.fields?.labels ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {(issue.fields?.labels ?? []).map((label) => (
                        <span
                          key={label}
                          className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          <JiraHighlight text={label} tokens={tokens} matchCase={config.matchCase} />
                        </span>
                      ))}
                    </div>
                  )}
                  {exportState?.phase === "error" && (
                    <p className="break-all text-xs text-destructive">{exportState.error}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 text-xs"
                    disabled={exportState?.phase === "exporting"}
                    onClick={() => void handleExport(issue.key)}
                  >
                    {t(exportButtonLabelKey(exportState))}
                  </Button>
                  {exportState?.phase === "exporting" && exportState.total > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {t("jira.export.exportingAttachments", {
                        completed: exportState.completed,
                        total: exportState.total,
                      })}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 text-xs"
                    onClick={() => handleOpenJira(issue.key)}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {t("jira.openJira")}
                  </Button>
                </div>
              </div>
            </div>
          )
        })}
        {sweepCursor !== null && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={loadingMore}
            onClick={() => void loadMoreSweep()}
          >
            {t("jira.search.loadMore")}
          </Button>
        )}
      </div>
    )
  }

  function renderExported() {
    if (exportedLoading && exported.length === 0) {
      return <p className="text-sm text-muted-foreground">{t("jira.exported.loading")}</p>
    }
    if (exported.length === 0) {
      return <p className="text-sm text-muted-foreground">{t("jira.exported.empty")}</p>
    }
    return (
      <div className="space-y-2">
        {exported.map((item) => (
          <div key={item.path} className="rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{item.key}</span>
                  {item.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {item.date} · {item.path}
                </p>
                {item.olderPaths.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("jira.exported.history", { count: item.olderPaths.length })}
                  </p>
                )}
                {exportStates[item.key]?.phase === "error" && (
                  <p className="break-all text-xs text-destructive">
                    {exportStates[item.key]?.error}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 text-xs"
                  onClick={() => void handleOpenDocument(item.path)}
                >
                  <FileText className="h-3 w-3" />
                  {t("jira.exported.open")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 text-xs"
                  onClick={() => handleOpenJira(item.key)}
                >
                  <ExternalLink className="h-3 w-3" />
                  {t("jira.openJira")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 text-xs"
                  disabled={exportStates[item.key]?.phase === "exporting"}
                  onClick={() => void handleExport(item.key)}
                >
                  {t("jira.exported.reExport")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-xs"
                  onClick={() => handleReveal(item.path)}
                >
                  <FolderOpen className="h-3 w-3" />
                  {t("jira.exported.reveal")}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  function handleSubmitSearch() {
    // Flush the debounce immediately so the effect sees the typed text.
    setDebouncedQuery(query.trim())
    setSearchNonce((nonce) => nonce + 1)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="relative min-w-[220px] flex-1">
          <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleSubmitSearch()
            }}
            placeholder={t("jira.searchPlaceholder")}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Button
          variant="default"
          size="sm"
          className="h-8 gap-1 text-xs"
          disabled={!configured || status === "loading"}
          onClick={handleSubmitSearch}
        >
          <SearchIcon className="h-3.5 w-3.5" />
          {t("jira.search.submit")}
        </Button>
        <select
          value={resultLimit}
          onChange={(event) => setResultLimit(Number(event.target.value))}
          title={t("jira.search.limitHint")}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
        >
          {[50, 100, 200, 500].map((size) => (
            <option key={size} value={size}>
              {t("jira.search.limit", { count: size })}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1" title={t("jira.search.dimsHint")}>
          {(
            [
              ["title", "jira.search.dimTitle"],
              ["keyword", "jira.search.dimKeyword"],
              ["issueKey", "jira.search.dimIssueKey"],
            ] as const
          ).map(([dim, labelKey]) => (
            <Button
              key={dim}
              variant={config.searchDims[dim] ? "default" : "outline"}
              size="sm"
              className="h-8 text-xs"
              onClick={() => void handleToggleSearchDim(dim)}
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>
        <Button
          variant={config.matchCase ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs"
          title={t("jira.matchCaseHint")}
          onClick={() => void handleToggleMatchCase()}
        >
          {t("jira.matchCase")}
        </Button>
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          <Button
            variant={mode === "search" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setMode("search")}
          >
            {t("jira.mode.search")}
          </Button>
          <Button
            variant={mode === "exported" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setMode("exported")}
          >
            {t("jira.mode.exported")}
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-xs"
          onClick={() => setExportsVersion((version) => version + 1)}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t("jira.refresh")}
        </Button>
      </div>
      {mode === "search" && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          {JIRA_FILTER_KEYS.map(renderFilterCombobox)}
          {inventoryLoading && (
            <span className="text-xs text-muted-foreground">{t("jira.filter.loading")}</span>
          )}
          {hasActiveJiraFilters(effectiveFilters) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setFilters(EMPTY_JIRA_FILTERS)}
            >
              <X className="h-3 w-3" />
              {t("jira.filter.clear")}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">{notice}</p>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {mode === "search" ? renderSearch() : renderExported()}
      </div>
    </div>
  )
}
