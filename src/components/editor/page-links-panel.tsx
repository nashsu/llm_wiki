import { useEffect, useMemo, useState } from "react"
import { CornerUpLeft, FileQuestion, Link2, Loader2, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { getPageLinks, type PageLinkEntry, type PageLinksResponse } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"

const EMPTY_LINKS: PageLinksResponse = { outgoing: [], backlinks: [], missing: [] }

export function PageLinksPanel({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const { t } = useTranslation()
  const project = useWikiStore((state) => state.project)
  const dataVersion = useWikiStore((state) => state.dataVersion)
  const openPathInPreview = useWikiStore((state) => state.openPathInPreview)
  const [links, setLinks] = useState<PageLinksResponse>(EMPTY_LINKS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!project) return
    let cancelled = false
    setLoading(true)
    setError("")
    getPageLinks(project.path, filePath)
      .then((result) => {
        if (!cancelled) setLinks(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [dataVersion, filePath, project])

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
        {loading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : error ? (
          <p className="m-3 border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{error}</p>
        ) : (
          <>
            <LinkSection icon={Link2} title={t("editor.pageLinks.outgoing")} entries={links.outgoing} empty={t("editor.pageLinks.noOutgoing")} onOpen={openEntry} />
            <LinkSection icon={CornerUpLeft} title={t("editor.pageLinks.backlinks")} entries={links.backlinks} empty={t("editor.pageLinks.noBacklinks")} onOpen={openEntry} />
            <LinkSection icon={FileQuestion} title={t("editor.pageLinks.missing")} entries={links.missing} empty={t("editor.pageLinks.noMissing")} onOpen={openEntry} missing />
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
}: {
  icon: typeof Link2
  title: string
  entries: PageLinkEntry[]
  empty: string
  onOpen: (entry: PageLinkEntry) => void
  missing?: boolean
}) {
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
        entries.map((entry, index) => (
          <button
            key={`${entry.path ?? entry.title}:${index}`}
            type="button"
            disabled={missing || !entry.path}
            onClick={() => onOpen(entry)}
            className="block w-full border-t border-border/50 px-3 py-2 text-left first:border-t-0 enabled:hover:bg-accent disabled:cursor-default"
          >
            <span className={`block truncate text-xs font-medium ${missing ? "text-amber-700 dark:text-amber-300" : "text-foreground"}`}>{entry.title}</span>
            {entry.snippet && <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">{entry.snippet}</span>}
          </button>
        ))
      )}
    </section>
  )
}
