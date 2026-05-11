import { useMemo } from "react"
import {
  FileText as FileTextIcon,
  FileSpreadsheet,
  FileJson,
  FileCode,
  FileImage,
  Film,
  Music,
  File as FileIcon,
  ArrowUpRight,
  AlertTriangle,
  Layers,
  Calendar,
  Tag as TagIcon,
} from "lucide-react"
import type { FrontmatterValue } from "@/lib/frontmatter"
import { getWikiTypeStyle } from "@/lib/wiki-type-style"
import {
  resolveRelatedSlug,
  resolveSourceName,
  unwrapWikilink,
} from "@/lib/wiki-page-resolver"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"

interface FrontmatterPanelProps {
  data: Record<string, FrontmatterValue>
}

const TOP_LEVEL_KEYS = new Set([
  "title",
  "type",
  "tags",
  "created",
  "description",
  "sources",
  "related",
  "origin",
])

export function FrontmatterPanel({ data }: FrontmatterPanelProps) {
  const project = useWikiStore((s) => s.project)
  const fileTree = useWikiStore((s) => s.fileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)

  const title = stringValue(data.title)
  const type = stringValue(data.type)
  const created = stringValue(data.created)
  const description = stringValue(data.description)
  const origin = stringValue(data.origin)
  const tags = arrayValue(data.tags)
  const sources = arrayValue(data.sources)
  const related = arrayValue(data.related)

  const extras = useMemo(
    () =>
      Object.entries(data).filter(([k, v]) => {
        if (TOP_LEVEL_KEYS.has(k)) return false
        if (Array.isArray(v) && v.length === 0) return false
        if (v === "") return false
        return true
      }),
    [data],
  )

  const projectPath = project ? normalizePath(project.path) : null
  const wikiRoot = projectPath ? `${projectPath}/wiki` : null
  const sourcesRoot = projectPath ? `${projectPath}/raw/sources` : null

  const typeStyle = getWikiTypeStyle(type)
  const TypeIcon = typeStyle.icon

  const hasIdentity = title || type || tags.length > 0 || created
  const hasRelations = sources.length > 0 || related.length > 0
  const hasContent =
    hasIdentity || description || origin || hasRelations || extras.length > 0
  if (!hasContent) return null

  function handleNavigate(path: string | null) {
    if (!path) return
    setSelectedFile(path)
  }

  return (
    <div className="not-prose mb-5 overflow-hidden rounded-xl border border-border/60 bg-gradient-to-br from-muted/40 to-muted/10 shadow-sm">
      {/* Identity strip ─────────────────────────────────────────── */}
      <div className="flex items-start gap-3 px-4 pt-4">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${typeStyle.chipClass}`}
          title={typeStyle.label}
        >
          <TypeIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {title && (
            <div className="truncate text-base font-semibold leading-tight text-foreground">
              {title}
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            {type && (
              <span
                className={`rounded px-1.5 py-0.5 font-medium uppercase tracking-wide ${typeStyle.chipClass}`}
              >
                {typeStyle.label}
              </span>
            )}
            {created && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                {created}
              </span>
            )}
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
              >
                <TagIcon className="h-3 w-3" />
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      {description && (
        <div className="px-4 pt-2 text-sm italic leading-relaxed text-muted-foreground">
          {description}
        </div>
      )}

      {origin && (
        <div className="mx-4 mt-3 rounded border-l-2 border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-foreground/80">
          <span className="font-medium text-muted-foreground">来源： </span>
          {origin}
        </div>
      )}

      {/* Sources card row ───────────────────────────────────────── */}
      {sources.length > 0 && (
        <div className="px-4 pt-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            资料来源
            <span className="text-muted-foreground/60">({sources.length})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {sources.map((source) => {
              const { slug, label } = unwrapWikilink(source)
              const path = sourcesRoot
                ? resolveSourceName(fileTree, slug, sourcesRoot)
                : null
              return (
                <SourceCard
                  key={source}
                  name={label}
                  resolved={!!path}
                  onClick={() => handleNavigate(path)}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Related chips ──────────────────────────────────────────── */}
      {related.length > 0 && (
        <div className="px-4 pt-4">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <ArrowUpRight className="h-3.5 w-3.5" />
            相关页面
            <span className="text-muted-foreground/60">({related.length})</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {related.map((entry) => {
              const { slug, label } = unwrapWikilink(entry)
              const path = wikiRoot
                ? resolveRelatedSlug(fileTree, slug, wikiRoot)
                : null
              return (
                <RelatedChip
                  key={entry}
                  slug={label}
                  resolved={!!path}
                  onClick={() => handleNavigate(path)}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Extras (any other key/values we didn't surface above) ──── */}
      {extras.length > 0 && (
        <div className="mx-4 mt-4 rounded border border-border/40 bg-background/50 px-3 py-2 text-xs">
          <div className="mb-1 font-medium text-muted-foreground/80">更多</div>
          <div className="space-y-0.5">
            {extras.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="shrink-0 font-mono text-muted-foreground">
                  {k}:
                </span>
                <span className="text-foreground/80">
                  {Array.isArray(v) ? v.join(", ") : v}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom padding — done via wrapper not last child to keep
          per-section spacing consistent regardless of which sections
          are present. */}
      <div className="h-4" />
    </div>
  )
}

function SourceCard({
  name,
  resolved,
  onClick,
}: {
  name: string
  resolved: boolean
  onClick: () => void
}) {
  const Icon = iconForSource(name)
  return (
    <button
      type="button"
      onClick={resolved ? onClick : undefined}
      title={resolved ? `打开 ${name}` : `raw/sources/ 中未找到来源：${name}`}
      className={`group flex min-w-0 max-w-[200px] items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
        resolved
          ? "border-border/60 bg-background hover:border-primary/40 hover:bg-primary/5 cursor-pointer"
          : "border-dashed border-border/50 bg-muted/20 text-muted-foreground/70 cursor-default"
      }`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${resolved ? "text-foreground/70" : "text-muted-foreground/60"}`} />
      <span className="truncate">{name}</span>
      {!resolved && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500/70" />}
    </button>
  )
}

function RelatedChip({
  slug,
  resolved,
  onClick,
}: {
  slug: string
  resolved: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={resolved ? onClick : undefined}
      title={resolved ? `打开 ${slug}` : `未找到相关页面：${slug}`}
      className={`group inline-flex max-w-[260px] items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        resolved
          ? "border-border/60 bg-background hover:border-primary/50 hover:bg-primary/10 cursor-pointer"
          : "border-dashed border-border/50 bg-muted/20 text-muted-foreground/70 cursor-default"
      }`}
    >
      <span className="truncate">{slug}</span>
      {resolved ? (
        <ArrowUpRight className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
      ) : (
        <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500/70" />
      )}
    </button>
  )
}

function iconForSource(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  switch (ext) {
    case "pdf":
      return FileTextIcon
    case "xlsx":
    case "xls":
    case "csv":
    case "tsv":
    case "ods":
      return FileSpreadsheet
    case "json":
    case "jsonl":
    case "yaml":
    case "yml":
    case "ndjson":
      return FileJson
    case "py":
    case "js":
    case "ts":
    case "tsx":
    case "jsx":
    case "rs":
    case "go":
    case "java":
    case "c":
    case "cpp":
    case "rb":
    case "php":
      return FileCode
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "svg":
      return FileImage
    case "mp4":
    case "webm":
    case "mov":
    case "avi":
    case "mkv":
      return Film
    case "mp3":
    case "wav":
    case "ogg":
    case "flac":
    case "m4a":
      return Music
    case "md":
    case "mdx":
    case "txt":
    case "rtf":
    case "html":
    case "htm":
    case "xml":
    case "docx":
    case "doc":
    case "pptx":
    case "ppt":
      return FileTextIcon
    default:
      return FileIcon
  }
}

function stringValue(v: FrontmatterValue | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null
}

function arrayValue(v: FrontmatterValue | undefined): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
}
