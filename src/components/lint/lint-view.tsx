import { useState, useCallback, useMemo, useEffect } from "react"
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
  Link2,
  ChevronRight,
  ChevronDown,
  FilePlus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore, type LintItem } from "@/stores/lint-store"
import { runStructuralLint, runSemanticLint, runLinkSuggestions, addRelatedLink, resolveBrokenLinksByEmbedding, resolveOrphansByEmbedding, resolveNoOutlinksByEmbedding, buildBrokenLinkStub, loadWikiPageTypes } from "@/lib/lint"
import { rewriteCrossReferences } from "@/lib/dedup"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useTranslation } from "react-i18next"

export function groupLintResultsForDisplay(results: readonly LintItem[]): {
  suggestions: LintItem[]
  warnings: LintItem[]
  infos: LintItem[]
} {
  const suggestions: LintItem[] = []
  const warnings: LintItem[] = []
  const infos: LintItem[] = []

  results.forEach((result) => {
    if (result.type === "suggested-link") {
      suggestions.push(result)
    } else if (result.severity === "warning") {
      warnings.push(result)
    } else {
      infos.push(result)
    }
  })

  // Surface the actionable warnings first: broken links with a repoint target
  // (one-click fix) sort above the rest. Stable — relative order is otherwise
  // preserved.
  const repointable = (i: LintItem) => i.type === "broken-link" && !!i.suggestedTarget
  warnings.sort((a, b) => Number(repointable(b)) - Number(repointable(a)))

  return { suggestions, warnings, infos }
}

export function shouldShowLintResults(hasRun: boolean, itemCount: number): boolean {
  return hasRun || itemCount > 0
}

export function LintView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  // Dynamic type config based on i18n
  const typeConfig = useMemo(() => ({
    orphan: { icon: Unlink, label: t("lint.typeLabels.orphan") },
    "broken-link": { icon: Link2Off, label: t("lint.typeLabels.broken-link") },
    "no-outlinks": { icon: ArrowUpRight, label: t("lint.typeLabels.no-outlinks") },
    semantic: { icon: BrainCircuit, label: t("lint.typeLabels.semantic") },
    "suggested-link": { icon: Link2, label: "Suggested link" },
  }), [t])

  const items = useLintStore((s) => s.items)
  const addLintItems = useLintStore((s) => s.addItems)
  const clearLintItems = useLintStore((s) => s.clearItems)

  const [running, setRunning] = useState(false)
  const [hasRun, setHasRun] = useState(false)
  const [runSemantic, setRunSemantic] = useState(false)
  const [semanticMode, setSemanticMode] = useState<"batch" | "cluster">("batch")
  const [suggestLinks, setSuggestLinks] = useState(false)
  const [suggestMode, setSuggestMode] = useState<"fast" | "confirm">("fast")
  const [fixingId, setFixingId] = useState<string | null>(null)
  // Stub-page type for broken-link "Create page" fixes. "auto" infers from the
  // source page's folder; otherwise the chosen type is written verbatim.
  const [stubType, setStubType] = useState<string>("auto")
  const [wikiTypes, setWikiTypes] = useState<string[]>([])

  const embeddingConfig = useWikiStore((s) => s.embeddingConfig)
  // turbovecdb-service URL is shared with the dedup embedding scan (kept in
  // localStorage while that path is experimental — see maintenance-section).
  const serviceUrl = useMemo(
    () => localStorage.getItem("dedup.turbovecServiceUrl") || "http://127.0.0.1:8077",
    [],
  )
  const clusterAvailable = !!embeddingConfig?.enabled && !!embeddingConfig?.endpoint
  const llmReady = hasUsableLlm(llmConfig)

  const handleRunLint = useCallback(async () => {
    if (!project || running) return
    const pp = normalizePath(project.path)
    setRunning(true)
    clearLintItems()
    try {
      const structural = await runStructuralLint(pp)
      let all = structural

      // Embedding fallback: fill "did you mean?" targets for broken links the
      // lexical pass couldn't match. Gated on the same embedding opt-in as
      // link suggestions; no-ops when every broken link already has a match.
      if (suggestLinks && clusterAvailable) {
        all = await resolveBrokenLinksByEmbedding(pp, all, embeddingConfig)
        // For each orphan, find the closest existing page and offer to add a
        // backlink from it — a real inbound link, unlike the index.md dump.
        all = await resolveOrphansByEmbedding(pp, all, embeddingConfig)
        // For each no-outlinks page, find the closest existing page and offer
        // to add a forward link with one click.
        all = await resolveNoOutlinksByEmbedding(pp, all, embeddingConfig)
      }

      if (runSemantic && hasUsableLlm(llmConfig)) {
        const semantic = await runSemanticLint(pp, llmConfig, {
          mode: semanticMode,
          embeddingConfig,
          serviceUrl,
        })
        all = [...all, ...semantic]
      }

      if (suggestLinks && clusterAvailable) {
        const links = await runLinkSuggestions(pp, embeddingConfig, serviceUrl, {
          mode: suggestMode,
          llmConfig: hasUsableLlm(llmConfig) ? llmConfig : undefined,
        })
        all = [...all, ...links]
      }

      addLintItems(all)
      setHasRun(true)
    } catch (err) {
      console.error("Lint failed:", err)
    } finally {
      setRunning(false)
    }
  }, [project, llmConfig, running, runSemantic, semanticMode, suggestLinks, suggestMode, clusterAvailable, embeddingConfig, serviceUrl, addLintItems, clearLintItems])

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

  async function handleFix(item: LintItem) {
    if (!project) return
    const pp = normalizePath(project.path)
    setFixingId(item.id)

    try {
      switch (item.type) {
        case "orphan": {
          const pageName = item.page.replace(".md", "").replace(/^.*\//, "")
          // Preferred: add a backlink from the closest related page (embedding
          // pass found it). This is a real body wikilink the orphan detector
          // counts, so the orphan genuinely resolves on the next scan.
          if (item.suggestedSource) {
            const sourcePath = `${pp}/wiki/${item.suggestedSource}`
            const content = await readFile(sourcePath)
            const updated = addRelatedLink(content, pageName)
            if (updated !== content) await writeFile(sourcePath, updated)
            useLintStore.getState().removeItem(item.id)
            break
          }
          // Fallback (no related page found): list it in index.md so it's at
          // least discoverable.
          const indexPath = `${pp}/wiki/index.md`
          let indexContent = ""
          try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }

          const entry = `- [[${pageName}]]`
          if (!indexContent.includes(entry)) {
            indexContent = indexContent.trimEnd() + "\n" + entry + "\n"
            await writeFile(indexPath, indexContent)
          }
          // Remove from store
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "broken-link": {
          // If a "did you mean?" target was found, repoint the broken wikilink
          // [[brokenTarget]] → [[suggestedTarget]] directly in the source page.
          if (item.brokenTarget && item.suggestedTarget) {
            const sourcePath = `${pp}/wiki/${item.page}`
            const content = await readFile(sourcePath)
            const updated = rewriteCrossReferences(
              content,
              new Map([[item.brokenTarget, item.suggestedTarget]]),
            )
            if (updated !== content) await writeFile(sourcePath, updated)
            useLintStore.getState().removeItem(item.id)
            break
          }
          // No "did you mean?" target → the page was never created. Materialize
          // a stub so the link resolves; the user fleshes it out later.
          if (item.brokenTarget) {
            const today = new Date().toISOString().slice(0, 10)
            const stub = buildBrokenLinkStub(
              item.brokenTarget,
              item.page,
              today,
              stubType === "auto" ? undefined : stubType,
            )
            if (stub) {
              const stubPath = `${pp}/wiki/${stub.path}`
              let exists = false
              try { await readFile(stubPath); exists = true } catch { exists = false }
              if (!exists) await writeFile(stubPath, stub.content)
            }
            useLintStore.getState().removeItem(item.id)
            break
          }
          // Fallback (no broken target captured): send to Review for manual fix.
          const pagePath = `${pp}/wiki/${item.page}`
          useReviewStore.getState().addItem({
            type: "confirm",
            title: t("lint.fixBrokenLink", { page: item.page }),
            description: item.detail,
            affectedPages: [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("lint.deletePage"), action: `delete:${pagePath}` },
              { label: t("lint.skip"), action: "Skip" },
            ],
          })
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "no-outlinks": {
          // If an embedding-suggested link target was found, add it directly.
          const target = item.affectedPages?.[0]
          if (target) {
            const sourcePath = `${pp}/wiki/${item.page}`
            const linkText = target.replace(/\.md$/, "").replace(/^.*\//, "")
            const content = await readFile(sourcePath)
            const updated = addRelatedLink(content, linkText)
            if (updated !== content) await writeFile(sourcePath, updated)
            useLintStore.getState().removeItem(item.id)
            break
          }
          // No suggestion — send to Review for manual resolution.
          useReviewStore.getState().addItem({
            type: "suggestion",
            title: t("lint.addCrossRefs", { page: item.page }),
            description: t("lint.addCrossRefsDescription"),
            affectedPages: [item.page],
            options: [
              { label: t("lint.openEdit"), action: `open:${item.page}` },
              { label: t("lint.skip"), action: "Skip" },
            ],
          })
          useLintStore.getState().removeItem(item.id)
          break
        }

        case "suggested-link": {
          // Add the suggested cross-link directly: append [[target]] to the
          // source page's ## Related section.
          const target = item.affectedPages?.[0]
          if (target) {
            const sourcePath = `${pp}/wiki/${item.page}`
            const linkText = target.replace(/\.md$/, "").replace(/^.*\//, "")
            const content = await readFile(sourcePath)
            const updated = addRelatedLink(content, linkText)
            if (updated !== content) await writeFile(sourcePath, updated)
          }
          useLintStore.getState().removeItem(item.id)
          break
        }

        default: {
          // Semantic issues → send to Review for manual resolution
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
          useLintStore.getState().removeItem(item.id)
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
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } catch (err) {
      console.error("Delete failed:", err)
    }
  }

  // Apply every suggested link at once: group by source page so each page is
  // read/written a single time, even when it has many suggested targets.
  const [addingAll, setAddingAll] = useState(false)
  async function handleAddAllLinks() {
    if (!project || addingAll) return
    const pp = normalizePath(project.path)
    const suggestions = items.filter((i) => i.type === "suggested-link")
    if (suggestions.length === 0) return
    setAddingAll(true)

    const byPage = new Map<string, LintItem[]>()
    for (const it of suggestions) {
      const list = byPage.get(it.page)
      if (list) list.push(it)
      else byPage.set(it.page, [it])
    }

    try {
      for (const [page, list] of byPage) {
        const sourcePath = `${pp}/wiki/${page}`
        try {
          let content = await readFile(sourcePath)
          for (const it of list) {
            const target = it.affectedPages?.[0]
            if (!target) continue
            content = addRelatedLink(content, target.replace(/\.md$/, "").replace(/^.*\//, ""))
          }
          await writeFile(sourcePath, content)
          list.forEach((it) => useLintStore.getState().removeItem(it.id))
        } catch (err) {
          console.error(`Add-all links failed for ${page}:`, err)
        }
      }
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } finally {
      setAddingAll(false)
    }
  }

  // Repoint every broken link that has a "did you mean?" target at once. Group
  // by source page so each page is rewritten once, even with many broken links.
  const [repointingAll, setRepointingAll] = useState(false)
  async function handleRepointAll() {
    if (!project || repointingAll) return
    const pp = normalizePath(project.path)
    const repointable = items.filter(
      (i) => i.type === "broken-link" && i.brokenTarget && i.suggestedTarget,
    )
    if (repointable.length === 0) return
    setRepointingAll(true)

    const byPage = new Map<string, LintItem[]>()
    for (const it of repointable) {
      const list = byPage.get(it.page)
      if (list) list.push(it)
      else byPage.set(it.page, [it])
    }

    try {
      for (const [page, list] of byPage) {
        const sourcePath = `${pp}/wiki/${page}`
        try {
          const content = await readFile(sourcePath)
          const redirects = new Map(
            list.map((it) => [it.brokenTarget!, it.suggestedTarget!]),
          )
          const updated = rewriteCrossReferences(content, redirects)
          if (updated !== content) await writeFile(sourcePath, updated)
          list.forEach((it) => useLintStore.getState().removeItem(it.id))
        } catch (err) {
          console.error(`Repoint-all failed for ${page}:`, err)
        }
      }
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } finally {
      setRepointingAll(false)
    }
  }

  // Create a stub page for every broken link with no repoint target. Deduped by
  // target text (case-insensitive): one [[phandalin]] stub resolves every link
  // to it, so we create once and clear all matching items.
  const [creatingStubs, setCreatingStubs] = useState(false)
  async function handleCreateAllStubs() {
    if (!project || creatingStubs) return
    const pp = normalizePath(project.path)
    const stubbable = items.filter(
      (i) => i.type === "broken-link" && i.brokenTarget && !i.suggestedTarget,
    )
    if (stubbable.length === 0) return
    setCreatingStubs(true)

    // Group by lowercased target so a shared broken link is created once.
    const byTarget = new Map<string, LintItem[]>()
    for (const it of stubbable) {
      const key = it.brokenTarget!.toLowerCase()
      const list = byTarget.get(key)
      if (list) list.push(it)
      else byTarget.set(key, [it])
    }

    const today = new Date().toISOString().slice(0, 10)
    try {
      for (const list of byTarget.values()) {
        const first = list[0]
        const stub = buildBrokenLinkStub(
          first.brokenTarget!,
          first.page,
          today,
          stubType === "auto" ? undefined : stubType,
        )
        if (stub) {
          const stubPath = `${pp}/wiki/${stub.path}`
          try {
            let exists = false
            try { await readFile(stubPath); exists = true } catch { exists = false }
            if (!exists) await writeFile(stubPath, stub.content)
            list.forEach((it) => useLintStore.getState().removeItem(it.id))
          } catch (err) {
            console.error(`Create-stub failed for ${stub.path}:`, err)
          }
        }
      }
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } finally {
      setCreatingStubs(false)
    }
  }

  // Add a forward link to every no-outlinks page that has an embedding-suggested
  // target. Each item maps to a unique source page, so no grouping needed.
  const [linkingAllNoOutlinks, setLinkingAllNoOutlinks] = useState(false)
  async function handleAddAllNoOutlinks() {
    if (!project || linkingAllNoOutlinks) return
    const pp = normalizePath(project.path)
    const linkable = items.filter((i) => i.type === "no-outlinks" && i.affectedPages?.[0])
    if (linkable.length === 0) return
    setLinkingAllNoOutlinks(true)

    try {
      for (const it of linkable) {
        const target = it.affectedPages![0]
        const sourcePath = `${pp}/wiki/${it.page}`
        const linkText = target.replace(/\.md$/, "").replace(/^.*\//, "")
        try {
          const content = await readFile(sourcePath)
          const updated = addRelatedLink(content, linkText)
          if (updated !== content) await writeFile(sourcePath, updated)
          useLintStore.getState().removeItem(it.id)
        } catch (err) {
          console.error(`Add-all no-outlinks failed for ${it.page}:`, err)
        }
      }
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } finally {
      setLinkingAllNoOutlinks(false)
    }
  }

  // Connect every orphan that has an embedding-suggested source page at once.
  // Group by source page so a page that should backlink several orphans is
  // read/written once.
  const [connectingAll, setConnectingAll] = useState(false)
  async function handleConnectAllOrphans() {
    if (!project || connectingAll) return
    const pp = normalizePath(project.path)
    const connectable = items.filter((i) => i.type === "orphan" && i.suggestedSource)
    if (connectable.length === 0) return
    setConnectingAll(true)

    const bySource = new Map<string, LintItem[]>()
    for (const it of connectable) {
      const list = bySource.get(it.suggestedSource!)
      if (list) list.push(it)
      else bySource.set(it.suggestedSource!, [it])
    }

    try {
      for (const [source, list] of bySource) {
        const sourcePath = `${pp}/wiki/${source}`
        try {
          let content = await readFile(sourcePath)
          for (const it of list) {
            content = addRelatedLink(content, it.page.replace(/\.md$/, "").replace(/^.*\//, ""))
          }
          await writeFile(sourcePath, content)
          list.forEach((it) => useLintStore.getState().removeItem(it.id))
        } catch (err) {
          console.error(`Connect-all orphans failed for ${source}:`, err)
        }
      }
      const tree = await listDirectory(pp)
      setFileTree(tree)
      bumpDataVersion()
    } finally {
      setConnectingAll(false)
    }
  }

  const { suggestions, warnings, infos } = useMemo(
    () => groupLintResultsForDisplay(items),
    [items],
  )
  const connectableCount = useMemo(
    () => infos.filter((i) => i.type === "orphan" && i.suggestedSource).length,
    [infos],
  )
  const linkableNoOutlinksCount = useMemo(
    () => infos.filter((i) => i.type === "no-outlinks" && !!i.affectedPages?.[0]).length,
    [infos],
  )
  const repointableCount = useMemo(
    () => warnings.filter((i) => i.type === "broken-link" && i.suggestedTarget).length,
    [warnings],
  )
  const stubbableCount = useMemo(
    () =>
      new Set(
        warnings
          .filter((i) => i.type === "broken-link" && i.brokenTarget && !i.suggestedTarget)
          .map((i) => i.brokenTarget!.toLowerCase()),
      ).size,
    [warnings],
  )
  // Discover the wiki's actual page types to populate the stub-type selector,
  // once there are stubs to create. Always offer entity/concept as fallbacks.
  useEffect(() => {
    if (!project || stubbableCount === 0) return
    let cancelled = false
    loadWikiPageTypes(normalizePath(project.path)).then((ts) => {
      if (!cancelled) setWikiTypes(ts)
    })
    return () => { cancelled = true }
  }, [project, stubbableCount])
  const stubTypeOptions = useMemo(
    () => [...new Set(["entity", "concept", ...wikiTypes])].sort(),
    [wikiTypes],
  )
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const showResults = shouldShowLintResults(hasRun, items.length)

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
          {runSemantic && (
            <select
              value={semanticMode}
              onChange={(e) => setSemanticMode(e.target.value as "batch" | "cluster")}
              title={
                clusterAvailable
                  ? "How to split a large wiki across LLM calls"
                  : "Cluster mode needs an embedding endpoint (Settings → Embeddings)"
              }
              className="h-6 rounded border bg-background px-1.5 text-xs text-muted-foreground"
            >
              <option value="batch">Batched</option>
              <option value="cluster" disabled={!clusterAvailable}>
                Clustered (embeddings)
              </option>
            </select>
          )}
          <label
            className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer"
            title={clusterAvailable ? "Suggest links between related but disconnected pages" : "Needs an embedding endpoint (Settings → Embeddings)"}
          >
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={suggestLinks}
              disabled={!clusterAvailable}
              onChange={(e) => setSuggestLinks(e.target.checked)}
            />
            Suggest links
          </label>
          {suggestLinks && clusterAvailable && (
            <select
              value={suggestMode}
              onChange={(e) => setSuggestMode(e.target.value as "fast" | "confirm")}
              title="Fast = embeddings only. Confirmed = an LLM keeps only useful links."
              className="h-6 rounded border bg-background px-1.5 text-xs text-muted-foreground"
            >
              <option value="fast">Fast (embeddings)</option>
              <option value="confirm" disabled={!llmReady}>
                Confirmed (LLM)
              </option>
            </select>
          )}
          <Button
            size="sm"
            onClick={handleRunLint}
            disabled={running || !project}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
            {running ? t("lint.running") : t("lint.runLint")}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
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
            {suggestions.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 px-1 py-1 text-xs font-semibold text-primary">
                  <button
                    type="button"
                    onClick={() => setSuggestionsOpen((v) => !v)}
                    className="flex items-center gap-1.5 hover:opacity-80"
                  >
                    {suggestionsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <Link2 className="h-3.5 w-3.5" />
                    Suggested links ({suggestions.length})
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto h-6 text-xs gap-1"
                    disabled={addingAll}
                    onClick={handleAddAllLinks}
                  >
                    <Link2 className="h-3 w-3" />
                    {addingAll ? "Adding…" : "Add all links"}
                  </Button>
                </div>
                {suggestionsOpen &&
                  suggestions.map((item) => (
                    <LintCard
                      key={item.id}
                      item={item}
                      fixing={fixingId === item.id}
                      onOpenPage={handleOpenPage}
                      onFix={handleFix}
                      typeConfig={typeConfig}
                      t={t}
                    />
                  ))}
              </div>
            )}
            {warnings.length > 0 && (
              <div className="flex items-center gap-2 px-1 py-1 text-xs font-semibold text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("lint.sectionCount", { label: t("lint.warnings"), count: warnings.length })}
                {(repointableCount > 0 || stubbableCount > 0) && (
                  <div className="ml-auto flex items-center gap-1.5">
                    {stubbableCount > 0 && (
                      <select
                        value={stubType}
                        onChange={(e) => setStubType(e.target.value)}
                        title="Type for stub pages created from broken links"
                        className="h-6 rounded border bg-background px-1.5 text-xs font-normal text-muted-foreground"
                      >
                        <option value="auto">Type: auto</option>
                        {stubTypeOptions.map((ty) => (
                          <option key={ty} value={ty}>
                            Type: {ty}
                          </option>
                        ))}
                      </select>
                    )}
                    {repointableCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs gap-1"
                        disabled={repointingAll}
                        onClick={handleRepointAll}
                      >
                        <Link2 className="h-3 w-3" />
                        {repointingAll ? "Repointing…" : `Repoint all (${repointableCount})`}
                      </Button>
                    )}
                    {stubbableCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs gap-1"
                        disabled={creatingStubs}
                        onClick={handleCreateAllStubs}
                      >
                        <FilePlus className="h-3 w-3" />
                        {creatingStubs ? "Creating…" : `Create stubs (${stubbableCount})`}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            {warnings.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
                onOpenPage={handleOpenPage}
                onFix={handleFix}
                onDelete={item.type === "orphan" ? handleDeleteOrphan : undefined}
                typeConfig={typeConfig}
                t={t}
              />
            ))}
            {infos.length > 0 && (
              <div className="flex items-center gap-2 px-1 py-1 text-xs font-semibold text-blue-500">
                <Info className="h-3.5 w-3.5" />
                {t("lint.sectionCount", { label: t("lint.info"), count: infos.length })}
                {(connectableCount > 0 || linkableNoOutlinksCount > 0) && (
                  <div className="ml-auto flex items-center gap-1.5">
                    {connectableCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs gap-1"
                        disabled={connectingAll}
                        onClick={handleConnectAllOrphans}
                      >
                        <Link2 className="h-3 w-3" />
                        {connectingAll ? "Connecting…" : `Connect all (${connectableCount})`}
                      </Button>
                    )}
                    {linkableNoOutlinksCount > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs gap-1"
                        disabled={linkingAllNoOutlinks}
                        onClick={handleAddAllNoOutlinks}
                      >
                        <Link2 className="h-3 w-3" />
                        {linkingAllNoOutlinks ? "Adding…" : `Add links (${linkableNoOutlinksCount})`}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            {infos.map((item) => (
              <LintCard
                key={item.id}
                item={item}
                fixing={fixingId === item.id}
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

function LintCard({
  item,
  fixing,
  onOpenPage,
  onFix,
  onDelete,
  typeConfig,
  t,
}: {
  item: LintItem
  fixing: boolean
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
          {item.type === "suggested-link"
            || (item.type === "broken-link" && item.suggestedTarget)
            || (item.type === "orphan" && item.suggestedSource)
            || (item.type === "no-outlinks" && !!item.affectedPages?.[0])
            ? <Link2 className="h-3 w-3" />
            : item.type === "broken-link" && item.brokenTarget
              ? <FilePlus className="h-3 w-3" />
              : <Wrench className="h-3 w-3" />}
          {item.type === "suggested-link"
            ? (fixing ? "Adding…" : "Add link")
            : item.type === "broken-link" && item.suggestedTarget
              ? (fixing ? "Repointing…" : `Repoint → [[${item.suggestedTarget}]]`)
              : item.type === "broken-link" && item.brokenTarget
                ? (fixing ? "Creating…" : "Create page")
                : item.type === "orphan" && item.suggestedSource
                  ? (fixing ? "Linking…" : "Add backlink")
                  : item.type === "no-outlinks" && item.affectedPages?.[0]
                    ? (fixing ? "Adding…" : `Add link → [[${item.affectedPages[0].replace(/\.md$/, "").split("/").pop()}]]`)
                    : (fixing ? t("lint.fixing") : t("lint.fix"))}
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
