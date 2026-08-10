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
})
