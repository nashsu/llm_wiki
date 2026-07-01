import { describe, expect, it } from "vitest"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { applyGraphSearch } from "./graph-search"

const nodes: GraphNode[] = [
  { id: "vector-db", label: "Vector Database", type: "concept", path: "wiki/concepts/vector-db.md", linkCount: 2, community: 0 },
  { id: "hinton", label: "Geoffrey Hinton", type: "entity", path: "wiki/entities/hinton.md", linkCount: 1, community: 0 },
  { id: "raw-paper", label: "Source Paper", type: "source", path: "wiki/sources/source-paper.md", linkCount: 1, community: 1 },
]

const edges: GraphEdge[] = [
  { source: "vector-db", target: "hinton", weight: 1 },
  { source: "vector-db", target: "raw-paper", weight: 1 },
]

describe("applyGraphSearch", () => {
  it("returns the original graph for an empty query", () => {
    const out = applyGraphSearch(nodes, edges, " ")
    expect(out.nodes).toHaveLength(3)
    expect(out.edges).toHaveLength(2)
    expect(out.matchedNodeIds.size).toBe(0)
  })

  it("matches by label, id, type, and path", () => {
    expect(applyGraphSearch(nodes, edges, "vector").nodes.map((n) => n.id)).toEqual(["vector-db"])
    expect(applyGraphSearch(nodes, edges, "entity").nodes.map((n) => n.id)).toEqual(["hinton"])
    expect(applyGraphSearch(nodes, edges, "sources").nodes.map((n) => n.id)).toEqual(["raw-paper"])
  })

  it("keeps only edges between matched nodes", () => {
    const out = applyGraphSearch(nodes, edges, "wiki")
    expect(out.nodes).toHaveLength(3)
    expect(out.edges).toHaveLength(2)

    const sourceOnly = applyGraphSearch(nodes, edges, "paper")
    expect(sourceOnly.nodes.map((n) => n.id)).toEqual(["raw-paper"])
    expect(sourceOnly.edges).toHaveLength(0)
  })
})
