import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalNode {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly path: string
  readonly sources: readonly string[]
  readonly outLinks: ReadonlySet<string>
  readonly inLinks: ReadonlySet<string>
}

export interface RetrievalGraph {
  readonly nodes: ReadonlyMap<string, RetrievalNode>
  readonly dataVersion: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
const GRAPH_FILE_READ_CONCURRENCY = 16
const MAX_CACHED_RETRIEVAL_GRAPHS = 2

const WEIGHTS = {
  directLink: 3.0,
  sourceOverlap: 4.0,
  commonNeighbor: 1.5,
  typeAffinity: 1.0,
} as const

const TYPE_AFFINITY: Record<string, Record<string, number>> = {
  entity: { concept: 1.2, entity: 0.8, source: 1.0, synthesis: 1.0, query: 0.8 },
  concept: { entity: 1.2, concept: 0.8, source: 1.0, synthesis: 1.2, query: 1.0 },
  source: { entity: 1.0, concept: 1.0, source: 0.5, query: 0.8, synthesis: 1.0 },
  query: { concept: 1.0, entity: 0.8, synthesis: 1.0, source: 0.8, query: 0.5 },
  synthesis: { concept: 1.2, entity: 1.0, source: 1.0, query: 1.0, synthesis: 0.8 },
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

const cachedGraphs = new Map<string, RetrievalGraph>()

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function flattenMdFiles(nodes: readonly FileNode[]): FileNode[] {
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

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await mapper(values[index])
    }
  })
  await Promise.all(workers)
  return results
}

function fileNameToId(fileName: string): string {
  return fileName.replace(/\.md$/, "")
}

function extractFrontmatter(content: string): { title: string; type: string; sources: string[]; related: string[] } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  const fm = fmMatch ? fmMatch[1] : ""

  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m)

  // Parse sources array from YAML frontmatter
  const sources: string[] = []
  const related: string[] = []
  const sourcesBlockMatch = fm.match(/^sources:\s*\n((?:\s+-\s+.+\n?)*)/m)
  if (sourcesBlockMatch) {
    const lines = sourcesBlockMatch[1].split("\n")
    for (const line of lines) {
      const itemMatch = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)
      if (itemMatch) {
        sources.push(itemMatch[1])
      }
    }
  } else {
    // Single-line: sources: ["a.pdf", "b.pdf"] or sources: [a.pdf]
    const inlineMatch = fm.match(/^sources:\s*\[([^\]]*)\]/m)
    if (inlineMatch) {
      const items = inlineMatch[1].split(",")
      for (const item of items) {
        const trimmed = item.trim().replace(/^["']|["']$/g, "")
        if (trimmed) sources.push(trimmed)
      }
    }
  }

  const parsedRelated = parseFrontmatter(content).frontmatter?.related
  if (Array.isArray(parsedRelated)) {
    for (const item of parsedRelated) {
      if (typeof item !== "string") continue
      const normalized = item
        .trim()
        .replace(/^\[\[|\]\]$/g, "")
        .split("|")[0]
        .split("#")[0]
        .replace(/\\/g, "/")
        .split("/")
        .pop()
        ?.replace(/\.md$/i, "") ?? ""
      if (normalized) related.push(normalized)
    }
  }

  let title = titleMatch ? titleMatch[1].trim() : ""
  if (!title) {
    const headingMatch = content.match(/^#\s+(.+)$/m)
    title = headingMatch ? headingMatch[1].trim() : ""
  }

  return {
    title,
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "other",
    sources,
    related,
  }
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

interface TargetResolver {
  readonly nodeIds: ReadonlySet<string>
  readonly aliases: ReadonlyMap<string, string>
}

function normalizeLinkKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "-")
}

function buildTargetResolver(nodeIds: ReadonlySet<string>): TargetResolver {
  const aliases = new Map<string, string>()
  for (const id of nodeIds) {
    const normalized = normalizeLinkKey(id)
    // Preserve the original directory-listing order for alias collisions.
    if (!aliases.has(normalized)) aliases.set(normalized, id)
  }
  return { nodeIds, aliases }
}

function resolveTarget(raw: string, resolver: TargetResolver): string | null {
  if (resolver.nodeIds.has(raw)) return raw
  return resolver.aliases.get(normalizeLinkKey(raw)) ?? null
}

function getNeighbors(node: RetrievalNode): ReadonlySet<string> {
  const neighbors = new Set<string>()
  for (const id of node.outLinks) neighbors.add(id)
  for (const id of node.inLinks) neighbors.add(id)
  return neighbors
}

function getNodeDegree(node: RetrievalNode): number {
  return node.outLinks.size + node.inLinks.size
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

export async function buildRetrievalGraph(
  projectPath: string,
  dataVersion: number = 0,
): Promise<RetrievalGraph> {
  const normalizedProjectPath = normalizePath(projectPath)
  // Return cached if version matches
  const cachedGraph = cachedGraphs.get(normalizedProjectPath)
  if (cachedGraph?.dataVersion === dataVersion) {
    return cachedGraph
  }

  const wikiRoot = `${normalizedProjectPath}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    const emptyGraph: RetrievalGraph = { nodes: new Map(), dataVersion }
    cacheRetrievalGraph(normalizedProjectPath, emptyGraph)
    return emptyGraph
  }

  const mdFiles = flattenMdFiles(tree)

  // First pass: read all files and build raw node data
  type RawNode = {
    id: string
    title: string
    type: string
    path: string
    sources: string[]
    rawLinks: string[]
    fileName: string
  }

  const parsedFiles = await mapWithConcurrency<FileNode, RawNode | null>(
    mdFiles,
    GRAPH_FILE_READ_CONCURRENCY,
    async (file) => {
      try {
        const content = await readFile(file.path)
        const fm = extractFrontmatter(content)
        return {
          id: fileNameToId(file.name),
          title: fm.title || file.name.replace(/\.md$/, "").replace(/-/g, " "),
          type: fm.type,
          path: file.path,
          sources: fm.sources,
          rawLinks: Array.from(new Set([...extractWikilinks(content), ...fm.related])),
          fileName: file.name,
        }
      } catch {
        return null
      }
    },
  )
  const rawNodes = parsedFiles.filter((node): node is RawNode => node !== null)

  const nodeIds = new Set(rawNodes.map((n) => n.id))
  const targetResolver = buildTargetResolver(nodeIds)

  // Second pass: resolve links and build graph nodes
  const outLinksMap = new Map<string, Set<string>>()
  const inLinksMap = new Map<string, Set<string>>()

  for (const id of nodeIds) {
    outLinksMap.set(id, new Set())
    inLinksMap.set(id, new Set())
  }

  for (const raw of rawNodes) {
    for (const linkTarget of raw.rawLinks) {
      const resolvedId = resolveTarget(linkTarget, targetResolver)
      if (resolvedId === null || resolvedId === raw.id) continue
      outLinksMap.get(raw.id)!.add(resolvedId)
      inLinksMap.get(resolvedId)!.add(raw.id)
    }
  }

  // Build immutable nodes map
  const nodes = new Map<string, RetrievalNode>()
  for (const raw of rawNodes) {
    nodes.set(raw.id, {
      id: raw.id,
      title: raw.title,
      type: raw.type,
      path: raw.path,
      sources: Object.freeze([...raw.sources]),
      outLinks: Object.freeze(outLinksMap.get(raw.id) ?? new Set<string>()),
      inLinks: Object.freeze(inLinksMap.get(raw.id) ?? new Set<string>()),
    })
  }

  const graph: RetrievalGraph = { nodes, dataVersion }
  cacheRetrievalGraph(normalizedProjectPath, graph)
  return graph
}

function cacheRetrievalGraph(projectPath: string, graph: RetrievalGraph): void {
  cachedGraphs.delete(projectPath)
  if (cachedGraphs.size >= MAX_CACHED_RETRIEVAL_GRAPHS) {
    const oldest = cachedGraphs.keys().next().value
    if (oldest) cachedGraphs.delete(oldest)
  }
  cachedGraphs.set(projectPath, graph)
}

export function calculateRelevance(
  nodeA: RetrievalNode,
  nodeB: RetrievalNode,
  graph: RetrievalGraph,
): number {
  if (nodeA.id === nodeB.id) return 0

  // Signal 1: Direct links (weight 3.0)
  const forwardLinks = nodeA.outLinks.has(nodeB.id) ? 1 : 0
  const backwardLinks = nodeB.outLinks.has(nodeA.id) ? 1 : 0
  const directLinkScore = (forwardLinks + backwardLinks) * WEIGHTS.directLink

  // Signal 2: Source overlap (weight 4.0)
  const sourcesA = new Set(nodeA.sources)
  let sharedSourceCount = 0
  for (const src of nodeB.sources) {
    if (sourcesA.has(src)) sharedSourceCount += 1
  }
  const sourceOverlapScore = sharedSourceCount * WEIGHTS.sourceOverlap

  // Signal 3: Common neighbors - Adamic-Adar (weight 1.5)
  const neighborsA = getNeighbors(nodeA)
  const neighborsB = getNeighbors(nodeB)
  let adamicAdar = 0
  for (const neighborId of neighborsA) {
    if (neighborsB.has(neighborId)) {
      const neighbor = graph.nodes.get(neighborId)
      if (neighbor) {
        const degree = getNodeDegree(neighbor)
        adamicAdar += 1 / Math.log(Math.max(degree, 2))
      }
    }
  }
  const commonNeighborScore = adamicAdar * WEIGHTS.commonNeighbor

  // Signal 4: Type affinity (weight 1.0)
  const affinityMap = TYPE_AFFINITY[nodeA.type]
  const typeAffinityScore = (affinityMap?.[nodeB.type] ?? 0.5) * WEIGHTS.typeAffinity

  return directLinkScore + sourceOverlapScore + commonNeighborScore + typeAffinityScore
}

export function getRelatedNodes(
  nodeId: string,
  graph: RetrievalGraph,
  limit: number = 5,
): ReadonlyArray<{ node: RetrievalNode; relevance: number }> {
  const sourceNode = graph.nodes.get(nodeId)
  if (!sourceNode) return []

  const scored: Array<{ node: RetrievalNode; relevance: number }> = []
  for (const [id, node] of graph.nodes) {
    if (id === nodeId) continue
    const relevance = calculateRelevance(sourceNode, node, graph)
    if (relevance > 0) {
      scored.push({ node, relevance })
    }
  }

  scored.sort((a, b) => b.relevance - a.relevance)
  return scored.slice(0, limit)
}

export function clearGraphCache(): void {
  cachedGraphs.clear()
}
