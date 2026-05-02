import type { GraphNode, GraphEdge, CommunityInfo } from "./wiki-graph"

export interface SurprisingConnection {
  source: GraphNode
  target: GraphNode
  score: number
  reasons: string[]
  key: string
}

export interface KnowledgeGap {
  type: "isolated-node" | "sparse-community" | "bridge-node"
  title: string
  description: string
  nodeIds: string[]
  suggestion: string
}

export function findSurprisingConnections(
  nodes: GraphNode[],
  edges: GraphEdge[],
  _communities: CommunityInfo[],
  limit: number = 5,
): SurprisingConnection[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const degreeMap = new Map(nodes.map((n) => [n.id, n.linkCount]))
  const maxDegree = Math.max(...nodes.map((n) => n.linkCount), 1)
  const STRUCTURAL_IDS = new Set(["index", "log", "overview"])
  const scored: SurprisingConnection[] = []

  for (const edge of edges) {
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (!source || !target) continue
    if (STRUCTURAL_IDS.has(source.id) || STRUCTURAL_IDS.has(target.id)) continue

    let score = 0
    const reasons: string[] = []

    if (source.community !== target.community) {
      score += 3
      reasons.push("crosses community boundary")
    }
    if (source.type !== target.type) {
      const distantPairs = new Set([
        "source-concept", "concept-source", "source-synthesis", "synthesis-source",
        "query-entity", "entity-query",
      ])
      if (distantPairs.has(`${source.type}-${target.type}`)) {
        score += 2
        reasons.push(`connects ${source.type} to ${target.type}`)
      } else {
        score += 1
        reasons.push("different types")
      }
    }
    const sourceDeg = degreeMap.get(source.id) ?? 0
    const targetDeg = degreeMap.get(target.id) ?? 0
    const minDeg = Math.min(sourceDeg, targetDeg)
    const maxDeg = Math.max(sourceDeg, targetDeg)
    if (minDeg <= 2 && maxDeg >= maxDegree * 0.5) {
      score += 2
      reasons.push("peripheral node links to hub")
    }
    if (edge.weight < 2 && edge.weight > 0) {
      score += 1
      reasons.push("weak but present connection")
    }
    if (score >= 3 && reasons.length > 0) {
      const key = [source.id, target.id].sort().join(":::")
      scored.push({ source, target, score, reasons, key })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

export function detectKnowledgeGaps(
  nodes: GraphNode[],
  edges: GraphEdge[],
  communities: CommunityInfo[],
  limit: number = 8,
): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = []
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // 1. Isolated nodes (degree ≤ 1)
  const isolatedNodes = nodes.filter(
    (n) => n.linkCount <= 1 && n.type !== "overview" && n.id !== "index" && n.id !== "log",
  )
  if (isolatedNodes.length > 0) {
    const topIsolated = isolatedNodes.slice(0, 5)
    gaps.push({
      type: "isolated-node",
      title: `${isolatedNodes.length} isolated page${isolatedNodes.length > 1 ? "s" : ""}`,
      description: topIsolated.map((n) => n.label).join(", ") +
        (isolatedNodes.length > 5 ? ` and ${isolatedNodes.length - 5} more` : ""),
      nodeIds: isolatedNodes.map((n) => n.id),
      suggestion: "These pages have few or no connections. Consider adding [[wikilinks]] to related pages.",
    })
  }

  // 2. Sparse communities (low cohesion)
  for (const comm of communities) {
    if (comm.cohesion < 0.15 && comm.nodeCount >= 3) {
      gaps.push({
        type: "sparse-community",
        title: `Sparse cluster: ${comm.topNodes[0] ?? `Community ${comm.id}`}`,
        description: `${comm.nodeCount} pages with cohesion ${comm.cohesion.toFixed(2)} — internal connections are weak.`,
        nodeIds: nodes.filter((n) => n.community === comm.id).map((n) => n.id),
        suggestion: "This knowledge area lacks internal cross-references. Consider adding links between these pages.",
      })
    }
  }

  // 3. Bridge nodes (connected to multiple communities)
  const communityNeighbors = new Map<string, Set<number>>()
  for (const node of nodes) communityNeighbors.set(node.id, new Set())
  for (const edge of edges) {
    const sourceNode = nodeMap.get(edge.source)
    const targetNode = nodeMap.get(edge.target)
    if (sourceNode && targetNode) {
      communityNeighbors.get(edge.source)?.add(targetNode.community)
      communityNeighbors.get(edge.target)?.add(sourceNode.community)
    }
  }
  const STRUCTURAL_IDS = new Set(["index", "log", "overview"])
  const bridgeNodes = nodes
    .filter((n) => {
      if (STRUCTURAL_IDS.has(n.id)) return false
      const neighborComms = communityNeighbors.get(n.id)
      return neighborComms && neighborComms.size >= 3
    })
    .sort((a, b) => (communityNeighbors.get(b.id)?.size ?? 0) - (communityNeighbors.get(a.id)?.size ?? 0))
    .slice(0, 3)

  for (const bridge of bridgeNodes) {
    const commCount = communityNeighbors.get(bridge.id)?.size ?? 0
    gaps.push({
      type: "bridge-node",
      title: `Key bridge: ${bridge.label}`,
      description: `Connects ${commCount} different knowledge clusters. This is a critical junction in your wiki.`,
      nodeIds: [bridge.id],
      suggestion: "This page bridges multiple knowledge areas. Ensure it's well-maintained and expanded.",
    })
  }

  return gaps.slice(0, limit)
}
