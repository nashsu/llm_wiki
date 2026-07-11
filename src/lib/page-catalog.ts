import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import type { PageCatalogEntry } from "./auto-link-types"
import { parseFrontmatter, type FrontmatterValue } from "./frontmatter"
import { normalizePath } from "./path-utils"

export function flattenWikiMarkdownFiles(
  tree: FileNode[],
  projectPath: string,
): string[] {
  const normalizedProjectPath = normalizePath(projectPath).replace(/\/+$/, "")
  const wikiPrefix = `${normalizedProjectPath}/wiki/`
  const indexPath = `${wikiPrefix}index.md`
  const files: string[] = []

  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.children) visit(node.children)
      if (node.is_dir) continue

      const path = normalizePath(node.path)
      if (
        path.startsWith(wikiPrefix) &&
        path.endsWith(".md") &&
        path !== indexPath
      ) {
        files.push(path)
      }
    }
  }

  visit(tree)
  return files
}

export async function buildPageCatalog(
  tree: FileNode[],
  projectPath: string,
): Promise<PageCatalogEntry[]> {
  const paths = flattenWikiMarkdownFiles(tree, projectPath)
  const entries = await Promise.all(
    paths.map(async (path) => {
      const slug = pagePathToSlug(path)
      const { frontmatter } = parseFrontmatter(await readFile(path))
      const title = frontmatter?.title
      const type = frontmatter?.type

      return {
        slug,
        title:
          typeof title === "string" && title.trim().length > 0 ? title : slug,
        type: typeof type === "string" ? type : "",
        tags: coerceTags(frontmatter?.tags),
        path,
      }
    }),
  )

  return entries.sort((a, b) => a.slug.localeCompare(b.slug))
}

export async function buildProjectPageCatalog(
  projectPath: string,
): Promise<PageCatalogEntry[]> {
  const normalizedProjectPath = normalizePath(projectPath).replace(/\/+$/, "")
  const wikiTree = await listDirectory(`${normalizedProjectPath}/wiki`)
  return buildPageCatalog(wikiTree, normalizedProjectPath)
}

export function pagePathToSlug(path: string): string {
  const filename = normalizePath(path).split("/").pop() ?? ""
  return filename.replace(/\.md$/, "")
}

function coerceTags(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((tag) => tag.trim()).filter(Boolean)
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
  }
  return []
}
