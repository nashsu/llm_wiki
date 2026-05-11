import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const graphViewSource = readFileSync(
  resolve(process.cwd(), "src/components/graph/graph-view.tsx"),
  "utf8",
)

describe("GraphView Kevin-approved visual contract", () => {
  it("keeps the original graph geometry, labels, and force layout settings", () => {
    expect(graphViewSource).toContain("const BASE_NODE_SIZE = 8")
    expect(graphViewSource).toContain("const MAX_NODE_SIZE = 28")
    expect(graphViewSource).toContain("renderEdgeLabels: true")
    expect(graphViewSource).toContain("labelSize: 13")
    expect(graphViewSource).toContain("labelDensity: 0.4")
    expect(graphViewSource).toContain("labelRenderedSizeThreshold: 6")
    expect(graphViewSource).toContain("iterations: 150")
    expect(graphViewSource).toContain("gravity: 1")
    expect(graphViewSource).toContain("scalingRatio: 2")
  })

  it("keeps the original relation-aware edge colors and thickness formula", () => {
    expect(graphViewSource).toContain("rgba(249,115,22,${0.45 + normalizedWeight * 0.45})")
    expect(graphViewSource).toContain("rgba(37,99,235,${0.4 + normalizedWeight * 0.45})")
    expect(graphViewSource).toContain("rgba(100,116,139,${0.25 + normalizedWeight * 0.55})")
    expect(graphViewSource).toContain("const relationBonus = hasSource ? 1.2 : hasRelated ? 0.7 : 0")
    expect(graphViewSource).toContain("size: 0.5 + normalizedWeight * 2.4 + relationBonus")
  })

  it("keeps useful controls while rejecting the reverted Obsidian-style graph patch", () => {
    expect(graphViewSource).toContain("GRAPH_MODE_OPTIONS")
    expect(graphViewSource).toContain('{colorMode === "type" ? "Node Types" : "Communities"}')
    expect(graphViewSource).toContain("Hide structural maps / indexes")

    expect(graphViewSource).not.toContain("type NodeDragState")
    expect(graphViewSource).not.toContain("DRAG_NEIGHBOR_PULL")
    expect(graphViewSource).not.toContain("drawReadableNodeHover")
    expect(graphViewSource).not.toContain("mousemovebody")
    expect(graphViewSource).not.toContain("downNode")
  })
})
