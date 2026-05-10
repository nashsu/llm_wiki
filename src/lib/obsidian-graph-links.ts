import { readFile, writeFile, listDirectory } from "@/commands/fs"
import {
  buildGraphReferenceResolver,
  fileNameToGraphId,
  parseGraphPage,
  resolveSourceReference,
  resolveWikiReference,
} from "@/lib/graph-relations"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

export interface ObsidianGraphLinkPage {
  relativePath: string
  content: string
}

export interface ObsidianGraphLinkUpdate {
  relativePath: string
  content: string
  links: string[]
}

interface ResolvablePage {
  id: string
  type: string
  path: string
  relativePath: string
  content: string
  related: string[]
  sources: string[]
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

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^wiki\//, "").normalize("NFC")
}

function buildResolvablePages(
  pages: readonly ObsidianGraphLinkPage[],
  wikiRoot: string,
): ResolvablePage[] {
  return pages.map((page) => {
    const relativePath = normalizeRelativePath(page.relativePath)
    const absolutePath = `${wikiRoot.replace(/\/$/, "")}/${relativePath}`
    const name = fileName(relativePath)
    const parsed = parseGraphPage(page.content, name, absolutePath)
    return {
      id: fileNameToGraphId(name),
      type: parsed.type,
      path: absolutePath,
      relativePath,
      content: page.content,
      related: parsed.related,
      sources: parsed.sources,
    }
  })
}

function uniqueSortedLinks(links: string[]): string[] {
  return Array.from(new Set(links)).sort((a, b) => a.localeCompare(b))
}

function escapeYamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function graphLinkLines(links: readonly string[]): string[] {
  if (links.length === 0) return []
  return [
    "graph_links:",
    ...links.map((link) => `  - "[[${escapeYamlDoubleQuoted(link)}]]"`),
  ]
}

function isStructuralPage(page: ResolvablePage): boolean {
  const normalizedPath = normalizeRelativePath(page.relativePath).toLowerCase()
  const type = page.type.toLowerCase()
  return [
    "index.md",
    "log.md",
    "overview.md",
    "purpose.md",
    "schema.md",
  ].includes(normalizedPath) || [
    "index",
    "log",
    "overview",
    "purpose",
    "schema",
  ].includes(type)
}

function isTopLevelField(line: string): boolean {
  return /^[A-Za-z_][\w-]*\s*:/.test(line)
}

function fieldStartIndex(lines: readonly string[], field: string): number {
  const re = new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`)
  return lines.findIndex((line) => re.test(line))
}

function fieldEndIndex(lines: readonly string[], start: number): number {
  if (start < 0) return -1
  let end = start + 1
  while (end < lines.length && !isTopLevelField(lines[end])) {
    end++
  }
  return end
}

function removeTopLevelField(lines: readonly string[], field: string): string[] {
  const start = fieldStartIndex(lines, field)
  if (start < 0) return [...lines]
  const end = fieldEndIndex(lines, start)
  return [...lines.slice(0, start), ...lines.slice(end)]
}

function insertionIndex(lines: readonly string[]): number {
  for (const field of ["sources", "related"]) {
    const start = fieldStartIndex(lines, field)
    if (start >= 0) return fieldEndIndex(lines, start)
  }
  return lines.length
}

function setGraphLinks(content: string, links: readonly string[]): string {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return content

  const rawBlock = match[0]
  const body = content.slice(rawBlock.length)
  const payload = match[1]
  const lines = payload.split(/\r?\n/)
  const currentGraphLinksStart = fieldStartIndex(lines, "graph_links")
  if (links.length === 0 && currentGraphLinksStart < 0) return content

  const withoutGraphLinks = removeTopLevelField(lines, "graph_links")
  const insertAt = insertionIndex(withoutGraphLinks)
  const nextLines = [
    ...withoutGraphLinks.slice(0, insertAt),
    ...graphLinkLines(links),
    ...withoutGraphLinks.slice(insertAt),
  ]
  const frontmatter = ["---", ...nextLines, "---", ""].join("\n")
  return `${frontmatter}${body}`
}

function hasGraphLinks(content: string): boolean {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return false
  return fieldStartIndex(match[1].split(/\r?\n/), "graph_links") >= 0
}

export function buildObsidianGraphLinkUpdates(
  pages: readonly ObsidianGraphLinkPage[],
  wikiRoot: string,
  pathsToUpdate?: readonly string[],
): ObsidianGraphLinkUpdate[] {
  const resolvablePages = buildResolvablePages(pages, wikiRoot)
  const resolver = buildGraphReferenceResolver(resolvablePages, wikiRoot)
  const byId = new Map(resolvablePages.map((page) => [page.id, page]))
  const scopedPaths = pathsToUpdate
    ? new Set(pathsToUpdate.map((path) => normalizeRelativePath(path)))
    : null
  const updates: ObsidianGraphLinkUpdate[] = []

  for (const page of resolvablePages) {
    if (scopedPaths && !scopedPaths.has(page.relativePath)) continue

    if (isStructuralPage(page)) {
      if (hasGraphLinks(page.content)) {
        updates.push({
          relativePath: page.relativePath,
          content: setGraphLinks(page.content, []),
          links: [],
        })
      }
      continue
    }

    const links: string[] = []

    for (const related of page.related) {
      const targetId = resolveWikiReference(related, resolver)
      if (targetId && targetId !== page.id) links.push(targetId)
    }

    for (const source of page.sources) {
      const targetId = resolveSourceReference(source, resolver)
      if (targetId && targetId !== page.id) links.push(targetId)
    }

    const uniqueLinks = uniqueSortedLinks(links).filter((id) => byId.has(id))
    const nextContent = setGraphLinks(page.content, uniqueLinks)
    if (nextContent !== page.content) {
      updates.push({
        relativePath: page.relativePath,
        content: nextContent,
        links: uniqueLinks,
      })
    }
  }

  return updates
}

export async function syncObsidianGraphLinks(
  projectPath: string,
  pathsToUpdate?: readonly string[],
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const files = flattenMdFiles(tree)
  const pages: ObsidianGraphLinkPage[] = []
  for (const file of files) {
    try {
      pages.push({
        relativePath: normalizeRelativePath(getRelativePath(file.path, wikiRoot)),
        content: await readFile(file.path),
      })
    } catch {
      // Ignore unreadable pages. Graph-link sync is a best-effort mirror.
    }
  }

  const updates = buildObsidianGraphLinkUpdates(
    pages,
    wikiRoot,
    pathsToUpdate?.map((path) => normalizeRelativePath(path)),
  )
  const written: string[] = []
  for (const update of updates) {
    const relativePath = normalizeRelativePath(update.relativePath)
    await writeFile(`${wikiRoot}/${relativePath}`, update.content)
    written.push(`wiki/${relativePath}`)
  }
  return written
}
