import { useState, useEffect, useCallback } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import { Plus, FileText, Trash2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { copyFile, listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"

export function SourcesView() {
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const [sources, setSources] = useState<FileNode[]>([])
  const [importing, setImporting] = useState(false)

  const loadSources = useCallback(async () => {
    if (!project) return
    try {
      const tree = await listDirectory(`${project.path}/raw/sources`)
      const files = flattenFiles(tree)
      setSources(files)
    } catch {
      setSources([])
    }
  }, [project])

  useEffect(() => {
    loadSources()
  }, [loadSources])

  async function handleImport() {
    if (!project) return

    const selected = await open({
      multiple: true,
      title: "Import Source Files",
      filters: [
        {
          name: "Documents",
          extensions: ["md", "txt", "pdf", "html", "htm", "json", "csv"],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    })

    if (!selected || selected.length === 0) return

    setImporting(true)
    const paths = Array.isArray(selected) ? selected : [selected]

    for (const sourcePath of paths) {
      const fileName = sourcePath.split("/").pop() || sourcePath.split("\\").pop() || "unknown"
      const destPath = `${project.path}/raw/sources/${fileName}`
      try {
        await copyFile(sourcePath, destPath)
      } catch (err) {
        console.error(`Failed to import ${fileName}:`, err)
      }
    }

    setImporting(false)
    await loadSources()
  }

  async function handleOpenSource(node: FileNode) {
    setActiveView("wiki")
    setSelectedFile(node.path)
    try {
      const content = await readFile(node.path)
      setFileContent(content)
    } catch (err) {
      console.error("Failed to read source:", err)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Raw Sources</h2>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={loadSources} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={handleImport} disabled={importing}>
            <Plus className="mr-1 h-4 w-4" />
            {importing ? "Importing..." : "Import"}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
            <p>No sources yet</p>
            <p>Import documents to start building your wiki</p>
            <Button variant="outline" size="sm" onClick={handleImport}>
              <Plus className="mr-1 h-4 w-4" />
              Import Files
            </Button>
          </div>
        ) : (
          <div className="p-2">
            {sources.map((source) => (
              <button
                key={source.path}
                onClick={() => handleOpenSource(source)}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <FileText className="h-4 w-4 shrink-0" />
                <span className="truncate">{source.name}</span>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        {sources.length} source{sources.length !== 1 ? "s" : ""}
      </div>
    </div>
  )
}

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
