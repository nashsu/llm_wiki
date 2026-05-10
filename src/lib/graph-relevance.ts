import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import {
  buildGraphReferenceResolver,
  fileNameToGraphId,
  parseGraphPage,
  resolveSourceReference,
  resolveWikiReference,
} from "@/lib/graph-relations"
import { isGraphViewExcludedPage } from "@/lib/graph-exclusions"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalNode {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly path: string
  readonly sources: readonly string[]
  readonly related: readonly string[]
  readonly wikiLinks: ReadonlySet<string>
  readonly relatedLinks: ReadonlySet<string>
  readonly sourceLinks: ReadonlySet<string>
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

const WEIGHTS = {
  wikilink: 3.0,
  relatedLink: 4.0,
  sourceLink: 4.5,
  sourceOverlap: 4.0,
  commonNeighbor: 1.5,
  typeAffinity: 1.0,
} as const

const TYPE_AFFINITY: Record<string, Record<string, number>> = {
  entity: { concept: 1.2, entity: 0.8, source: 1.0, query: 0.8, comparison: 0.9, synthesis: 1.0 },
  concept: { entity: 1.2, concept: 0.8, source: 1.0, query: 1.0, comparison: 1.0, synthesis: 1.2 },
  source: { entity: 1.0, concept: 1.0, source: 0.5, query: 0.8, comparison: 1.0, synthesis: 1.0 },
  query: { concept: 1.0, entity: 0.8, source: 0.8, query: 0.5, comparison: 0.8, synthesis: 1.0 },
  comparison: { concept: 1.0, entity: 0.9, source: 1.0, query: 0.8, comparison: 0.8, synthesis: 1.0 },
  synthesis: { concept: 1.2, entity: 1.0, source: 1.0, query: 1.0, comparison: 1.0, synthesis: 0.8 },
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let cachedGraph: RetrievalGraph | null = null

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
  // Return cached if version matches
  if (cachedGraph !== null && cachedGraph.dataVersion === dataVersion) {
    return cachedGraph
  }

  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    const emptyGraph: RetrievalGraph = { nodes: new Map(), dataVersion }
    cachedGraph = emptyGraph
    return emptyGraph
  }

  const mdFiles = flattenMdFiles(tree)

  // First pass: read all files and build raw node data
  const rawNodes: Array<{
    id: string
    title: string
    type: string
    path: string
    sources: string[]
    related: string[]
    rawLinks: string[]
  }> = []

  for (const file of mdFiles) {
    const id = fileNameToGraphId(file.name)
    let content = ""
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    if (isGraphViewExcludedPage(file.path, file.name, content)) {
      continue
    }

    const page = parseGraphPage(content, file.name, file.path)
    rawNodes.push({
      id,
      title: page.title,
      type: page.type,
      path: file.path,
      sources: page.sources,
      related: page.related,
      rawLinks: page.wikilinks,
    })
  }

  const resolver = buildGraphReferenceResolver(rawNodes, wikiRoot)

  // Second pass: resolve links and build graph nodes
  const outLinksMap = new Map<string, Set<string>>()
  const inLinksMap = new Map<string, Set<string>>()
  const wikiLinksMap = new Map<string, Set<string>>()
  const relatedLinksMap = new Map<string, Set<string>>()
  const sourceLinksMap = new Map<string, Set<string>>()

  for (const { id } of rawNodes) {
    outLinksMap.set(id, new Set())
    inLinksMap.set(id, new Set())
    wikiLinksMap.set(id, new Set())
    relatedLinksMap.set(id, new Set())
    sourceLinksMap.set(id, new Set())
  }

  for (const raw of rawNodes) {
    for (const linkTarget of raw.rawLinks) {
      const resolvedId = resolveWikiReference(linkTarget, resolver)
      addResolvedLink(raw.id, resolvedId, outLinksMap, inLinksMap, wikiLinksMap)
    }
    for (const linkTarget of raw.related) {
      const resolvedId = resolveWikiReference(linkTarget, resolver)
      addResolvedLink(raw.id, resolvedId, outLinksMap, inLinksMap, relatedLinksMap)
    }
    for (const sourceTarget of raw.sources) {
      const resolvedId = resolveSourceReference(sourceTarget, resolver)
      addResolvedLink(raw.id, resolvedId, outLinksMap, inLinksMap, sourceLinksMap)
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
      related: Object.freeze([...raw.related]),
      wikiLinks: Object.freeze(wikiLinksMap.get(raw.id) ?? new Set<string>()),
      relatedLinks: Object.freeze(relatedLinksMap.get(raw.id) ?? new Set<string>()),
      sourceLinks: Object.freeze(sourceLinksMap.get(raw.id) ?? new Set<string>()),
      outLinks: Object.freeze(outLinksMap.get(raw.id) ?? new Set<string>()),
      inLinks: Object.freeze(inLinksMap.get(raw.id) ?? new Set<string>()),
    })
  }

  const graph: RetrievalGraph = { nodes, dataVersion }
  cachedGraph = graph
  return graph
}

export function calculateRelevance(
  nodeA: RetrievalNode,
  nodeB: RetrievalNode,
  graph: RetrievalGraph,
): number {
  if (nodeA.id === nodeB.id) return 0

  // Signal 1: Direct relationship edges.
  const wikilinkScore =
    (Number(nodeA.wikiLinks.has(nodeB.id)) + Number(nodeB.wikiLinks.has(nodeA.id))) *
    WEIGHTS.wikilink
  const relatedLinkScore =
    (Number(nodeA.relatedLinks.has(nodeB.id)) + Number(nodeB.relatedLinks.has(nodeA.id))) *
    WEIGHTS.relatedLink
  const sourceLinkScore =
    (Number(nodeA.sourceLinks.has(nodeB.id)) + Number(nodeB.sourceLinks.has(nodeA.id))) *
    WEIGHTS.sourceLink

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

  return wikilinkScore + relatedLinkScore + sourceLinkScore + sourceOverlapScore + commonNeighborScore + typeAffinityScore
}

function addResolvedLink(
  sourceId: string,
  targetId: string | null,
  outLinksMap: Map<string, Set<string>>,
  inLinksMap: Map<string, Set<string>>,
  typedLinksMap: Map<string, Set<string>>,
): void {
  if (targetId === null || targetId === sourceId) return
  outLinksMap.get(sourceId)!.add(targetId)
  inLinksMap.get(targetId)!.add(sourceId)
  typedLinksMap.get(sourceId)!.add(targetId)
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
  cachedGraph = null
}
