/**
 * Shared wiki file utilities.
 *
 * Extracted from wiki-synthesis, agent-autofill, graph-relevance, wiki-graph
 * to eliminate duplication (PR#35 review finding #3).
 */

import type { FileNode } from "@/types/wiki"

/** Recursively flatten a directory tree into a list of `.md` FileNodes. */
export function flattenMdFiles(nodes: readonly FileNode[]): FileNode[] {
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
