import type { GraphNode, GraphEdge, CommunityInfo } from "./wiki-graph"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SurprisingConnection {
  source: GraphNode
  target: GraphNode
  score: number
  reasons: string[]
  key: string // stable ID for dismiss tracking
}

export interface KnowledgeGap {
  type: "isolated-node" | "sparse-community" | "bridge-node"
  title: string
  description: string
  nodeIds: string[]
  suggestion: string
}

// ---------------------------------------------------------------------------
// Surprising Connections
// ---------------------------------------------------------------------------

/**
 * Find edges that are "surprising" — connecting nodes across communities,
 * across types, or linking peripheral nodes to hubs.
 */
export function findSurprisingConnections(
  nodes: GraphNode[],
  edges: GraphEdge[],
  _communities: CommunityInfo[],
  limit: number = 5,
): SurprisingConnection[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const degreeMap = new Map(nodes.map((n) => [n.id, n.linkCount]))
  const maxDegree = Math.max(...nodes.map((n) => n.linkCount), 1)

  // Structural pages that link to everything — exclude from analysis
  const STRUCTURAL_IDS = new Set(["index", "log", "overview"])

  const scored: SurprisingConnection[] = []

  for (const edge of edges) {
    const source = nodeMap.get(edge.source)
    const target = nodeMap.get(edge.target)
    if (!source || !target) continue
    if (STRUCTURAL_IDS.has(source.id) || STRUCTURAL_IDS.has(target.id)) continue

    let score = 0
    const reasons: string[] = []

    // Signal 1: Cross-community edge (+3)
    if (source.community !== target.community) {
      score += 3
      reasons.push("跨社区连接")
    }

    // Signal 2: Cross-type edge (+2 for distant types)
    if (source.type !== target.type) {
      const distantPairs = new Set([
        "source-concept", "concept-source",
        "source-synthesis", "synthesis-source",
        "query-entity", "entity-query",
      ])
      const pair = `${source.type}-${target.type}`
      if (distantPairs.has(pair)) {
        score += 2
        reasons.push(`连接 ${source.type} 与 ${target.type}`)
      } else {
        score += 1
        reasons.push("不同类型")
      }
    }

    // Signal 3: Peripheral-to-hub coupling (+2)
    const sourceDeg = degreeMap.get(source.id) ?? 0
    const targetDeg = degreeMap.get(target.id) ?? 0
    const minDeg = Math.min(sourceDeg, targetDeg)
    const maxDeg = Math.max(sourceDeg, targetDeg)
    if (minDeg <= 2 && maxDeg >= maxDegree * 0.5) {
      score += 2
      reasons.push("边缘节点连接到枢纽")
    }

    // Signal 4: Low-weight edge between connected nodes (+1)
    if (edge.weight < 2 && edge.weight > 0) {
      score += 1
      reasons.push("弱连接但已存在")
    }

    if (score >= 3 && reasons.length > 0) {
      const key = [source.id, target.id].sort().join(":::")
      scored.push({ source, target, score, reasons, key })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Knowledge Gaps
// ---------------------------------------------------------------------------

/**
 * Detect knowledge gaps based on graph structure:
 * - Isolated nodes (degree ≤ 1)
 * - Sparse communities (cohesion < 0.15 with ≥ 3 nodes)
 * - Bridge nodes (high betweenness — connected to multiple communities)
 */
export function detectKnowledgeGaps(
  nodes: GraphNode[],
  edges: GraphEdge[],
  communities: CommunityInfo[],
  limit: number = 8,
): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = []
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // 1. Isolated nodes (degree ≤ 1, exclude overview/index)
  const isolatedNodes = nodes.filter(
    (n) => n.linkCount <= 1 && n.type !== "overview" && n.id !== "index" && n.id !== "log",
  )
  if (isolatedNodes.length > 0) {
    const topIsolated = isolatedNodes.slice(0, 5)
    gaps.push({
      type: "isolated-node",
      title: `${isolatedNodes.length} 个孤立页面`,
      description: topIsolated.map((n) => n.label).join(", ") +
        (isolatedNodes.length > 5 ? `，另有 ${isolatedNodes.length - 5} 个` : ""),
      nodeIds: isolatedNodes.map((n) => n.id),
      suggestion: "这些页面几乎没有连接。建议添加指向相关页面的 [[wikilinks]]，或通过研究扩展内容。",
    })
  }

  // 2. Sparse communities (low cohesion)
  for (const comm of communities) {
    if (comm.cohesion < 0.15 && comm.nodeCount >= 3) {
      gaps.push({
        type: "sparse-community",
        title: `稀疏聚类：${comm.topNodes[0] ?? `社区 ${comm.id}`}`,
        description: `${comm.nodeCount} 个页面，内聚度 ${comm.cohesion.toFixed(2)}，内部连接较弱。`,
        nodeIds: nodes.filter((n) => n.community === comm.id).map((n) => n.id),
        suggestion: "这个知识区域缺少内部交叉引用。建议在这些页面之间添加链接，或继续研究以补齐缺口。",
      })
    }
  }

  // 3. Bridge nodes (connected to multiple communities)
  const communityNeighbors = new Map<string, Set<number>>()
  for (const node of nodes) {
    communityNeighbors.set(node.id, new Set())
  }
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
    .sort((a, b) => {
      const aComms = communityNeighbors.get(a.id)?.size ?? 0
      const bComms = communityNeighbors.get(b.id)?.size ?? 0
      return bComms - aComms
    })
    .slice(0, 3)

  for (const bridge of bridgeNodes) {
    const commCount = communityNeighbors.get(bridge.id)?.size ?? 0
    gaps.push({
      type: "bridge-node",
      title: `关键桥接：${bridge.label}`,
      description: `连接了 ${commCount} 个不同知识聚类，是此 Wiki 中的重要节点。`,
      nodeIds: [bridge.id],
      suggestion: "此页面连接多个知识区域。建议保持内容完整；如果内容较薄，扩展它会增强整个 Wiki 的结构。",
    })
  }

  return gaps.slice(0, limit)
}
