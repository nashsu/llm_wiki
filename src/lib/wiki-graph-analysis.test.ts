import { describe, expect, it } from "vitest"
import { detectCommunities } from "./wiki-graph-analysis"

describe("wiki graph community analysis", () => {
  it("computes cohesion from internal edges without counting cross-community edges", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({
      id,
      label: id.toUpperCase(),
      linkCount: id === "a" ? 3 : 1,
    }))
    const edges = [
      { source: "a", target: "b", weight: 1 },
      { source: "a", target: "c", weight: 1 },
      { source: "b", target: "c", weight: 1 },
    ]

    const result = detectCommunities(nodes, edges)

    expect(result.assignments.size).toBe(4)
    expect(result.communities.reduce((sum, community) => sum + community.nodeCount, 0)).toBe(4)
    expect(result.communities.every((community) => community.cohesion >= 0 && community.cohesion <= 1)).toBe(true)
    expect(result.communities.flatMap((community) => community.topNodes)).toContain("A")
  })

  it("computes scale-invariant meanIntraDegree per community", () => {
    const cliqueNodes = ["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4"]
    const nodes = cliqueNodes.map((id) => ({ id, label: id.toUpperCase(), linkCount: 3 }))
    const edges = [
      // Two 4-cliques (6 internal edges each) joined by a single bridge edge
      { source: "a1", target: "a2", weight: 1 },
      { source: "a1", target: "a3", weight: 1 },
      { source: "a1", target: "a4", weight: 1 },
      { source: "a2", target: "a3", weight: 1 },
      { source: "a2", target: "a4", weight: 1 },
      { source: "a3", target: "a4", weight: 1 },
      { source: "b1", target: "b2", weight: 1 },
      { source: "b1", target: "b3", weight: 1 },
      { source: "b1", target: "b4", weight: 1 },
      { source: "b2", target: "b3", weight: 1 },
      { source: "b2", target: "b4", weight: 1 },
      { source: "b3", target: "b4", weight: 1 },
      { source: "a1", target: "b1", weight: 1 },
    ]

    const result = detectCommunities(nodes, edges)

    expect(result.communities).toHaveLength(2)
    for (const community of result.communities) {
      expect(community.nodeCount).toBe(4)
      // 2 * 6 intra-community edges / 4 nodes
      expect(community.meanIntraDegree).toBe(3)
      expect(community.cohesion).toBe(1)
      expect(community.cohesion).toBeGreaterThanOrEqual(0)
      expect(community.cohesion).toBeLessThanOrEqual(1)
    }
  })

  it("conserves meanIntraDegree: nodeCount-weighted sum equals twice the intra-community edge count", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({
      id,
      label: id.toUpperCase(),
      linkCount: 1,
    }))
    const edges = [
      { source: "a", target: "b", weight: 1 },
      { source: "a", target: "c", weight: 1 },
      { source: "b", target: "c", weight: 1 },
    ]

    const result = detectCommunities(nodes, edges)

    const weightedSum = result.communities.reduce(
      (sum, community) => sum + community.nodeCount * community.meanIntraDegree,
      0,
    )
    // 3 internal edges, each contributing 2 degree endpoints; "d" sits alone at 0
    expect(weightedSum).toBe(6)
  })
})
