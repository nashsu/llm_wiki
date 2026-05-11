import { describe, expect, it } from "vitest"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { applyGraphFilters, createGraphFiltersForMode, DEFAULT_GRAPH_FILTERS, hasActiveGraphFilters, isStructuralGraphNode, type GraphFilterState } from "./graph-filters"

const nodes: GraphNode[] = [
  makeNode({ id: "index", label: "Index", type: "other", path: "/p/wiki/index.md", linkCount: 4, community: 0 }),
  makeNode({ id: "concept-a", label: "Concept A", type: "concept", path: "/p/wiki/concepts/a.md", linkCount: 2, community: 0 }),
  makeNode({ id: "entity-b", label: "Entity B", type: "entity", path: "/p/wiki/entities/b.md", sources: ["paper.md"], quality: "reviewed", coverage: "high", needsUpgrade: false, sourceCount: 1, linkCount: 3, community: 0 }),
  makeNode({ id: "source-c", label: "Source C", type: "source", path: "/p/wiki/sources/c.md", quality: "reviewed", coverage: "high", needsUpgrade: false, sourceCount: 1, linkCount: 1, community: 1 }),
  makeNode({ id: "query-d", label: "Query D", type: "query", path: "/p/wiki/queries/d.md", linkCount: 1, community: 1 }),
  makeNode({ id: "isolated", label: "Isolated", type: "concept", path: "/p/wiki/concepts/isolated.md", linkCount: 0, community: 2 }),
]

const edges: GraphEdge[] = [
  { source: "index", target: "concept-a", types: ["wikilink"], weight: 1 },
  { source: "index", target: "entity-b", types: ["wikilink"], weight: 1 },
  { source: "concept-a", target: "entity-b", types: ["related"], weight: 2 },
  { source: "source-c", target: "entity-b", types: ["source"], weight: 3 },
  { source: "query-d", target: "concept-a", types: ["wikilink"], weight: 1 },
]

function makeNode(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "label" | "type" | "path" | "linkCount" | "community">): GraphNode {
  return {
    related: [],
    sources: [],
    relationships: [],
    unresolvedRelated: [],
    unresolvedSources: [],
    ...overrides,
  }
}

function makeFilters(overrides: Partial<GraphFilterState> = {}): GraphFilterState {
  const mode = overrides.mode ?? "knowledge"
  const base = createGraphFiltersForMode(mode)
  return {
    ...base,
    hiddenTypes: new Set(mode === "knowledge" ? DEFAULT_GRAPH_FILTERS.hiddenTypes : base.hiddenTypes),
    hiddenNodeIds: new Set<string>(),
    ...overrides,
  }
}

describe("graph filters", () => {
  it("detects structural graph nodes by id, type, and path", () => {
    expect(isStructuralGraphNode(nodes[0])).toBe(true)
    expect(isStructuralGraphNode({ ...nodes[1], id: "overview", path: "/p/wiki/concepts/overview.md" })).toBe(true)
    expect(isStructuralGraphNode({ ...nodes[1], type: "overview" })).toBe(true)
    expect(isStructuralGraphNode({ ...nodes[1], id: "codex-chats", type: "source-map", path: "/p/wiki/sources/10_maps/codex-chats.md" })).toBe(true)
    expect(isStructuralGraphNode({ ...nodes[1], id: "raw-registry", type: "registry", path: "/p/wiki/sources/raw-registry.md" })).toBe(true)
    expect(isStructuralGraphNode({ ...nodes[1], id: "old-page", path: "/p/wiki/_retired/old-page.md" })).toBe(true)
    expect(isStructuralGraphNode({ ...nodes[1], id: "codex-note", path: "/p/wiki/codex-memory/session.md" })).toBe(true)
    expect(isStructuralGraphNode(nodes[1])).toBe(false)
  })

  it("hides structural and source nodes in knowledge mode by default", () => {
    const out = applyGraphFilters(nodes, edges, makeFilters())

    expect(out.nodes.map((n) => n.id)).not.toContain("index")
    expect(out.nodes.map((n) => n.id)).not.toContain("source-c")
    expect(out.edges).toEqual([
      { source: "concept-a", target: "entity-b", types: ["related"], weight: 2 },
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
    expect(out.edges).toEqual([{ source: "index", target: "concept-a", types: ["wikilink"], weight: 1 }])
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
  })

  it("hides query nodes in knowledge mode but keeps evidence source edges", () => {
    const out = applyGraphFilters(nodes, edges, makeFilters({ mode: "evidence" }))

    expect(out.nodes.map((n) => n.id)).not.toContain("query-d")
    expect(out.nodes.map((n) => n.id)).toContain("source-c")
    expect(out.edges).toContainEqual({ source: "source-c", target: "entity-b", types: ["source"], weight: 3 })
  })

  it("focuses maintenance mode on isolated, unresolved, source-less, or low-quality nodes", () => {
    const broken = makeNode({
      id: "broken",
      label: "Broken",
      type: "concept",
      path: "/p/wiki/concepts/broken.md",
      unresolvedRelated: ["missing"],
      sources: ["paper.md"],
      linkCount: 2,
      community: 3,
    })
    const weakSource = makeNode({
      id: "weak-source",
      label: "Weak Source",
      type: "source",
      path: "/p/wiki/sources/weak.md",
      quality: "draft",
      coverage: "low",
      needsUpgrade: true,
      sourceCount: 1,
      linkCount: 2,
      community: 3,
    })
    const out = applyGraphFilters(
      [...nodes, broken, weakSource],
      edges,
      makeFilters({ mode: "maintenance" }),
    )

    expect(out.nodes.map((n) => n.id)).toContain("concept-a")
    expect(out.nodes.map((n) => n.id)).toContain("isolated")
    expect(out.nodes.map((n) => n.id)).toContain("broken")
    expect(out.nodes.map((n) => n.id)).toContain("weak-source")
    expect(out.nodes.map((n) => n.id)).not.toContain("entity-b")
    expect(out.nodes.map((n) => n.id)).not.toContain("source-c")
    expect(out.nodes.map((n) => n.id)).not.toContain("query-d")
  })
})
