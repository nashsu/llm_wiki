/**
 * Filesystem catalog of wiki pages (all markdown under wiki/ except structural files).
 * Shared seam for index reconcile, lint, graph builders, etc.
 */

import { listDirectory, readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import {
  indexSectionForPageType,
  type IndexSection,
} from "@/lib/wiki-structural"
import type { FileNode } from "@/types/wiki"

const STRUCTURAL_FILENAMES = new Set(["index.md", "log.md", "overview.md"])

export interface WikiCatalogPage {
  /** Wikilink target relative to `wiki/`, e.g. `entities/foo`. */
  linkTarget: string
  section: IndexSection | string
  title: string
}

/** Flatten a wiki tree to markdown file nodes (directories recurse). */
export function flattenWikiMdFiles(nodes: readonly FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenWikiMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

export function indexSectionForWikiRel(
  relPath: string,
  pageType?: string,
): IndexSection | string {
  if (pageType) {
    return indexSectionForPageType(pageType)
  }
  const folder = relPath.split("/")[0]?.toLowerCase() ?? ""
  switch (folder) {
    case "entities":
      return "Entities"
    case "concepts":
      return "Concepts"
    case "sources":
      return "Sources"
    case "queries":
      return "Queries"
    case "comparisons":
      return "Comparisons"
    case "synthesis":
      return "Synthesis"
    default:
      if (!folder) return "Queries"
      return folder.charAt(0).toUpperCase() + folder.slice(1)
  }
}

/**
 * List every non-structural page under `wiki/` with section + display title.
 */
export async function listWikiCatalogPages(
  projectPath: string,
): Promise<WikiCatalogPage[]> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const pages: WikiCatalogPage[] = []
  for (const file of flattenWikiMdFiles(tree)) {
    if (STRUCTURAL_FILENAMES.has(file.name)) continue
    const rel = getRelativePath(file.path, wikiRoot).replace(/\.md$/i, "")
    if (!rel) continue

    let title = rel.split("/").pop() ?? rel
    let pageType: string | undefined
    try {
      const raw = await readFile(file.path)
      const { frontmatter } = parseFrontmatter(raw)
      if (frontmatter?.title && typeof frontmatter.title === "string") {
        title = frontmatter.title.trim() || title
      }
      if (frontmatter?.type && typeof frontmatter.type === "string") {
        pageType = frontmatter.type
      }
    } catch {
      // unreadable — still list with path-derived title
    }

    pages.push({
      linkTarget: rel,
      section: indexSectionForWikiRel(rel, pageType),
      title,
    })
  }

  return pages
}
