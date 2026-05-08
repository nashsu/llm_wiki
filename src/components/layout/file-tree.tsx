import { useState } from "react"
import { ChevronRight, ChevronDown, File, Folder } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useTranslation } from "react-i18next"
import { SidebarProjectTitle } from "./sidebar-project-title"

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)

  const isSelected = selectedFile === node.path
  const paddingLeft = 12 + depth * 16

  if (node.is_dir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
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
        </button>
        {expanded && node.children?.map((child) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => setSelectedFile(node.path)}
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
  const project = useWikiStore((s) => s.project)

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("fileTree.noProject")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full min-w-0 overflow-hidden">
      <div className="min-w-0 p-2">
        <SidebarProjectTitle name={project.name} />
        {fileTree.map((node) => (
          <TreeNode key={node.path} node={node} depth={0} />
        ))}
      </div>
    </ScrollArea>
  )
}
