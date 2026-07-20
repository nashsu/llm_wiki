import { useEffect, useMemo, useRef, useState } from "react"
import { CornerUpLeft, FileQuestion, Link2, Loader2, Plus, Sparkles, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { createMissingWikiPage, getPageLinks, readFile, type PageLinkEntry, type PageLinksResponse } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { normalizeSelectionReplacement } from "@/lib/selection-edit"

const EMPTY_LINKS: PageLinksResponse = { outgoing: [], backlinks: [], missing: [] }

export function PageLinksPanel({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const { t } = useTranslation()
  const project = useWikiStore((state) => state.project)
  const dataVersion = useWikiStore((state) => state.dataVersion)
  const openPathInPreview = useWikiStore((state) => state.openPathInPreview)
  const llmConfig = useWikiStore((state) => state.llmConfig)
  const [links, setLinks] = useState<PageLinksResponse>(EMPTY_LINKS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [creatingTitle, setCreatingTitle] = useState("")
  const draftAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => draftAbortRef.current?.abort(), [])

  useEffect(() => {
    if (!project) return
    let cancelled = false
    setLoading(true)
    setError("")
    // Coalesce save/watcher bursts that bump dataVersion repeatedly. The Rust
    // command scans Markdown files, so one trailing refresh avoids redundant IO.
    const timer = window.setTimeout(() => {
      getPageLinks(project.path, filePath)
        .then((result) => {
          if (!cancelled) setLinks(result)
        })
        .catch((err) => {
          console.error("Failed to load page links", err)
          if (!cancelled) setError(t("editor.pageLinks.loadFailed"))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [dataVersion, filePath, project, t])

  const total = useMemo(
    () => links.outgoing.length + links.backlinks.length + links.missing.length,
    [links],
  )

  const openEntry = (entry: PageLinkEntry) => {
    if (!project || !entry.path) return
    const normalized = normalizePath(entry.path)
    const absolute = normalized.startsWith(`${normalizePath(project.path)}/`)
      ? normalized
      : `${normalizePath(project.path)}/${normalized.replace(/^\/+/, "")}`
    openPathInPreview(absolute)
  }

  const createMissing = async (entry: PageLinkEntry, withDraft: boolean) => {
    if (!project || creatingTitle) return
    setCreatingTitle(entry.title)
    setError("")
    const controller = new AbortController()
    draftAbortRef.current?.abort()
    draftAbortRef.current = controller
    try {
      let content: string | undefined
      if (withDraft) {
        const current = await readFile(filePath)
        if (controller.signal.aborted) return
        content = normalizeSelectionReplacement(
          await generateMissingPageDraft(
            llmConfig,
            entry.title,
            current.slice(0, 6000),
            t("editor.pageLinks.emptyDraftError"),
            controller.signal,
          ),
        )
      }
      const relativePath = await createMissingWikiPage(project.path, entry.title, content)
      if (controller.signal.aborted) return
      await refreshProjectFileTree(project.path, { bumpDataVersion: true })
      if (controller.signal.aborted) return
      openEntry({ title: entry.title, path: relativePath })
    } catch (err) {
      if (controller.signal.aborted) return
      console.error("Failed to create missing wiki page", err)
      setError(
        err instanceof Error && err.message === t("editor.pageLinks.emptyDraftError")
          ? err.message
          : t("editor.pageLinks.createFailed"),
      )
    } finally {
      if (!controller.signal.aborted) setCreatingTitle("")
      if (draftAbortRef.current === controller) draftAbortRef.current = null
    }
  }

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[min(22rem,90%)] flex-col border-l border-border bg-background shadow-xl" aria-label={t("editor.pageLinks.title")}>
      <header className="flex h-11 items-center gap-2 border-b border-border px-3">
        <Link2 className="h-4 w-4 text-primary" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t("editor.pageLinks.title")}</h2>
        {!loading && <span className="text-[10px] text-muted-foreground">{total}</span>}
        <button type="button" onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground" aria-label={t("editor.pageLinks.title")}>
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto">
        {error && <p className="m-3 border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
        {loading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : (
          <>
            <LinkSection icon={Link2} title={t("editor.pageLinks.outgoing")} entries={links.outgoing} empty={t("editor.pageLinks.noOutgoing")} onOpen={openEntry} />
            <LinkSection icon={CornerUpLeft} title={t("editor.pageLinks.backlinks")} entries={links.backlinks} empty={t("editor.pageLinks.noBacklinks")} onOpen={openEntry} />
            <LinkSection icon={FileQuestion} title={t("editor.pageLinks.missing")} entries={links.missing} empty={t("editor.pageLinks.noMissing")} onOpen={openEntry} onCreate={createMissing} creatingTitle={creatingTitle} missing />
          </>
        )}
      </div>
    </aside>
  )
}

function LinkSection({
  icon: Icon,
  title,
  entries,
  empty,
  onOpen,
  missing = false,
  onCreate,
  creatingTitle = "",
}: {
  icon: typeof Link2
  title: string
  entries: PageLinkEntry[]
  empty: string
  onOpen: (entry: PageLinkEntry) => void
  missing?: boolean
  onCreate?: (entry: PageLinkEntry, withDraft: boolean) => Promise<void>
  creatingTitle?: string
}) {
  const { t } = useTranslation()
  return (
    <section className="border-b border-border">
      <div className="flex items-center gap-2 bg-muted/30 px-3 py-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="flex-1 text-xs font-medium">{title}</h3>
        <span className="text-[10px] text-muted-foreground">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        entries.map((entry, index) => missing ? (
          <div key={`${entry.title}:${index}`} className="border-t border-border/50 px-3 py-2 first:border-t-0">
            <span className="block truncate text-xs font-medium text-amber-700 dark:text-amber-300">{entry.title}</span>
            <div className="mt-1.5 flex gap-1">
              <button type="button" disabled={Boolean(creatingTitle)} onClick={() => void onCreate?.(entry, false)} className="inline-flex items-center gap-1 border border-border px-1.5 py-1 text-[10px] text-foreground hover:bg-accent disabled:opacity-50"><Plus className="h-3 w-3" />{t("editor.pageLinks.create")}</button>
              <button type="button" disabled={Boolean(creatingTitle)} onClick={() => void onCreate?.(entry, true)} className="inline-flex items-center gap-1 bg-primary px-1.5 py-1 text-[10px] text-primary-foreground disabled:opacity-50">
                {creatingTitle === entry.title ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} {t("editor.pageLinks.draft")}
              </button>
            </div>
          </div>
        ) : (
          <button
            key={`${entry.path ?? entry.title}:${index}`}
            type="button"
            disabled={!entry.path}
            onClick={() => onOpen(entry)}
            className="block w-full border-t border-border/50 px-3 py-2 text-left first:border-t-0 enabled:hover:bg-accent disabled:cursor-default"
          >
            <span className="block truncate text-xs font-medium text-foreground">{entry.title}</span>
            {entry.snippet && <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">{entry.snippet}</span>}
          </button>
        ))
      )}
    </section>
  )
}

async function generateMissingPageDraft(
  llmConfig: ReturnType<typeof useWikiStore.getState>["llmConfig"],
  title: string,
  currentPage: string,
  emptyDraftError: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let content = ""
    void streamChat(
      llmConfig,
      [{ role: "user", content: [
        "Create a concise standalone Markdown wiki page for an unresolved link.",
        "Return the complete page only. Include YAML frontmatter with type, title, tags, and related, followed by useful content. Do not wrap it in a code fence.",
        `Target title: ${title}`,
        "Context from the linking page:",
        currentPage,
      ].join("\n\n") }],
      {
        onToken: (token) => { content += token },
        onDone: () => content.trim() ? resolve(content) : reject(new Error(emptyDraftError)),
        onError: reject,
      },
      signal,
      { temperature: 0.3 },
    ).catch(reject)
  })
}
