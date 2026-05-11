import { describe, expect, it } from "vitest"
import {
  inferKnowledgeTypeFromPageType,
  inferStateFromQuality,
  normalizeQueryRetention,
  normalizeWikiState,
  shouldExcludeFromDefaultKnowledgeSurface,
} from "./wiki-metadata"

describe("wiki metadata contract", () => {
  it("normalizes lifecycle and retention values", () => {
    expect(normalizeWikiState("active")).toBe("active")
    expect(normalizeQueryRetention("promote")).toBe("promote")
    expect(normalizeQueryRetention("canonical")).toBeUndefined()
  })

  it("infers safe defaults for legacy pages", () => {
    expect(inferStateFromQuality("reviewed")).toBe("active")
    expect(inferStateFromQuality("canonical")).toBe("canonical")
    expect(inferKnowledgeTypeFromPageType("query")).toBe("experimental")
    expect(inferKnowledgeTypeFromPageType("synthesis")).toBe("strategic")
  })

  it("excludes archived and default query pages from default knowledge surfaces", () => {
    expect(shouldExcludeFromDefaultKnowledgeSurface({
      path: "/p/wiki/concepts/old.md",
      type: "concept",
      state: "archived",
    })).toBe(true)
    expect(shouldExcludeFromDefaultKnowledgeSurface({
      path: "/p/wiki/queries/temp.md",
      type: "query",
    })).toBe(true)
    expect(shouldExcludeFromDefaultKnowledgeSurface({
      path: "/p/wiki/queries/reusable.md",
      type: "query",
      retention: "reusable",
    })).toBe(false)
  })
})
