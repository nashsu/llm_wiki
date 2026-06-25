import { useEffect, useRef, useState } from "react"
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from "lucide-react"
import { message } from "@tauri-apps/plugin-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import { listDirectory, openProjectFolder } from "@/commands/fs"
import { replaceNodeChildren } from "./file-tree-utils"

function TreeNode({
  node,
  depth,
  onLoadChildren,
}: {
  node: FileNode
  depth: number
  onLoadChildren: (node: FileNode) => Promise<void>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(depth < 1)
  const [loadingChildren, setLoadingChildren] = useState(false)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const openPathInPreview = useWikiStore((s) => s.openPathInPreview)

  const isSelected = selectedFile === node.path
  const paddingLeft = 12 + depth * 16

  if (node.is_dir) {
    const handleToggle = async () => {
      const nextExpanded = !expanded
      setExpanded(nextExpanded)
      if (!nextExpanded || node.children) return
      setLoadingChildren(true)
      try {
        await onLoadChildren(node)
      } finally {
        setLoadingChildren(false)
      }
    }

    return (
      <div>
        <button
          onClick={() => void handleToggle()}
          className="flex w-full items-center gap-1 py-1 text-sm text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
          style={{ paddingLeft }}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <span className="truncate">{node.name}</span>
          {loadingChildren && (
            <span className="ml-auto pr-2 text-[10px] text-muted-foreground">
              {t("common.loading", { defaultValue: "Loading..." })}
            </span>
          )}
        </button>
        {expanded && node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onLoadChildren={onLoadChildren}
          />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => openPathInPreview(node.path)}
      className={`flex w-full items-center gap-1 py-1 text-sm ${
        isSelected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
      }`}
      style={{ paddingLeft: paddingLeft + 14 }}
    >
      <File className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  )
}

export function FileTree() {
  const { t } = useTranslation()
  const fileTree = useWikiStore((s) => s.fileTree)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const project = useWikiStore((s) => s.project)
  const loadedPaths = useRef(new Set<string>())
  const loadingPaths = useRef(new Set<string>())

  useEffect(() => {
    loadedPaths.current.clear()
    loadingPaths.current.clear()
  }, [project?.id])

  const handleOpenProjectFolder = async () => {
    if (!project) return

    try {
      await openProjectFolder(project.path)
    } catch (err) {
      console.error("[FileTree] open project folder failed:", err)
      await message(
        t("fileTree.openProjectFolderFailed", {
          defaultValue: "Failed to open the project folder.",
        }),
        {
          title: t("fileTree.openProjectFolder", {
            defaultValue: "Open project folder",
          }),
          kind: "error",
        },
      )
    }
  }

  const handleLoadChildren = async (node: FileNode) => {
    if (!project) return
    if (loadedPaths.current.has(node.path) || loadingPaths.current.has(node.path)) return
    loadingPaths.current.add(node.path)
    const projectId = project.id
    try {
      const children = await listDirectory(node.path, { maxDepth: 1 })
      if (useWikiStore.getState().project?.id !== projectId) return
      const currentTree = useWikiStore.getState().fileTree
      const result = replaceNodeChildren(currentTree, node.path, children)
      if (!result.matched) return
      loadedPaths.current.add(node.path)
      setFileTree(result.nodes, {
        syncPathIndex: false,
      })
    } catch (err) {
      console.error("[FileTree] load children failed:", err)
    } finally {
      loadingPaths.current.delete(node.path)
    }
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("fileTree.noProject")}
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="p-2">
          <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
            {project.name}
          </div>
          {fileTree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              onLoadChildren={handleLoadChildren}
            />
          ))}
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t p-2">
        <button
          type="button"
          onClick={() => void handleOpenProjectFolder()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
          title={project.path}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {t("fileTree.openProjectFolder", { defaultValue: "Open project folder" })}
          </span>
        </button>
      </div>
    </div>
  )
}
