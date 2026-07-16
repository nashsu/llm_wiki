import Graph from "graphology"
import forceAtlas2 from "graphology-layout-forceatlas2"

interface LayoutRequest {
  key: string
  nodes: Array<{ id: string; x: number; y: number }>
  edges: Array<{ source: string; target: string; weight: number }>
  iterations: number
  scalingRatio: number
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const { key, nodes, edges, iterations, scalingRatio } = event.data
  const graph = new Graph()

  for (const node of nodes) {
    graph.addNode(node.id, { x: node.x, y: node.y })
  }

  for (const edge of edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue
    const edgeKey = `${edge.source}->${edge.target}`
    if (graph.hasEdge(edgeKey) || graph.hasEdge(`${edge.target}->${edge.source}`)) continue
    graph.addEdgeWithKey(edgeKey, edge.source, edge.target, { weight: edge.weight })
  }

  const settings = forceAtlas2.inferSettings(graph)
  forceAtlas2.assign(graph, {
    iterations,
    settings: {
      ...settings,
      gravity: 1,
      scalingRatio,
      strongGravityMode: true,
      barnesHutOptimize: nodes.length > 50,
    },
  })

  const positions: Array<{ id: string; x: number; y: number }> = []
  graph.forEachNode((id, attrs) => {
    positions.push({ id, x: attrs.x, y: attrs.y })
  })

  self.postMessage({ key, positions })
}
