import { describe, expect, it } from "vitest"
import { detectKnowledgeGaps } from "./graph-insights"
import type { CommunityInfo, GraphEdge, GraphNode } from "./wiki-graph"

function makeNode(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    label: id,
    type: "concept",
    path: `${id}.md`,
    linkCount: 2,
    community: 0,
    ...overrides,
  }
}

function makeCommunity(overrides: Partial<CommunityInfo> = {}): CommunityInfo {
  return {
    id: 0,
    nodeCount: 10,
    cohesion: 0.016,
    meanIntraDegree: 8,
    topNodes: ["hub"],
    ...overrides,
  }
}

describe("detectKnowledgeGaps", () => {
  it("does not flag large well-linked communities whose density cohesion is below 0.15", () => {
    // 500 pages averaging 8 intra-cluster links: cohesion = 8 / 499 ≈ 0.016,
    // which the old fixed density threshold flagged on every large wiki.
    const communities = [makeCommunity({ nodeCount: 500, meanIntraDegree: 8, cohesion: 0.016 })]
    const nodes = Array.from({ length: 500 }, (_, i) => makeNode(`p${i}`))

    const gaps = detectKnowledgeGaps(nodes, [], communities)

    expect(gaps.filter((gap) => gap.type === "sparse-community")).toHaveLength(0)
  })

  it("flags genuinely sparse communities using mean intra-degree", () => {
    const communities = [makeCommunity({ nodeCount: 10, meanIntraDegree: 0.8 })]
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`p${i}`))

    const gaps = detectKnowledgeGaps(nodes, [], communities)
    const sparse = gaps.filter((gap) => gap.type === "sparse-community")

    expect(sparse).toHaveLength(1)
    expect(sparse[0]?.description).toContain("0.8")
  })

  it("does not flag communities exactly at the threshold (strictly less than)", () => {
    const communities = [makeCommunity({ nodeCount: 10, meanIntraDegree: 2 })]
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`p${i}`))

    const gaps = detectKnowledgeGaps(nodes, [], communities)

    expect(gaps.filter((gap) => gap.type === "sparse-community")).toHaveLength(0)
  })

  it("ignores sub-3-node communities even with zero internal links", () => {
    const communities = [makeCommunity({ nodeCount: 2, meanIntraDegree: 0 })]
    const nodes = Array.from({ length: 2 }, (_, i) => makeNode(`p${i}`))

    const gaps = detectKnowledgeGaps(nodes, [], communities)

    expect(gaps.filter((gap) => gap.type === "sparse-community")).toHaveLength(0)
  })

  it("still detects isolated and bridge nodes", () => {
    const nodes = [
      makeNode("lonely", { linkCount: 0 }),
      makeNode("bridge", { linkCount: 4 }),
      makeNode("c1", { community: 1 }),
      makeNode("c2", { community: 2 }),
      makeNode("c3", { community: 3 }),
    ]
    const edges: GraphEdge[] = [
      { source: "bridge", target: "c1", weight: 1 },
      { source: "bridge", target: "c2", weight: 1 },
      { source: "bridge", target: "c3", weight: 1 },
    ]
    const communities = [
      makeCommunity({ id: 0, nodeCount: 2, meanIntraDegree: 4, topNodes: ["bridge"] }),
      makeCommunity({ id: 1, nodeCount: 1, meanIntraDegree: 0, topNodes: ["c1"] }),
      makeCommunity({ id: 2, nodeCount: 1, meanIntraDegree: 0, topNodes: ["c2"] }),
      makeCommunity({ id: 3, nodeCount: 1, meanIntraDegree: 0, topNodes: ["c3"] }),
    ]

    const gaps = detectKnowledgeGaps(nodes, edges, communities)

    expect(gaps.some((gap) => gap.type === "isolated-node" && gap.nodeIds.includes("lonely"))).toBe(true)
    expect(gaps.some((gap) => gap.type === "bridge-node" && gap.nodeIds.includes("bridge"))).toBe(true)
  })
})
