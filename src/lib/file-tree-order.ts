import type { FileNode } from "@/types/wiki"
import { naturalCompare } from "@/lib/natural-sort"

export function compareFileNodes(a: FileNode, b: FileNode): number {
  if (a.is_dir && !b.is_dir) return -1
  if (!a.is_dir && b.is_dir) return 1
  return naturalCompare(a.name, b.name)
}

export function sortFileNodes(nodes: readonly FileNode[]): FileNode[] {
  return [...nodes].sort(compareFileNodes)
}

export function flattenFilesNaturally(nodes: readonly FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of sortFileNodes(nodes)) {
    if (node.is_dir && node.children) {
      files.push(...flattenFilesNaturally(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
