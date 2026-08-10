import type { GraphEdge } from "./wiki-graph"
import { detectCommunities } from "./wiki-graph-analysis"

interface AnalysisRequest {
  nodes: { id: string; label: string; linkCount: number }[]
  edges: GraphEdge[]
}

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const result = detectCommunities(event.data.nodes, event.data.edges)
  self.postMessage({
    assignments: Array.from(result.assignments.entries()),
    communities: result.communities,
  })
}
