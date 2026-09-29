import { describe, expect, it } from "vitest"
import { detectKnowledgeGaps, researchSeedForKnowledgeGap } from "./graph-insights"
import type { CommunityInfo, GraphNode } from "./wiki-graph"

function nodes(count: number): GraphNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`,
    label: `Node ${index}`,
    type: "concept",
    path: `/wiki/node-${index}.md`,
    linkCount: 4,
    community: 0,
  }))
}

function community(overrides: Partial<CommunityInfo>): CommunityInfo {
  return {
    id: 0,
    nodeCount: 100,
    cohesion: 0.02,
    meanIntraDegree: 2,
    topNodes: ["Node 0"],
    ...overrides,
  }
}

describe("detectKnowledgeGaps sparse communities", () => {
  it("does not flag a large community whose mean internal degree is healthy", () => {
    const gaps = detectKnowledgeGaps(nodes(100), [], [community({})])
    expect(gaps.some((gap) => gap.type === "sparse-community")).toBe(false)
  })

  it("flags a community averaging fewer than two internal links per page", () => {
    const gaps = detectKnowledgeGaps(nodes(20), [], [community({
      nodeCount: 20,
      meanIntraDegree: 1.4,
    })])
    expect(gaps.find((gap) => gap.type === "sparse-community")?.description)
      .toContain("1.4 internal links per page")
  })
})

describe("researchSeedForKnowledgeGap", () => {
  it("uses one actual page label for an isolated-page group", () => {
    const graphNodes = nodes(3)
    const seed = researchSeedForKnowledgeGap({
      type: "isolated-node",
      title: "3 isolated pages",
      description: "Node 0, Node 1, Node 2",
      nodeIds: graphNodes.map((node) => node.id),
      suggestion: "Research them",
    }, graphNodes)
    expect(seed).toEqual({ term: "Node 0", context: "" })
  })

  it("prioritizes the most connected sparse-cluster node without UI metadata", () => {
    const graphNodes = nodes(3).map((node, index) => ({
      ...node,
      linkCount: [1, 8, 4][index],
    }))
    const seed = researchSeedForKnowledgeGap({
      type: "sparse-community",
      title: "Sparse cluster: generated label",
      description: "3 pages average 1.0 internal links per page.",
      nodeIds: graphNodes.map((node) => node.id),
      suggestion: "Research it",
    }, graphNodes)
    expect(seed.term).toBe("Node 1")
    expect(seed.context).toBe("Node 2 Node 0")
    expect(`${seed.term} ${seed.context}`).not.toContain("Sparse cluster")
    expect(`${seed.term} ${seed.context}`).not.toContain("internal links")
  })
})
