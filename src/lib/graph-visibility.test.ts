import { describe, expect, it } from "vitest"
import { shouldHideEdgeByNodeTypes, shouldHideNodeType } from "./graph-visibility"

describe("graph visibility helpers", () => {
  it("hides nodes whose type is selected in the legend", () => {
    const hidden = new Set(["source", "query"])

    expect(shouldHideNodeType("source", hidden)).toBe(true)
    expect(shouldHideNodeType("entity", hidden)).toBe(false)
  })

  it("does not hide nodes with missing type metadata", () => {
    expect(shouldHideNodeType(undefined, new Set(["source"]))).toBe(false)
  })

  it("hides edges connected to any hidden node type", () => {
    const hidden = new Set(["source"])

    expect(shouldHideEdgeByNodeTypes("source", "entity", hidden)).toBe(true)
    expect(shouldHideEdgeByNodeTypes("entity", "source", hidden)).toBe(true)
    expect(shouldHideEdgeByNodeTypes("entity", "concept", hidden)).toBe(false)
  })

  it("keeps edges visible when endpoint types are unknown", () => {
    const hidden = new Set(["source"])

    expect(shouldHideEdgeByNodeTypes(undefined, "entity", hidden)).toBe(false)
    expect(shouldHideEdgeByNodeTypes(undefined, undefined, hidden)).toBe(false)
  })
})
