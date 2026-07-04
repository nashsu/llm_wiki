import { useCallback, useMemo, useState } from "react"
import { queueResearch } from "@/lib/deep-research"
import {
  AlertTriangle,
  Copy,
  FileQuestion,
  CheckCircle2,
  Lightbulb,
  MessageSquare,
  X,
  Check,
  Trash2,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { writeFile, readFile, deleteFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { hasConfiguredDeepResearchSources } from "@/lib/web-search"
import { makeQueryFileName } from "@/lib/wiki-filename"
import { createReviewPageDrafts } from "@/lib/review-create-page"
import { cleanAssistantContentForWikiSave, titleFromCleanAssistantContent } from "@/lib/chat-save-to-wiki"
import { useTranslation } from "react-i18next"

const typeConfig: Record<ReviewItem["type"], { icon: typeof AlertTriangle; label: string; color: string }> = {
  contradiction: { icon: AlertTriangle, label: "Contradiction", color: "text-amber-500" },
  duplicate: { icon: Copy, label: "Possible Duplicate", color: "text-blue-500" },
  "missing-page": { icon: FileQuestion, label: "Missing Page", color: "text-purple-500" },
  confirm: { icon: MessageSquare, label: "Needs Confirmation", color: "text-foreground" },
  suggestion: { icon: Lightbulb, label: "Suggestion", color: "text-emerald-500" },
}

export function ReviewView() {
  const { t } = useTranslation()
  const items = useReviewStore((s) => s.items)
  const resolveItem = useReviewStore((s) => s.resolveItem)
  const dismissItem = useReviewStore((s) => s.dismissItem)
  const clearResolved = useReviewStore((s) => s.clearResolved)
  const setItems = useReviewStore((s) => s.setItems)
  const project = useWikiStore((s) => s.project)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<string>>(() => new Set())

  // Reload review items from disk. The review pane has no equivalent of
  // lint's re-run, so external writers — the resolve API, another window,
  // a manual edit of review.json — would otherwise stay invisible until
  // the project is reopened.
  const handleRefresh = useCallback(async () => {
    if (!project || refreshing) return
    setRefreshing(true)
    try {
      const { loadReviewItems } = await import("@/lib/persist")
      const loaded = await loadReviewItems(project.path)
      setItems(loaded)
      setSelectedReviewIds(new Set())
    } catch (err) {
      console.error("Failed to refresh review items:", err)
    } finally {
      setRefreshing(false)
    }
  }, [project, refreshing, setItems])

  const handleResolve = useCallback(async (id: string, action: string) => {
    const pp = project ? normalizePath(project.path) : ""
    const item = items.find((i) => i.id === id)
    // Deep Research — must be checked FIRST before any fuzzy matching
    if (action === "__deep_research__" && project) {
      const searchConfig = useWikiStore.getState().searchApiConfig
      if (!hasConfiguredDeepResearchSources(searchConfig)) {
        window.alert(t("research.notConfigured"))
        return
      }
      if (item) {
        const llmConfig = useWikiStore.getState().llmConfig
        // Use pre-generated search queries if available, otherwise fall back to title
        const topic = item.title.replace(/^(Save to Wiki|Create|Research)[:\s]*/i, "").trim() || item.description.split("\n")[0]
        queueResearch(pp, topic, llmConfig, searchConfig, item.searchQueries)
        resolveItem(id, "Queued for research")
      } else {
        resolveItem(id, action)
      }
      return
    }

    if (action.startsWith("save:") && project) {
      // Decode and save the content to wiki
      try {
        const encoded = action.slice(5)
        const content = decodeURIComponent(atob(encoded))

        const cleanContent = cleanAssistantContentForWikiSave(content)
        const title = titleFromCleanAssistantContent(cleanContent)
        const { date, fileName } = makeQueryFileName(title)
        const filePath = `${pp}/wiki/queries/${fileName}`

        const frontmatter = `---\ntype: query\ntitle: "${title.replace(/"/g, '\\"')}"\ncreated: ${date}\ntags: []\n---\n\n`
        const pageContent = frontmatter + cleanContent
        await writeFile(filePath, pageContent)

        // Update index
        const indexPath = `${pp}/wiki/index.md`
        let indexContent = ""
        try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }
        const linkTarget = fileName.replace(/\.md$/, "")
        const entry = `- [[queries/${linkTarget}|${title}]]`
        if (indexContent.includes("## Queries")) {
          indexContent = indexContent.replace(/(## Queries\n)/, (match) => `${match}${entry}\n`)
        } else {
          indexContent = indexContent.trimEnd() + "\n\n## Queries\n" + entry + "\n"
        }
        await writeFile(indexPath, indexContent)

        // Append log
        const logPath = `${pp}/wiki/log.md`
        let logContent = ""
        try { logContent = await readFile(logPath) } catch { logContent = "# Wiki Log\n" }
        await writeFile(logPath, logContent.trimEnd() + `\n- ${date}: Saved query page \`${fileName}\`\n`)

        await refreshProjectFileTree(pp, {
          projectId: project.id,
          bumpDataVersion: true,
        })
        useWikiStore.getState().openFileInPreview(filePath, pageContent)

        resolveItem(id, "Saved to Wiki")
      } catch (err) {
        console.error("Failed to save to wiki from review:", err)
        resolveItem(id, "Save failed")
      }
    } else if ((action.startsWith("open:") || actionLooksLikeOpen(action)) && project) {
      // Open a page in the right-side preview without resolving the
      // review item. Viewing is not the same as accepting / fixing it.
      const page = action.startsWith("open:")
        ? action.slice(5)
        : item?.affectedPages?.[0] ?? item?.sourcePath ?? ""
      if (!page) return
      const normalizedPage = normalizePath(page)
      const candidates = normalizedPage.startsWith(pp)
        ? [normalizedPage]
        : normalizedPage.startsWith("wiki/") || normalizedPage.startsWith("raw/")
          ? [`${pp}/${normalizedPage}`, `${pp}/${normalizedPage}.md`]
          : [`${pp}/wiki/${normalizedPage}`, `${pp}/wiki/${normalizedPage}.md`]
      for (const path of candidates) {
        try {
          const content = await readFile(path)
          useWikiStore.getState().openFileInPreview(path, content)
          return
        } catch {
          // try next
        }
      }
    } else if (action.startsWith("delete:") && project) {
      // Delete a file
      const filePath = action.slice(7)
      try {
        await deleteFile(filePath)
        await refreshProjectFileTree(pp, {
          projectId: project.id,
          bumpDataVersion: true,
        })
        resolveItem(id, "Deleted")
      } catch (err) {
        console.error("Failed to delete:", err)
        resolveItem(id, "Delete failed")
      }
    } else if (actionLooksLikeResearch(action) && project) {
      // Actions with "research" trigger deep research, not just page creation
      const searchConfig = useWikiStore.getState().searchApiConfig
      if (!hasConfiguredDeepResearchSources(searchConfig)) {
        // No research source — fall through to create a page instead
        if (item) {
          handleResolve(id, "__create_page__:" + action)
        }
        return
      }
      if (item) {
        const llmConfig = useWikiStore.getState().llmConfig
        const topic = action.replace(/^research\s*/i, "").trim() || item.description.split("\n")[0]
        queueResearch(pp, topic, llmConfig, searchConfig)
        resolveItem(id, "Queued for deep research")
      } else {
        resolveItem(id, action)
      }
    } else if (
      (action.startsWith("__create_page__:") || actionLooksLikeCreate(action))
      && project
    ) {
      // Create a wiki page from the review item's content. Accepts both
      // the `__create_page__:` sentinel (forced via the "no search API"
      // fallback branch above) and actions that heuristically look like
      // a create instruction.
      const realAction = action.startsWith("__create_page__:")
        ? action.slice("__create_page__:".length)
        : action
      if (item) {
        try {
          const drafts = createReviewPageDrafts(item, realAction)
          const created: Array<{
            title: string
            dir: string
            fileName: string
            filePath: string
            pageContent: string
            pageType: string
            date: string
          }> = []

          for (const draft of drafts) {
            const { date, fileName } = makeQueryFileName(draft.title)
            const filePath = `${pp}/wiki/${draft.dir}/${fileName}`
            const frontmatter = `---\ntype: ${draft.pageType}\ntitle: "${draft.title.replace(/"/g, '\\"')}"\ncreated: ${date}\ntags: []\nrelated: []\n---\n\n`
            const body = `# ${draft.title}\n\n${item.description}\n`
            const pageContent = frontmatter + body
            await writeFile(filePath, pageContent)
            created.push({ title: draft.title, dir: draft.dir, fileName, filePath, pageContent, pageType: draft.pageType, date })
          }

          // Update index
          const indexPath = `${pp}/wiki/index.md`
          let indexContent = ""
          try { indexContent = await readFile(indexPath) } catch { indexContent = "# Wiki Index\n" }
          for (const createdPage of created) {
            const sectionHeader = `## ${createdPage.dir.charAt(0).toUpperCase() + createdPage.dir.slice(1)}`
            const linkTarget = createdPage.fileName.replace(/\.md$/, "")
            const entry = `- [[${createdPage.dir}/${linkTarget}|${createdPage.title}]]`
            if (indexContent.includes(sectionHeader)) {
              indexContent = indexContent.replace(new RegExp(`(${sectionHeader}\n)`), (match) => `${match}${entry}\n`)
            } else {
              indexContent = indexContent.trimEnd() + `\n\n${sectionHeader}\n${entry}\n`
            }
          }
          await writeFile(indexPath, indexContent)

          // Log
          const logPath = `${pp}/wiki/log.md`
          let logContent = ""
          try { logContent = await readFile(logPath) } catch { logContent = "# Wiki Log\n" }
          const createdNames = created.map((p) => `\`${p.fileName}\``).join(", ")
          const logDate = created[0]?.date ?? makeQueryFileName("review").date
          await writeFile(logPath, logContent.trimEnd() + `\n- ${logDate}: Created ${created.length} page${created.length === 1 ? "" : "s"} from review: ${createdNames}\n`)

          await refreshProjectFileTree(pp, {
            projectId: project.id,
            bumpDataVersion: true,
          })
          const first = created[0]
          if (first) useWikiStore.getState().openFileInPreview(first.filePath, first.pageContent)

          resolveItem(id, created.length === 1
            ? `Created: wiki/${created[0].dir}/${created[0].fileName}`
            : `Created ${created.length} pages`)
        } catch (err) {
          console.error("Failed to create page from review:", err)
          resolveItem(id, "Create failed")
        }
      } else {
        resolveItem(id, action)
      }
    } else {
      resolveItem(id, action)
    }
  }, [project, items, resolveItem])

  const pending = items.filter((i) => !i.resolved)
  const resolved = items.filter((i) => i.resolved)
  const selectedPendingIds = useMemo(
    () => pending.map((item) => item.id).filter((id) => selectedReviewIds.has(id)),
    [pending, selectedReviewIds],
  )
  const allPendingSelected = pending.length > 0 && selectedPendingIds.length === pending.length

  const setReviewSelected = useCallback((id: string, selected: boolean) => {
    setSelectedReviewIds((prev) => {
      const next = new Set(prev)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const toggleAllPending = useCallback(() => {
    setSelectedReviewIds((prev) => {
      const next = new Set(prev)
      if (allPendingSelected) {
        for (const item of pending) next.delete(item.id)
      } else {
        for (const item of pending) next.add(item.id)
      }
      return next
    })
  }, [allPendingSelected, pending])

  const handleBatchResolve = useCallback(() => {
    for (const id of selectedPendingIds) {
      resolveItem(id, "Bulk resolved")
    }
    setSelectedReviewIds(new Set())
  }, [resolveItem, selectedPendingIds])

  const handleBatchDismiss = useCallback(() => {
    for (const id of selectedPendingIds) {
      dismissItem(id)
    }
    setSelectedReviewIds(new Set())
  }, [dismissItem, selectedPendingIds])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">
          {t("review.title")}
          {pending.length > 0 && (
            <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
              {pending.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-xs"
            title={t("review.refreshHint", "Reload review items from disk")}
          >
            <RotateCcw className={`mr-1 h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            {t("review.refresh", "Refresh")}
          </Button>
          {resolved.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearResolved} className="text-xs">
              <Trash2 className="mr-1 h-3 w-3" />
              {t("review.clearResolved")}
            </Button>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-2 text-xs">
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={allPendingSelected}
              onChange={toggleAllPending}
            />
            {t("review.selectPending")}
          </label>
          <span className="text-muted-foreground">
            {t("review.selectedCount", { count: selectedPendingIds.length })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={selectedPendingIds.length === 0}
            onClick={handleBatchResolve}
          >
            {t("review.markSelectedResolved")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            disabled={selectedPendingIds.length === 0}
            onClick={handleBatchDismiss}
          >
            {t("review.dismissSelected")}
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-muted-foreground/30" />
            <p>{t("review.allClear")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            {pending.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                onResolve={handleResolve}
                onDismiss={dismissItem}
                selected={selectedReviewIds.has(item.id)}
                onSelectedChange={setReviewSelected}
              />
            ))}
            {resolved.length > 0 && pending.length > 0 && (
              <div className="my-2 text-center text-xs text-muted-foreground">
                {t("review.resolvedDivider")}
              </div>
            )}
            {resolved.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                onResolve={handleResolve}
                onDismiss={dismissItem}
                selected={selectedReviewIds.has(item.id)}
                onSelectedChange={setReviewSelected}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ReviewCard({
  item,
  onResolve,
  onDismiss,
  selected,
  onSelectedChange,
}: {
  item: ReviewItem
  onResolve: (id: string, action: string) => void
  onDismiss: (id: string) => void
  selected: boolean
  onSelectedChange: (id: string, selected: boolean) => void
}) {
  const { t } = useTranslation()
  const config = typeConfig[item.type]
  const Icon = config.icon

  return (
    <div
      className={`rounded-lg border p-3 text-sm transition-opacity ${
        item.resolved ? "opacity-50" : ""
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {!item.resolved && (
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={selected}
              onChange={(event) => onSelectedChange(item.id, event.target.checked)}
              aria-label={t("review.selectItem", { title: item.title })}
            />
          )}
          <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
          <span className="font-medium">{item.title}</span>
        </div>
        <button
          onClick={() => onDismiss(item.id)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">{item.description}</p>

      {item.affectedPages && item.affectedPages.length > 0 && (
        <div className="mb-3 text-xs text-muted-foreground">
          Pages: {item.affectedPages.join(", ")}
        </div>
      )}

      {!item.resolved ? (
        <div className="flex flex-wrap gap-1.5">
          {(item.type === "suggestion" || item.type === "missing-page") && (
            <Button
              variant="default"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => onResolve(item.id, "__deep_research__")}
            >
              🔍 {t("research.title")}
            </Button>
          )}
          {item.options.map((opt) => (
            <Button
              key={opt.action}
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onResolve(item.id, opt.action)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-xs text-emerald-600">
          <Check className="h-3 w-3" />
          {item.resolvedAction}
        </div>
      )}
    </div>
  )
}

/** Detect if an action implies deep research (web search + LLM synthesis) */
function actionLooksLikeResearch(action: string): boolean {
  // Skip internal action identifiers
  if (action.startsWith("__")) return false
  const lower = action.toLowerCase()
  return (
    lower.includes("research") ||
    lower.includes("investigate") ||
    lower.includes("explore") ||
    lower.includes("look into") ||
    lower.includes("研究") ||
    lower.includes("调研") ||
    lower.includes("探索")
  )
}

function actionLooksLikeOpen(action: string): boolean {
  const lower = action.trim().toLowerCase()
  return (
    lower === "open" ||
    lower === "view" ||
    lower === "open page" ||
    lower === "view page" ||
    lower === "打开" ||
    lower === "查看" ||
    lower === "打开页面" ||
    lower === "查看页面"
  )
}

/** Detect if an action is a dismissal (no-op) or should create a page */
function actionIsDismissal(action: string): boolean {
  const lower = action.toLowerCase()
  return (
    lower === "skip" ||
    lower === "dismiss" ||
    lower === "ignore" ||
    lower === "跳过" ||
    lower === "忽略" ||
    lower === "approve" ||
    lower === "keep existing" ||
    lower === "no"
  )
}

function actionLooksLikeCreate(action: string): boolean {
  // Anything that isn't a dismissal should create a page
  return !actionIsDismissal(action)
}
