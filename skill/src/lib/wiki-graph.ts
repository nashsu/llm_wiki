import { readFile, listDirectory } from "../shims/fs-node"
import type { FileNode } from "../types/wiki"
import { buildRetrievalGraph, calculateRelevance } from "./graph-relevance"
import { normalizePath } from "./path-utils"
import Graph from "graphology"
import louvain from "graphology-communities-louvain"

export interface GraphNode {
  id: string
  label: string
  type: string
  path: string
  linkCount: number
  community: number
}

export interface GraphEdge {
  source: string
  target: string
  weight: number
}

export interface CommunityInfo {
  id: number
  nodeCount: number
  cohesion: number
  topNodes: string[]
}

function detectCommunities(
  nodes: { id: string; label: string; linkCount: number }[],
  edges: GraphEdge[],
): { assignments: Map<string, number>; communities: CommunityInfo[] } {
  if (nodes.length === 0) return { assignments: new Map(), communities: [] }

  const g = new Graph({ type: "undirected" })
  for (const node of nodes) g.addNode(node.id)
  for (const edge of edges) {
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      const key = `${edge.source}->${edge.target}`
      if (!g.hasEdge(key) && !g.hasEdge(`${edge.target}->${edge.source}`)) {
        g.addEdgeWithKey(key, edge.source, edge.target, { weight: edge.weight })
      }
    }
  }

  const communityMap: Record<string, number> = louvain(g, { resolution: 1 })
  const assignments = new Map(Object.entries(communityMap).map(([k, v]) => [k, v as number]))

  const groups = new Map<number, string[]>()
  for (const [nodeId, commId] of assignments) {
    const list = groups.get(commId) ?? []
    list.push(nodeId)
    groups.set(commId, list)
  }

  const edgeSet = new Set<string>()
  for (const edge of edges) {
    edgeSet.add(`${edge.source}:::${edge.target}`)
    edgeSet.add(`${edge.target}:::${edge.source}`)
  }

  const nodeInfo = new Map(nodes.map((n) => [n.id, { label: n.label, linkCount: n.linkCount }]))
  const communities: CommunityInfo[] = []

  for (const [commId, memberIds] of groups) {
    const n = memberIds.length
    let intraEdges = 0
    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        if (edgeSet.has(`${memberIds[i]}:::${memberIds[j]}`)) intraEdges++
      }
    }
    const possibleEdges = n > 1 ? (n * (n - 1)) / 2 : 1
    const cohesion = intraEdges / possibleEdges
    const sorted = [...memberIds].sort(
      (a, b) => (nodeInfo.get(b)?.linkCount ?? 0) - (nodeInfo.get(a)?.linkCount ?? 0)
    )
    communities.push({ id: commId, nodeCount: n, cohesion, topNodes: sorted.slice(0, 5).map((id) => nodeInfo.get(id)?.label ?? id) })
  }

  communities.sort((a, b) => b.nodeCount - a.nodeCount)
  const idRemap = new Map<number, number>()
  communities.forEach((c, idx) => { idRemap.set(c.id, idx); c.id = idx })
  for (const [nodeId, oldId] of assignments) assignments.set(nodeId, idRemap.get(oldId) ?? 0)

  return { assignments, communities }
}

const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) files.push(...flattenMdFiles(node.children))
    else if (!node.is_dir && node.name.endsWith(".md")) files.push(node)
  }
  return files
}

function extractTitle(content: string, fileName: string): string {
  const fm = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (fm) return fm[1].trim()
  const h = content.match(/^#\s+(.+)$/m)
  if (h) return h[1].trim()
  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

function extractType(content: string): string {
  const m = content.match(/^---\n[\s\S]*?^type:\s*["']?(.+?)["']?\s*$/m)
  return m ? m[1].trim().toLowerCase() : "other"
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = new RegExp(WIKILINK_REGEX.source, "g")
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) links.push(match[1].trim())
  return links
}

function resolveTarget(raw: string, nodeMap: Map<string, { id: string }>): string | null {
  if (nodeMap.has(raw)) return raw
  const normalized = raw.toLowerCase().replace(/\s+/g, "-")
  for (const id of nodeMap.keys()) {
    if (id.toLowerCase() === normalized) return id
    if (id.toLowerCase() === raw.toLowerCase()) return id
    if (id.toLowerCase().replace(/\s+/g, "-") === normalized) return id
  }
  return null
}

export async function buildWikiGraph(
  projectPath: string,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] }> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try { tree = await listDirectory(wikiRoot) } catch {
    return { nodes: [], edges: [], communities: [] }
  }

  const mdFiles = flattenMdFiles(tree)
  if (mdFiles.length === 0) return { nodes: [], edges: [], communities: [] }

  const nodeMap = new Map<string, { id: string; label: string; type: string; path: string; links: string[] }>()
  for (const file of mdFiles) {
    const id = file.name.replace(/\.md$/, "")
    let content = ""
    try { content = await readFile(file.path) } catch { continue }
    nodeMap.set(id, { id, label: extractTitle(content, file.name), type: extractType(content), path: file.path, links: extractWikilinks(content) })
  }

  const HIDDEN_TYPES = new Set(["query"])
  for (const [id, node] of nodeMap) {
    if (HIDDEN_TYPES.has(node.type)) nodeMap.delete(id)
  }

  const linkCounts = new Map<string, number>()
  for (const [id] of nodeMap) linkCounts.set(id, 0)

  const rawEdges: GraphEdge[] = []
  for (const [sourceId, nodeData] of nodeMap) {
    for (const targetRaw of nodeData.links) {
      const targetId = resolveTarget(targetRaw, nodeMap)
      if (targetId === null || targetId === sourceId) continue
      rawEdges.push({ source: sourceId, target: targetId, weight: 1 })
      linkCounts.set(sourceId, (linkCounts.get(sourceId) ?? 0) + 1)
      linkCounts.set(targetId, (linkCounts.get(targetId) ?? 0) + 1)
    }
  }

  const seenEdges = new Set<string>()
  const dedupedEdges: { source: string; target: string }[] = []
  for (const edge of rawEdges) {
    const key = `${edge.source}:::${edge.target}`
    const reverseKey = `${edge.target}:::${edge.source}`
    if (!seenEdges.has(key) && !seenEdges.has(reverseKey)) {
      seenEdges.add(key)
      dedupedEdges.push(edge)
    }
  }

  // Try to get retrieval graph for weighted edges (gracefully degrades)
  let retrievalGraph: Awaited<ReturnType<typeof buildRetrievalGraph>> | null = null
  try {
    const { useWikiStore } = await import("../shims/stores-node")
    const dv = useWikiStore.getState().dataVersion
    retrievalGraph = await buildRetrievalGraph(normalizePath(projectPath), dv)
  } catch { /* ignore — weights default to 1 */ }

  const edges: GraphEdge[] = dedupedEdges.map((e) => {
    let weight = 1
    if (retrievalGraph) {
      const nodeA = retrievalGraph.nodes.get(e.source)
      const nodeB = retrievalGraph.nodes.get(e.target)
      if (nodeA && nodeB) weight = calculateRelevance(nodeA, nodeB, retrievalGraph)
    }
    return { source: e.source, target: e.target, weight }
  })

  const prelimNodes = Array.from(nodeMap.values()).map((n) => ({ id: n.id, label: n.label, linkCount: linkCounts.get(n.id) ?? 0 }))
  const { assignments, communities } = detectCommunities(prelimNodes, edges)

  const nodes: GraphNode[] = Array.from(nodeMap.values()).map((n) => ({
    id: n.id, label: n.label, type: n.type, path: n.path,
    linkCount: linkCounts.get(n.id) ?? 0,
    community: assignments.get(n.id) ?? 0,
  }))

  return { nodes, edges, communities }
}
