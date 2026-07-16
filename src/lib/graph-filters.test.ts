import { describe, expect, it } from "vitest"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { applyGraphFilters, DEFAULT_GRAPH_FILTERS, hasActiveGraphFilters, isStructuralGraphNode, type GraphFilterState } from "./graph-filters"

const nodes: GraphNode[] = [
  { id: "index", label: "Index", type: "other", path: "/p/wiki/index.md", linkCount: 4, community: 0 },
  { id: "concept-a", label: "Concept A", type: "concept", path: "/p/wiki/concepts/a.md", linkCount: 2, community: 0 },
  { id: "entity-b", label: "Entity B", type: "entity", path: "/p/wiki/entities/b.md", linkCount: 3, community: 0 },
  { id: "source-c", label: "Source C", type: "source", path: "/p/wiki/sources/c.md", linkCount: 1, community: 1 },
  { id: "isolated", label: "Isolated", type: "concept", path: "/p/wiki/concepts/isolated.md", linkCount: 0, community: 2 },
]

const edges: GraphEdge[] = [
  { source: "index", target: "concept-a", weight: 1 },
  { source: "index", target: "entity-b", weight: 1 },
  { source: "concept-a", target: "entity-b", weight: 2 },
  { source: "source-c", target: "entity-b", weight: 3 },
]

function makeFilters(overrides: Partial<GraphFilterState> = {}): GraphFilterState {
  return {
    ...DEFAULT_GRAPH_FILTERS,
    hiddenTypes: new Set<string>(),
    hiddenNodeIds: new Set<string>(),
    ...overrides,
  }
}

describe("graph filters", () => {
  it("detects structural graph nodes by id, type, and path", () => {
    expect(isStructuralGraphNode(nodes[0])).toBe(true)
    expect(isStructuralGraphNode({ ...nodes[1], id: "overview", path: "/p/wiki/concepts/overview.md" })).toBe(true)
    expect(isStructuralGraphNode({ ...nodes[1], type: "overview" })).toBe(true)
    expect(isStructuralGraphNode(nodes[1])).toBe(false)
  })

  it("hides structural nodes and their connected edges by default", () => {
    const out = applyGraphFilters(nodes, edges, makeFilters())

    expect(out.nodes.map((n) => n.id)).not.toContain("index")
    expect(out.edges).toEqual([
      { source: "concept-a", target: "entity-b", weight: 2 },
      { source: "source-c", target: "entity-b", weight: 3 },
    ])
  })

  it("hides selected node types", () => {
    const out = applyGraphFilters(nodes, edges, makeFilters({
      hideStructural: false,
      hiddenTypes: new Set(["source"]),
    }))

    expect(out.nodes.map((n) => n.id)).not.toContain("source-c")
    expect(out.edges.some((e) => e.source === "source-c" || e.target === "source-c")).toBe(false)
  })

  it("hides manually selected nodes", () => {
    const out = applyGraphFilters(nodes, edges, makeFilters({
      hideStructural: false,
      hiddenNodeIds: new Set(["entity-b"]),
    }))

    expect(out.nodes.map((n) => n.id)).not.toContain("entity-b")
    expect(out.edges).toEqual([{ source: "index", target: "concept-a", weight: 1 }])
  })

  it("hides hub nodes above the max link threshold", () => {
    const out = applyGraphFilters(nodes, edges, makeFilters({
      hideStructural: false,
      maxLinks: 2,
    }))

    expect(out.nodes.map((n) => n.id)).not.toContain("index")
    expect(out.nodes.map((n) => n.id)).not.toContain("entity-b")
    expect(out.edges).toEqual([])
  })

  it("hides weakly connected nodes below the min link threshold", () => {
    const out = applyGraphFilters(nodes, edges, makeFilters({
      hideStructural: false,
      minLinks: 2,
    }))

    expect(out.nodes.map((n) => n.id)).not.toContain("source-c")
    expect(out.nodes.map((n) => n.id)).not.toContain("isolated")
    expect(out.nodes.map((n) => n.id)).toEqual(["index", "concept-a", "entity-b"])
    expect(out.edges).toEqual([
      { source: "index", target: "concept-a", weight: 1 },
      { source: "index", target: "entity-b", weight: 1 },
      { source: "concept-a", target: "entity-b", weight: 2 },
    ])
  })

  it("hides isolated nodes when requested", () => {
    const out = applyGraphFilters(nodes, edges, makeFilters({
      hideStructural: false,
      hideIsolated: true,
    }))

    expect(out.nodes.map((n) => n.id)).not.toContain("isolated")
  })

  it("reports whether filters are active", () => {
    expect(hasActiveGraphFilters(makeFilters({ hideStructural: false }))).toBe(false)
    expect(hasActiveGraphFilters(makeFilters())).toBe(true)
    expect(hasActiveGraphFilters(makeFilters({ hideStructural: false, hiddenNodeIds: new Set(["x"]) }))).toBe(true)
    expect(hasActiveGraphFilters(makeFilters({ hideStructural: false, minLinks: 2 }))).toBe(true)
  })
})
