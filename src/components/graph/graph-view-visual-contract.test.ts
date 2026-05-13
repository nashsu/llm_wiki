import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const graphViewSource = readFileSync(
  resolve(process.cwd(), "src/components/graph/graph-view.tsx"),
  "utf8",
)
const graphVisualsSource = readFileSync(
  resolve(process.cwd(), "src/components/graph/graph-visuals.ts"),
  "utf8",
)
const graphVisualContractSource = `${graphViewSource}\n${graphVisualsSource}`

describe("GraphView Kevin-approved visual contract", () => {
  it("keeps the original graph geometry, labels, and force layout settings", () => {
    expect(graphVisualContractSource).toContain("const BASE_NODE_SIZE = 8")
    expect(graphVisualContractSource).toContain("const MAX_NODE_SIZE = 28")
    expect(graphVisualContractSource).toContain("renderEdgeLabels: true")
    expect(graphVisualContractSource).toContain("labelSize: 13")
    expect(graphVisualContractSource).toContain("labelDensity: 0.4")
    expect(graphVisualContractSource).toContain("labelRenderedSizeThreshold: 6")
    expect(graphVisualContractSource).toContain("iterations: 150")
    expect(graphVisualContractSource).toContain("gravity: 1")
    expect(graphVisualContractSource).toContain("scalingRatio: 2")
  })

  it("keeps the original relation-aware edge colors and thickness formula", () => {
    expect(graphVisualContractSource).toContain("rgba(249,115,22,${0.45 + normalizedWeight * 0.45})")
    expect(graphVisualContractSource).toContain("rgba(37,99,235,${0.4 + normalizedWeight * 0.45})")
    expect(graphVisualContractSource).toContain("rgba(100,116,139,${0.25 + normalizedWeight * 0.55})")
    expect(graphVisualContractSource).toContain("const relationBonus = hasSource ? 1.2 : hasRelated ? 0.7 : 0")
    expect(graphVisualContractSource).toContain("size: 0.5 + normalizedWeight * 2.4 + relationBonus")
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
