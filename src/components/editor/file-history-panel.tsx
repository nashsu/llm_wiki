import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Clock3, RotateCcw, X } from "lucide-react"
import { listFileHistory, restoreFileHistory, type FileHistoryEntry } from "@/commands/fs"
import { summarizeAgentFileChange } from "@/lib/agent-file-activity"
import { useWikiStore } from "@/stores/wiki-store"

export function FileHistoryButton({
  filePath,
  currentContent,
  triggerClassName = "absolute right-3 top-3 z-20 rounded-md border bg-background/90 p-1.5 text-muted-foreground shadow-sm hover:text-foreground",
  overlayClassName = "absolute inset-0 z-40 flex bg-background",
}: {
  filePath: string
  currentContent: string
  /** Class for the trigger button. Defaults to the absolute corner placement
   *  used by FilePreview; the WikiEditor toolbar passes an inline style so the
   *  trigger sits alongside the Page Links / Edit buttons. */
  triggerClassName?: string
  /** Class for the full-panel overlay. Defaults to pane-scoped (absolute);
   *  the editor passes fixed so the overlay isn't clipped by the toolbar's
   *  positioned ancestor. */
  overlayClassName?: string
}) {
  const { t } = useTranslation()
  const project = useWikiStore((state) => state.project)
  const openFileInPreview = useWikiStore((state) => state.openFileInPreview)
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<FileHistoryEntry[]>([])
  const [selected, setSelected] = useState<FileHistoryEntry | null>(null)
  const [loading, setLoading] = useState(false)
  if (!project) return null

  const show = async () => {
    setOpen(true)
    setLoading(true)
    try {
      setEntries(await listFileHistory(project.path, filePath))
    } finally {
      setLoading(false)
    }
  }
  const diff = selected ? summarizeAgentFileChange({
    id: selected.id, path: filePath, tool: selected.tool,
    beforeContent: selected.content, afterContent: currentContent,
  }).diff : ""

  return <>
    <button type="button" onClick={() => void show()} className={triggerClassName} title={t("preview.history")}><Clock3 className="h-4 w-4" /></button>
    {open && <div className={overlayClassName}>
      <aside className="w-72 shrink-0 border-r p-3">
        <div className="mb-3 flex items-center justify-between"><strong className="text-sm">{t("preview.history")}</strong><button type="button" onClick={() => setOpen(false)}><X className="h-4 w-4" /></button></div>
        <div className="space-y-1 overflow-auto">
          {loading && <p className="text-xs text-muted-foreground">{t("preview.historyLoading")}</p>}
          {!loading && entries.length === 0 && <p className="text-xs text-muted-foreground">{t("preview.historyEmpty")}</p>}
          {entries.map((entry) => <button key={entry.id} type="button" onClick={() => setSelected(entry)} className={`w-full rounded border px-2 py-2 text-left text-xs ${selected?.id === entry.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted"}`}>
            <div className="font-medium">{entry.author} · {entry.tool}</div>
            <div className="mt-1 text-[10px] text-muted-foreground">{new Date(entry.timestamp).toLocaleString()}</div>
          </button>)}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-4">
        {selected ? <><div className="mb-3 flex justify-end"><button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted" onClick={async () => {
          const content = await restoreFileHistory(project.path, filePath, selected.id)
          openFileInPreview(filePath, content)
          setOpen(false)
        }}><RotateCcw className="h-3.5 w-3.5" />{t("preview.historyRestore")}</button></div><pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs">{diff}</pre></> : <div className="grid h-full place-items-center text-sm text-muted-foreground">{t("preview.historySelect")}</div>}
      </main>
    </div>}
  </>
}
