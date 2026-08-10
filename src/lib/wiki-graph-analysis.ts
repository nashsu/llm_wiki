import Graph from "graphology"
import louvain from "graphology-communities-louvain"
import type { CommunityInfo, GraphEdge } from "./wiki-graph"

/** Run Louvain community detection and compute cohesion per community. */
export function detectCommunities(
  nodes: { id: string; label: string; linkCount: number }[],
  edges: GraphEdge[],
): { assignments: Map<string, number>; communities: CommunityInfo[] } {
  if (nodes.length === 0) {
    return { assignments: new Map(), communities: [] }
  }

  const graph = new Graph({ type: "undirected" })
  for (const node of nodes) graph.addNode(node.id)
  for (const edge of edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue
    const key = `${edge.source}->${edge.target}`
    if (!graph.hasEdge(key) && !graph.hasEdge(`${edge.target}->${edge.source}`)) {
      graph.addEdgeWithKey(key, edge.source, edge.target, { weight: edge.weight })
    }
  }

  const communityMap: Record<string, number> = louvain(graph, { resolution: 1 })
  const assignments = new Map(
    Object.entries(communityMap).map(([nodeId, communityId]) => [nodeId, communityId]),
  )
  const groups = new Map<number, string[]>()
  for (const [nodeId, communityId] of assignments) {
    const members = groups.get(communityId) ?? []
    members.push(nodeId)
    groups.set(communityId, members)
  }

  // Counting actual internal edges is O(E); comparing every member pair is
  // O(N^2) and dominates large knowledge graphs.
  const intraEdgesByCommunity = new Map<number, number>()
  for (const edge of edges) {
    const sourceCommunity = assignments.get(edge.source)
    if (sourceCommunity !== undefined && sourceCommunity === assignments.get(edge.target)) {
      intraEdgesByCommunity.set(
        sourceCommunity,
        (intraEdgesByCommunity.get(sourceCommunity) ?? 0) + 1,
      )
    }
  }

  const nodeInfo = new Map(
    nodes.map((node) => [node.id, { label: node.label, linkCount: node.linkCount }]),
  )
  const communities: CommunityInfo[] = []
  for (const [communityId, memberIds] of groups) {
    const nodeCount = memberIds.length
    const possibleEdges = nodeCount > 1 ? (nodeCount * (nodeCount - 1)) / 2 : 1
    const cohesion = (intraEdgesByCommunity.get(communityId) ?? 0) / possibleEdges
    const topNodes = [...memberIds]
      .sort(
        (left, right) =>
          (nodeInfo.get(right)?.linkCount ?? 0) -
          (nodeInfo.get(left)?.linkCount ?? 0),
      )
      .slice(0, 5)
      .map((id) => nodeInfo.get(id)?.label ?? id)
    communities.push({ id: communityId, nodeCount, cohesion, topNodes })
  }

  communities.sort((left, right) => right.nodeCount - left.nodeCount)
  const idRemap = new Map<number, number>()
  communities.forEach((community, index) => {
    idRemap.set(community.id, index)
    community.id = index
  })
  for (const [nodeId, oldId] of assignments) {
    assignments.set(nodeId, idRemap.get(oldId) ?? 0)
  }
  return { assignments, communities }
}
