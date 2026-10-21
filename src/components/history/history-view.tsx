import { useEffect, useState, useCallback } from "react"
import {
  History as HistoryIcon,
  Inbox,
  Trash2,
  Ban,
  FileText,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  ClipboardCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useTranslation } from "react-i18next"

interface LogEntry {
  id: number
  date: string
  action: string
  subject: string
  body: string
}

/** Parse wiki/log.md entries of the form
 *  `## [YYYY-MM-DD] <action> | <subject>` followed by a body until the next
 *  `## [` heading (or EOF). */
function parseLogMd(content: string): LogEntry[] {
  const entries: LogEntry[] = []
  const lines = content.split(/\r?\n/)
  let current: LogEntry | null = null
  for (const line of lines) {
    const m = /^## \[(\d{4}-\d{2}-\d{2})\] ?(.*)$/.exec(line)
    if (m) {
      if (current) entries.push(current)
      const title = m[2]
      const pipe = title.indexOf(" | ")
      current = {
        id: entries.length,
        date: m[1],
        action: (pipe >= 0 ? title.slice(0, pipe) : title).trim(),
        subject: (pipe >= 0 ? title.slice(pipe + 3) : "").trim(),
        body: "",
      }
    } else if (current) {
      current.body += `${line}\n`
    }
  }
  if (current) entries.push(current)
  return entries
}

type ActionKind = "ingest" | "delete" | "exclude" | "review" | "save" | "other"

function actionKind(action: string): ActionKind {
  const a = action.toLowerCase()
  if (a.includes("excluded")) return "exclude"
  if (a.includes("delete")) return "delete"
  if (a.includes("review")) return "review"
  if (a.includes("save") || a.includes("chat")) return "save"
  if (a.includes("ingest")) return "ingest"
  return "other"
}

const KIND_ICON: Record<ActionKind, typeof FileText> = {
  ingest: FileText,
  delete: Trash2,
  exclude: Ban,
  review: ClipboardCheck,
  save: MessageSquare,
  other: HistoryIcon,
}

export function HistoryView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const openFileInPreview = useWikiStore((s) => s.openFileInPreview)
  const [content, setContent] = useState("")
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  const load = useCallback(async () => {
    if (!project) {
      setContent("")
      return
    }
    try {
      const text = await readFile(`${normalizePath(project.path)}/wiki/log.md`)
      setContent(text)
    } catch {
      setContent("")
    }
  }, [project])

  useEffect(() => {
    setExpanded(new Set())
    void load()
  }, [load])

  const entries = parseLogMd(content)
  const groups = new Map<string, LogEntry[]>()
  for (const entry of entries) {
    const arr = groups.get(entry.date) ?? []
    arr.push(entry)
    groups.set(entry.date, arr)
  }
  const grouped = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <HistoryIcon className="h-4 w-4" />
          {t("history.title")}
        </h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!project} onClick={() => void load()}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {t("history.refresh")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!project || !content}
            onClick={() =>
              openFileInPreview(`${normalizePath(project!.path)}/wiki/log.md`, content)
            }
          >
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            {t("history.openLog")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {entries.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 text-muted-foreground/30" />
            <p>{t("history.empty")}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {grouped.map(([date, items]) => (
              <div key={date}>
                <div className="mb-2 text-xs font-semibold text-muted-foreground">{date}</div>
                <div className="space-y-1.5">
                  {items.map((entry) => {
                    const kind = actionKind(entry.action)
                    const Icon = KIND_ICON[kind]
                    const isOpen = expanded.has(entry.id)
                    return (
                      <div key={entry.id} className="rounded-lg border bg-muted/10">
                        <button
                          type="button"
                          onClick={() => toggle(entry.id)}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent/50"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium">
                            {t(`history.actions.${kind}`, { defaultValue: entry.action })}
                          </span>
                          {entry.subject && (
                            <span className="truncate text-xs text-muted-foreground">
                              · {entry.subject}
                            </span>
                          )}
                        </button>
                        {isOpen && (
                          <pre className="whitespace-pre-wrap border-t px-4 py-2 text-xs text-muted-foreground">
                            {entry.body.trimEnd()}
                          </pre>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
