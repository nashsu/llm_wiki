import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"

export interface GraphSearchResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  matchedNodeIds: Set<string>
}

export function applyGraphSearch(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  query: string,
): GraphSearchResult {
  const tokens = query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (tokens.length === 0) {
    return { nodes: [...nodes], edges: [...edges], matchedNodeIds: new Set() }
  }

  const matchedNodeIds = new Set<string>()
  const matchedNodes = nodes.filter((node) => {
    const haystack = [
      node.label,
      node.id,
      node.type,
      node.path,
    ].join(" ").toLowerCase()
    const matched = tokens.every((token) => haystack.includes(token))
    if (matched) matchedNodeIds.add(node.id)
    return matched
  })

  const visibleNodeIds = new Set(matchedNodes.map((node) => node.id))
  const visibleEdges = edges.filter(
    (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  )

  return { nodes: matchedNodes, edges: visibleEdges, matchedNodeIds }
}
