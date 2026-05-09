import { describe, expect, it } from "vitest"
import {
  getGraphNodeTypeColor,
  getGraphNodeTypeEntries,
  getGraphNodeTypeFromPath,
  getGraphNodeTypeLabel,
  isDefaultHiddenGraphNodeType,
} from "./graph-node-types"

describe("graph node types", () => {
  it("keeps query pages available but hidden by default", () => {
    expect(isDefaultHiddenGraphNodeType("query")).toBe(true)
    expect(isDefaultHiddenGraphNodeType(" Query ")).toBe(true)
    expect(isDefaultHiddenGraphNodeType("concept")).toBe(false)
  })

  it("builds graph type entries only from actually present node counts", () => {
    const entries = getGraphNodeTypeEntries({
      concept: 12,
      entity: 13,
      source: 5,
      comparison: 0,
      synthesis: 0,
      overview: 0,
    })

    expect(entries).toEqual([
      ["entity", "Entity", 13],
      ["concept", "Concept", 12],
      ["source", "Source", 5],
    ])
  })

  it("does not advertise absent optional graph types", () => {
    const entries = getGraphNodeTypeEntries({
      entity: 1,
      concept: 1,
    })

    expect(entries.map(([type]) => type)).not.toContain("synthesis")
    expect(entries.map(([type]) => type)).not.toContain("decision")
    expect(entries.map(([type]) => type)).not.toContain("query")
  })

  it("keeps query available when a real query node exists", () => {
    const entries = getGraphNodeTypeEntries({
      entity: 1,
      query: 2,
    })

    expect(entries).toEqual([
      ["entity", "Entity", 1],
      ["query", "Query", 2],
    ])
    expect(getGraphNodeTypeColor("query")).toBe("#4ade80")
  })

  it("keeps synthesis available when a real synthesis node exists", () => {
    const entries = getGraphNodeTypeEntries({
      entity: 1,
      synthesis: 2,
    })

    expect(entries).toEqual([
      ["entity", "Entity", 1],
      ["synthesis", "Synthesis", 2],
    ])
    expect(getGraphNodeTypeColor("synthesis")).toBe("#f87171")
  })

  it("infers graph node types from wiki folder paths", () => {
    expect(getGraphNodeTypeFromPath("/vault/wiki/comparisons/OpenClaw vs Hermes.md")).toBe("comparison")
    expect(getGraphNodeTypeFromPath("/vault/wiki/synthesis/안드레-카파시-스킬.md")).toBe("synthesis")
    expect(getGraphNodeTypeFromPath("/vault/wiki/sources/example.md")).toBe("source")
    expect(getGraphNodeTypeFromPath("/vault/wiki/index.md")).toBeNull()
  })

  it("keeps a readable fallback for unexpected existing node metadata", () => {
    expect(getGraphNodeTypeLabel("custom-note")).toBe("Custom Note")
    expect(getGraphNodeTypeColor("custom-note")).toBe("#94a3b8")
  })
})
