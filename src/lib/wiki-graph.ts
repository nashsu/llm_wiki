import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { buildRetrievalGraph, calculateRelevance } from "./graph-relevance"
import { normalizePath } from "@/lib/path-utils"
import {
  buildGraphReferenceResolver,
  fileNameToGraphId,
  GRAPH_EDGE_TYPE_WEIGHT,
  parseGraphPage,
  resolveSourceReference,
  resolveWikiReference,
  type GraphEdgeType,
  type GraphRelationship,
} from "@/lib/graph-relations"
import { isGraphViewExcludedPage } from "@/lib/graph-exclusions"
import {
  RELATIONSHIP_STRENGTH_WEIGHT,
  type EvidenceStrength,
  type KnowledgeType,
  type QueryRetention,
  type RelationshipStrength,
  type ReviewStatus,
  type WikiLifecycleState,
} from "@/lib/wiki-metadata"
import Graph from "graphology"
import louvain from "graphology-communities-louvain"

export interface GraphNode {
  id: string
  label: string
  type: string
  path: string
  related: string[]
  sources: string[]
  relationships: GraphRelationship[]
  state?: WikiLifecycleState
  quality?: string
  coverage?: string
  evidenceStrength?: EvidenceStrength
  reviewStatus?: ReviewStatus
  knowledgeType?: KnowledgeType
  retention?: QueryRetention
  needsUpgrade?: boolean
  sourceCount?: number
  unresolvedRelated: string[]
  unresolvedSources: string[]
  linkCount: number // inbound + outbound
  community: number // community id from Louvain detection
}

export interface GraphEdge {
  source: string
  target: string
  types: GraphEdgeType[]
  relationshipStrength?: RelationshipStrength
  weight: number // relevance score between source and target
}

export interface CommunityInfo {
  id: number
  nodeCount: number
  cohesion: number // intra-community edge density
  topNodes: string[] // top nodes by linkCount (labels)
}

/** Run Louvain community detection and compute cohesion per community */
function detectCommunities(
  nodes: { id: string; label: string; linkCount: number }[],
  edges: GraphEdge[],
): { assignments: Map<string, number>; communities: CommunityInfo[] } {
  if (nodes.length === 0) {
    return { assignments: new Map(), communities: [] }
  }

  const g = new Graph({ type: "undirected" })
  for (const node of nodes) {
    g.addNode(node.id)
  }
  for (const edge of edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      const key = `${edge.source}->${edge.target}`
      if (!g.hasEdge(key) && !g.hasEdge(`${edge.target}->${edge.source}`)) {
        g.addEdgeWithKey(key, edge.source, edge.target, { weight: edge.weight })
      }
    }
  }

  // Run Louvain — returns { nodeId: communityId }
  const communityMap: Record<string, number> = louvain(g, { resolution: 1 })
  const assignments = new Map(Object.entries(communityMap).map(([k, v]) => [k, v as number]))

  // Group nodes by community
  const groups = new Map<number, string[]>()
  for (const [nodeId, commId] of assignments) {
    const list = groups.get(commId) ?? []
    list.push(nodeId)
    groups.set(commId, list)
  }

  // Build edge lookup for cohesion calculation
  const edgeSet = new Set<string>()
  for (const edge of edges) {
    edgeSet.add(`${edge.source}:::${edge.target}`)
    edgeSet.add(`${edge.target}:::${edge.source}`)
  }

  // Build label + linkCount lookup
  const nodeInfo = new Map(nodes.map((n) => [n.id, { label: n.label, linkCount: n.linkCount }]))

  // Compute per-community info
  const communities: CommunityInfo[] = []
  for (const [commId, memberIds] of groups) {
    const n = memberIds.length
    // Cohesion = actual intra-community edges / possible edges
    let intraEdges = 0
    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        if (edgeSet.has(`${memberIds[i]}:::${memberIds[j]}`)) {
          intraEdges++
        }
      }
    }
    const possibleEdges = n > 1 ? (n * (n - 1)) / 2 : 1
    const cohesion = intraEdges / possibleEdges

    // Top nodes by linkCount
    const sorted = [...memberIds].sort(
      (a, b) => (nodeInfo.get(b)?.linkCount ?? 0) - (nodeInfo.get(a)?.linkCount ?? 0),
    )
    const topNodes = sorted.slice(0, 5).map((id) => nodeInfo.get(id)?.label ?? id)

    communities.push({ id: commId, nodeCount: n, cohesion, topNodes })
  }

  // Sort by nodeCount descending
  communities.sort((a, b) => b.nodeCount - a.nodeCount)

  // Re-number community IDs sequentially (0, 1, 2, ...)
  const idRemap = new Map<number, number>()
  communities.forEach((c, idx) => {
    idRemap.set(c.id, idx)
    c.id = idx
  })
  for (const [nodeId, oldId] of assignments) {
    assignments.set(nodeId, idRemap.get(oldId) ?? 0)
  }

  return { assignments, communities }
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

export async function buildWikiGraph(
  projectPath: string,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] }> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`

  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return { nodes: [], edges: [], communities: [] }
  }

  const mdFiles = flattenMdFiles(tree)
  if (mdFiles.length === 0) {
    return { nodes: [], edges: [], communities: [] }
  }

  const nodeMap = new Map<
    string,
    {
      id: string
      label: string
      type: string
      path: string
      links: string[]
      related: string[]
      sources: string[]
      relationships: GraphRelationship[]
      state?: WikiLifecycleState
      quality?: string
      coverage?: string
      evidenceStrength?: EvidenceStrength
      reviewStatus?: ReviewStatus
      knowledgeType?: KnowledgeType
      retention?: QueryRetention
      needsUpgrade?: boolean
      sourceCount?: number
      unresolvedRelated: string[]
      unresolvedSources: string[]
    }
  >()

  for (const file of mdFiles) {
    const id = fileNameToGraphId(file.name)
    let content = ""
    try {
      content = await readFile(file.path)
    } catch {
      // Skip unreadable files
      continue
    }

    if (isGraphViewExcludedPage(file.path, file.name, content)) {
      continue
    }

    const page = parseGraphPage(content, file.name, file.path)
    nodeMap.set(id, {
      id,
      label: page.title,
      type: page.type,
      path: file.path,
      links: page.wikilinks,
      related: page.related,
      sources: page.sources,
      relationships: page.relationships,
      state: page.state,
      quality: page.quality,
      coverage: page.coverage,
      evidenceStrength: page.evidenceStrength,
      reviewStatus: page.reviewStatus,
      knowledgeType: page.knowledgeType,
      retention: page.retention,
      needsUpgrade: page.needsUpgrade,
      sourceCount: page.sourceCount,
      unresolvedRelated: [],
      unresolvedSources: [],
    })
  }

  const resolver = buildGraphReferenceResolver([...nodeMap.values()], wikiRoot)

  const edgeMap = new Map<string, {
    source: string
    target: string
    types: Set<GraphEdgeType>
    relationshipStrength?: RelationshipStrength
  }>()

  for (const [sourceId, nodeData] of nodeMap.entries()) {
    for (const targetRaw of nodeData.links) {
      const targetId = resolveWikiReference(targetRaw, resolver)
      if (targetId === null) continue
      addGraphEdge(edgeMap, sourceId, targetId, "wikilink")
    }

    for (const targetRaw of nodeData.related) {
      const targetId = resolveWikiReference(targetRaw, resolver)
      if (targetId === null) {
        nodeData.unresolvedRelated.push(targetRaw)
        continue
      }
      addGraphEdge(edgeMap, sourceId, targetId, "related")
    }

    for (const sourceRaw of nodeData.sources) {
      const targetId = resolveSourceReference(sourceRaw, resolver)
      if (targetId === null) {
        nodeData.unresolvedSources.push(sourceRaw)
        continue
      }
      addGraphEdge(edgeMap, sourceId, targetId, "source")
    }

    for (const relationship of nodeData.relationships) {
      const targetId = resolveWikiReference(relationship.target, resolver)
      if (targetId === null) {
        nodeData.unresolvedRelated.push(relationship.target)
        continue
      }
      addGraphEdge(edgeMap, sourceId, targetId, "related", relationship.strength)
    }
  }

  // Calculate relevance weights using the retrieval graph
  let retrievalGraph: Awaited<ReturnType<typeof buildRetrievalGraph>> | null = null
  try {
    const { useWikiStore } = await import("@/stores/wiki-store")
    const dv = useWikiStore.getState().dataVersion
    retrievalGraph = await buildRetrievalGraph(normalizePath(projectPath), dv)
  } catch {
    // ignore — weights will default to 1
  }

  const edges: GraphEdge[] = [...edgeMap.values()].map((e) => {
    const types = [...e.types].sort(sortEdgeTypes)
    let weight = types.reduce((sum, type) => sum + GRAPH_EDGE_TYPE_WEIGHT[type], 0)
    if (e.relationshipStrength) {
      weight += RELATIONSHIP_STRENGTH_WEIGHT[e.relationshipStrength]
    }
    if (retrievalGraph) {
      const nodeA = retrievalGraph.nodes.get(e.source)
      const nodeB = retrievalGraph.nodes.get(e.target)
      if (nodeA && nodeB) {
        weight += calculateRelevance(nodeA, nodeB, retrievalGraph)
      }
    }
    return e.relationshipStrength
      ? { source: e.source, target: e.target, types, relationshipStrength: e.relationshipStrength, weight }
      : { source: e.source, target: e.target, types, weight }
  })

  const linkCounts = new Map<string, number>()
  for (const id of nodeMap.keys()) {
    linkCounts.set(id, 0)
  }
  for (const edge of edges) {
    linkCounts.set(edge.source, (linkCounts.get(edge.source) ?? 0) + 1)
    linkCounts.set(edge.target, (linkCounts.get(edge.target) ?? 0) + 1)
  }

  // Build preliminary nodes for community detection
  const prelimNodes = Array.from(nodeMap.values()).map((n) => ({
    id: n.id,
    label: n.label,
    linkCount: linkCounts.get(n.id) ?? 0,
  }))

  const { assignments, communities } = detectCommunities(prelimNodes, edges)

  const nodes: GraphNode[] = Array.from(nodeMap.values()).map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    path: n.path,
    related: n.related,
    sources: n.sources,
    relationships: n.relationships,
    state: n.state,
    quality: n.quality,
    coverage: n.coverage,
    evidenceStrength: n.evidenceStrength,
    reviewStatus: n.reviewStatus,
    knowledgeType: n.knowledgeType,
    retention: n.retention,
    needsUpgrade: n.needsUpgrade,
    sourceCount: n.sourceCount,
    unresolvedRelated: n.unresolvedRelated,
    unresolvedSources: n.unresolvedSources,
    linkCount: linkCounts.get(n.id) ?? 0,
    community: assignments.get(n.id) ?? 0,
  }))

  return { nodes, edges, communities }
}

function addGraphEdge(
  edgeMap: Map<string, {
    source: string
    target: string
    types: Set<GraphEdgeType>
    relationshipStrength?: RelationshipStrength
  }>,
  source: string,
  target: string,
  type: GraphEdgeType,
  relationshipStrength?: RelationshipStrength,
): void {
  if (source === target) return
  const key = [source, target].sort().join(":::")
  const existing = edgeMap.get(key)
  if (existing) {
    existing.types.add(type)
    existing.relationshipStrength = strongerRelationshipStrength(
      existing.relationshipStrength,
      relationshipStrength,
    )
    return
  }
  edgeMap.set(key, { source, target, types: new Set([type]), relationshipStrength })
}

function sortEdgeTypes(a: GraphEdgeType, b: GraphEdgeType): number {
  return GRAPH_EDGE_TYPE_WEIGHT[a] - GRAPH_EDGE_TYPE_WEIGHT[b]
}

function strongerRelationshipStrength(
  current: RelationshipStrength | undefined,
  next: RelationshipStrength | undefined,
): RelationshipStrength | undefined {
  if (!next) return current
  if (!current) return next
  return RELATIONSHIP_STRENGTH_WEIGHT[next] > RELATIONSHIP_STRENGTH_WEIGHT[current]
    ? next
    : current
}
