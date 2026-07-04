import type { FileNode } from "@/types/wiki"

export interface ReplaceNodeChildrenResult {
  nodes: FileNode[]
  matched: boolean
}

export function replaceNodeChildren(
  nodes: FileNode[],
  path: string,
  children: FileNode[],
): ReplaceNodeChildrenResult {
  let matched = false
  const next = nodes.map((node) => {
    if (node.path === path) {
      matched = true
      return { ...node, children }
    }
    if (node.children) {
      const result = replaceNodeChildren(node.children, path, children)
      if (result.matched) {
        matched = true
        return { ...node, children: result.nodes }
      }
    }
    return node
  })
  return { nodes: matched ? next : nodes, matched }
}
