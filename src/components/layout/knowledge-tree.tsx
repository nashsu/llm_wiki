import { useState, useEffect, useCallback } from "react"
import {
  FileText, Users, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, TrendingUp, Target, ChevronRight, ChevronDown, Layout, Globe, Trash2,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { cascadeDeleteWikiPagesWithRefs } from "@/lib/wiki-page-delete"
import { inferWikiTypeFromPath, wikiTypeLabel } from "@/lib/wiki-page-types"
import { filterRawSourceTree } from "@/lib/source-filter"
import { useTranslation } from "react-i18next"

interface WikiPageInfo {
  path: string
  title: string
  type: string
  tags: string[]
  origin?: string
}

const TYPE_CONFIG: Record<string, { icon: typeof FileText; label: string; color: string; order: number }> = {
  overview:    { icon: Layout,      label: "Overview",     color: "text-yellow-500", order: 0 },
  entity:      { icon: Users,       label: "Entities",     color: "text-blue-500",   order: 1 },
  concept:     { icon: Lightbulb,   label: "Concepts",     color: "text-purple-500", order: 2 },
  source:      { icon: BookOpen,    label: "Sources",      color: "text-orange-500", order: 3 },
  synthesis:   { icon: GitMerge,    label: "Synthesis",    color: "text-red-500",    order: 4 },
  finding:     { icon: TrendingUp,  label: "Findings",     color: "text-purple-500", order: 5 },
  thesis:      { icon: Target,      label: "Theses",       color: "text-rose-500",   order: 6 },
  methodology: { icon: BookOpen,    label: "Methodologies",color: "text-teal-500",   order: 7 },
  comparison:  { icon: BarChart3,   label: "Comparisons",  color: "text-emerald-500",order: 8 },
  query:       { icon: HelpCircle,  label: "Queries",      color: "text-green-500",  order: 9 },
}

function typeConfig(type: string): { icon: typeof FileText; label: string; color: string; order: number } {
  return TYPE_CONFIG[type] ?? { icon: FileText, label: wikiTypeLabel(type), color: "text-muted-foreground", order: 99 }
}

export function KnowledgeTree() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const [pages, setPages] = useState<WikiPageInfo[]>([])
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(["overview", "entity", "concept", "source"]))
  // Two-stage delete: first click arms the row, second click executes.
  // Only one row armed at a time (clicking another row replaces).
  const [armedPath, setArmedPath] = useState<string | null>(null)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)

  const loadPages = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const wikiTree = await listDirectory(`${pp}/wiki`)
      const mdFiles = flattenMdFiles(wikiTree)

      const pageInfos: WikiPageInfo[] = []
      for (const file of mdFiles) {
        // Skip index.md and log.md
        if (file.name === "index.md" || file.name === "log.md") continue
        try {
          const content = await readFile(file.path)
          const info = parsePageInfo(file.path, file.name, content)
          pageInfos.push(info)
        } catch {
          pageInfos.push({
            path: file.path,
            title: file.name.replace(".md", "").replace(/-/g, " "),
            type: "other",
            tags: [],
          })
        }
      }

      setPages(pageInfos)
    } catch {
      setPages([])
    }
  }, [project])

  // Reload when wiki data changes. Do not key this off the visible
  // sidebar file tree: lazy directory expansion mutates that tree and
  // should not force a full wiki metadata re-parse.
  useEffect(() => {
    loadPages()
  }, [loadPages, dataVersion])

  const handleDeleteClick = useCallback(
    async (pagePath: string) => {
      if (!project) return
      // First click: arm. Second click on the same row: execute.
      if (armedPath !== pagePath) {
        setArmedPath(pagePath)
        return
      }
      setArmedPath(null)
      setDeletingPath(pagePath)
      try {
        const pp = normalizePath(project.path)
        await cascadeDeleteWikiPagesWithRefs(pp, [pagePath])
        // Refresh: page list, file tree, any data-version subscribers.
        await loadPages()
        try {
          await refreshProjectFileTree(pp, {
            projectId: project.id,
            bumpDataVersion: true,
          })
        } catch {
          // non-critical
        }
        if (selectedFile === pagePath) setSelectedFile(null)
      } catch (err) {
        console.error("[KnowledgeTree] delete failed:", err)
        window.alert(`Failed to delete: ${err}`)
      } finally {
        setDeletingPath(null)
      }
    },
    [project, armedPath, loadPages, selectedFile, setSelectedFile],
  )

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        No project open
      </div>
    )
  }

  // Group pages by type
  const grouped = new Map<string, WikiPageInfo[]>()
  for (const page of pages) {
    const list = grouped.get(page.type) ?? []
    list.push(page)
    grouped.set(page.type, list)
  }

  // Sort groups by configured order
  const sortedGroups = [...grouped.entries()].sort((a, b) => {
    const orderA = typeConfig(a[0]).order
    const orderB = typeConfig(b[0]).order
    if (orderA === orderB) return wikiTypeLabel(a[0]).localeCompare(wikiTypeLabel(b[0]))
    return orderA - orderB
  })

  function toggleType(type: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
          {project.name}
        </div>

        {sortedGroups.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t("sidebar.noWikiPages")}
          </div>
        )}

        {sortedGroups.map(([type, items]) => {
          const config = typeConfig(type)
          const Icon = config.icon
          const isExpanded = expandedTypes.has(type)

          return (
            <div key={type} className="mb-1">
              <button
                onClick={() => toggleType(type)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color}`} />
                <span className="flex-1 text-left font-medium">
                  {t(`sidebar.typeLabels.${type}`, { defaultValue: config.label })}
                </span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </button>

              {isExpanded && (
                <div className="ml-3">
                  {items.map((page) => {
                    const isSelected = selectedFile === page.path
                    const isArmed = armedPath === page.path
                    const isDeleting = deletingPath === page.path
                    return (
                      <div
                        key={page.path}
                        className={`group flex items-center gap-1 rounded-md ${
                          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                        }`}
                      >
                        <button
                          onClick={() => openPathInPreview(page.path)}
                          className={`flex flex-1 items-center gap-1.5 px-2 py-1 text-left text-sm min-w-0 ${
                            isSelected
                              ? "text-accent-foreground"
                              : "text-muted-foreground group-hover:text-accent-foreground"
                          }`}
                          title={page.path}
                        >
                          {page.origin === "web-clip" && <Globe className="h-3 w-3 shrink-0 text-blue-400" />}
                          <span className="truncate">{page.title}</span>
                        </button>
                        <DeleteButton
                          armed={isArmed}
                          deleting={isDeleting}
                          // Visible on hover, when this row is armed,
                          // or while deleting. Other rows fade out so
                          // accidental clicks on a sibling don't pile up.
                          className={`mr-1 transition-opacity ${
                            isArmed || isDeleting
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100"
                          }`}
                          onClick={() => void handleDeleteClick(page.path)}
                          name={page.title}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Raw sources quick access */}
        <RawSourcesSection />
      </div>
    </ScrollArea>
  )
}

function RawSourcesSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const [expanded, setExpanded] = useState(false)
  const [sources, setSources] = useState<FileNode[]>([])

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`, true).then(filterRawSourceTree)
      .then((tree) => setSources(flattenAllFiles(tree)))
      .catch(() => setSources([]))
  }, [project])

  if (sources.length === 0) return null

  return (
    <div className="mt-2 border-t pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="flex-1 text-left font-medium text-muted-foreground">{t("sidebar.rawSources")}</span>
        <span className="text-xs text-muted-foreground">{sources.length}</span>
      </button>
      {expanded && (
        <div className="ml-3">
          {sources.map((file) => {
            const isSelected = selectedFile === file.path
            return (
              <button
                key={file.path}
                onClick={() => openPathInPreview(file.path)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <span className="truncate">{file.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function parsePageInfo(path: string, fileName: string, content: string): WikiPageInfo {
  let type = "other"
  let title = fileName.replace(".md", "").replace(/-/g, " ")
  const tags: string[] = []
  let origin: string | undefined

  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    const fm = fmMatch[1]
    const typeMatch = fm.match(/^type:\s*(.+)$/m)
    if (typeMatch) type = typeMatch[1].trim().toLowerCase()

    const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (titleMatch) title = titleMatch[1].trim()

    const tagsMatch = fm.match(/^tags:\s*\[(.+?)\]/m)
    if (tagsMatch) {
      tags.push(...tagsMatch[1].split(",").map((t) => t.trim().replace(/["']/g, "")))
    }

    const originMatch = fm.match(/^origin:\s*(.+)$/m)
    if (originMatch) origin = originMatch[1].trim()
  }

  // Fallback: try first heading if no frontmatter title
  if (title === fileName.replace(".md", "").replace(/-/g, " ")) {
    const headingMatch = content.match(/^#\s+(.+)$/m)
    if (headingMatch) title = headingMatch[1].trim()
  }

  // Fallback: infer type from path
  if (type === "other") {
    type = inferWikiTypeFromPath(path, fileName) ?? "other"
  }

  return { path, title, type, tags, origin }
}

/**
 * Two-stage delete affordance for a single page row. Default state =
 * subtle ghost trash icon. Armed state = solid red Confirm pill so a
 * second click can't be accidental. Same visual contract as the
 * sources-view DeleteButton — kept inline here rather than shared
 * because the parent owns the armed/deleting/visibility state and
 * extracting would mean lifting four props to a shared module for one
 * extra caller.
 */
function DeleteButton({
  armed,
  deleting,
  onClick,
  name,
  className = "",
}: {
  armed: boolean
  deleting: boolean
  onClick: () => void
  name: string
  className?: string
}) {
  if (deleting) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={`h-6 w-6 shrink-0 cursor-default ${className}`}
        disabled
        title={`Deleting ${name}…`}
      >
        <Trash2 className="h-3 w-3 animate-pulse text-destructive" />
      </Button>
    )
  }
  if (armed) {
    return (
      <Button
        variant="destructive"
        size="sm"
        className={`h-6 shrink-0 px-1.5 text-[10px] font-semibold animate-pulse ${className}`}
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        title={`Click again to delete ${name} and clean up references`}
      >
        <Trash2 className="mr-0.5 h-3 w-3" />
        Confirm
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive ${className}`}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={`Delete ${name} (and clean up references)`}
    >
      <Trash2 className="h-3 w-3" />
    </Button>
  )
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
