import { parseFrontmatter, type FrontmatterValue } from "@/lib/frontmatter"
import { getGraphNodeTypeFromPath } from "@/lib/graph-node-types"

export type GraphEdgeType = "wikilink" | "related" | "source"

export const GRAPH_EDGE_TYPE_WEIGHT: Record<GraphEdgeType, number> = {
  wikilink: 1,
  related: 2,
  source: 3,
}

export interface ParsedGraphPage {
  title: string
  type: string
  wikilinks: string[]
  related: string[]
  sources: string[]
}

export interface GraphResolvableNode {
  id: string
  type: string
  path: string
  sources?: string[]
}

export interface GraphReferenceResolver {
  allIds: ReadonlyMap<string, string>
  allPaths: ReadonlyMap<string, string>
  sourceIds: ReadonlyMap<string, string>
  sourcePaths: ReadonlyMap<string, string>
}

const WIKILINK_REGEX = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+?)?\]\]/g

export function fileNameToGraphId(fileName: string): string {
  return fileName.replace(/\.md$/i, "")
}

export function parseGraphPage(
  content: string,
  fileName: string,
  filePath: string,
): ParsedGraphPage {
  const parsed = parseFrontmatter(content)
  const frontmatter = parsed.frontmatter
  const body = parsed.body
  const title = scalarValue(frontmatter?.title) ?? extractHeading(body) ?? titleFromFileName(fileName)
  const frontmatterType = scalarValue(frontmatter?.type)?.trim().toLowerCase()

  return {
    title,
    type: getGraphNodeTypeFromPath(filePath) ?? frontmatterType ?? "other",
    wikilinks: extractWikilinks(body),
    related: arrayValue(frontmatter?.related),
    sources: arrayValue(frontmatter?.sources),
  }
}

export function buildGraphReferenceResolver(
  nodes: readonly GraphResolvableNode[],
  wikiRoot: string,
): GraphReferenceResolver {
  const allIds = new Map<string, string>()
  const allPaths = new Map<string, string>()
  const sourceIds = new Map<string, string>()
  const sourcePaths = new Map<string, string>()

  for (const node of nodes) {
    addIdLookup(allIds, node.id, node.id)

    const fileName = basename(node.path)
    addIdLookup(allIds, fileName, node.id)
    addIdLookup(allIds, fileNameToGraphId(fileName), node.id)

    const relativeWikiPath = getRelativeWikiPath(node.path, wikiRoot)
    if (relativeWikiPath) {
      addPathLookup(allPaths, `wiki/${relativeWikiPath}`, node.id)
      addPathLookup(allPaths, `wiki/${stripMdExtension(relativeWikiPath)}`, node.id)
      addPathLookup(allPaths, relativeWikiPath, node.id)
      addPathLookup(allPaths, stripMdExtension(relativeWikiPath), node.id)
    }

    if (isWikiSourceNode(node, wikiRoot)) {
      addIdLookup(sourceIds, node.id, node.id)
      addIdLookup(sourceIds, fileName, node.id)
      addIdLookup(sourceIds, fileNameToGraphId(fileName), node.id)
      for (const sourceName of node.sources ?? []) {
        addIdLookup(sourceIds, sourceName, node.id)
        addIdLookup(sourceIds, stripAnyExtension(sourceName), node.id)
      }

      if (relativeWikiPath) {
        addPathLookup(sourcePaths, `wiki/${relativeWikiPath}`, node.id)
        addPathLookup(sourcePaths, `wiki/${stripMdExtension(relativeWikiPath)}`, node.id)
        addPathLookup(sourcePaths, relativeWikiPath, node.id)
        addPathLookup(sourcePaths, stripMdExtension(relativeWikiPath), node.id)
      }
    }
  }

  return { allIds, allPaths, sourceIds, sourcePaths }
}

export function resolveWikiReference(
  raw: string,
  resolver: GraphReferenceResolver,
): string | null {
  const ref = unwrapGraphReference(raw)
  if (!ref) return null

  if (isPathLike(ref)) {
    return resolvePathReference(ref, resolver.allPaths)
  }

  return resolver.allIds.get(normalizeIdKey(ref)) ?? null
}

export function resolveSourceReference(
  raw: string,
  resolver: GraphReferenceResolver,
): string | null {
  const ref = unwrapGraphReference(raw)
  if (!ref) return null

  if (isPathLike(ref)) {
    return resolvePathReference(ref, resolver.sourcePaths)
  }

  return resolver.sourceIds.get(normalizeIdKey(ref)) ?? null
}

export function unwrapGraphReference(raw: string): string {
  const trimmed = raw.trim()
  const match = trimmed.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/)
  const target = (match ? match[1] : trimmed).trim()
  return target.replace(/#.*$/, "").trim()
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = new RegExp(WIKILINK_REGEX.source, "g")
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function scalarValue(value: FrontmatterValue | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function arrayValue(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => v.trim()).filter((v) => v.length > 0)
  }
  const scalar = scalarValue(value)
  return scalar ? [scalar] : []
}

function extractHeading(content: string): string | null {
  const headingMatch = content.match(/^#\s+(.+)$/m)
  return headingMatch ? headingMatch[1].trim() : null
}

function titleFromFileName(fileName: string): string {
  return fileNameToGraphId(fileName).replace(/-/g, " ")
}

function resolvePathReference(raw: string, paths: ReadonlyMap<string, string>): string | null {
  const withMd = raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`
  const withoutMd = stripMdExtension(raw)
  return paths.get(normalizePathKey(raw))
    ?? paths.get(normalizePathKey(withMd))
    ?? paths.get(normalizePathKey(withoutMd))
    ?? null
}

function isWikiSourceNode(node: GraphResolvableNode, wikiRoot: string): boolean {
  if (node.type !== "source") return false
  const relativeWikiPath = getRelativeWikiPath(node.path, wikiRoot)
  return relativeWikiPath?.toLowerCase().startsWith("sources/") ?? false
}

function getRelativeWikiPath(filePath: string, wikiRoot: string): string | null {
  const normalizedPath = normalizeSlashes(filePath)
  const normalizedRoot = normalizeSlashes(wikiRoot).replace(/\/$/, "")
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return null
  return normalizedPath.slice(normalizedRoot.length + 1)
}

function addIdLookup(map: Map<string, string>, value: string, id: string): void {
  map.set(normalizeIdKey(value), id)
}

function addPathLookup(map: Map<string, string>, value: string, id: string): void {
  map.set(normalizePathKey(value), id)
}

function normalizeIdKey(value: string): string {
  return stripMdExtension(unwrapGraphReference(value))
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .trim()
    .replace(/\s+/g, "-")
    .normalize("NFC")
    .toLowerCase()
}

function normalizePathKey(value: string): string {
  return normalizeSlashes(value)
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .normalize("NFC")
    .toLowerCase()
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/").normalize("NFC")
}

function stripMdExtension(value: string): string {
  return value.replace(/\.md$/i, "")
}

function stripAnyExtension(value: string): string {
  return value.replace(/\.[^./\\]+$/i, "")
}

function basename(path: string): string {
  return normalizeSlashes(path).split("/").pop() ?? path
}

function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\")
}
