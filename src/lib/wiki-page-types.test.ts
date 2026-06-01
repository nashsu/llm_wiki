import { describe, expect, it } from "vitest"
import { GENERATION_WIKI_TYPES, inferWikiTypeFromPath, wikiTypeLabel } from "./wiki-page-types"

describe("inferWikiTypeFromPath", () => {
  it("recognizes core wiki directories", () => {
    expect(inferWikiTypeFromPath("/project/wiki/entities/ada-lovelace.md")).toBe("entity")
    expect(inferWikiTypeFromPath("/project/wiki/concepts/attention.md")).toBe("concept")
    expect(inferWikiTypeFromPath("/project/wiki/sources/paper.md")).toBe("source")
    expect(inferWikiTypeFromPath("/project/wiki/queries/open-question.md")).toBe("query")
    expect(inferWikiTypeFromPath("/project/wiki/comparisons/model-a-vs-b.md")).toBe("comparison")
    expect(inferWikiTypeFromPath("/project/wiki/synthesis/summary.md")).toBe("synthesis")
  })

  it("recognizes research-template wiki directories", () => {
    expect(inferWikiTypeFromPath("/project/wiki/findings/result.md")).toBe("finding")
    expect(inferWikiTypeFromPath("/project/wiki/thesis/main-claim.md")).toBe("thesis")
    expect(inferWikiTypeFromPath("/project/wiki/methodology/systematic-review.md")).toBe("methodology")
  })

  it("handles Windows separators and overview pages", () => {
    expect(inferWikiTypeFromPath("C:\\wiki\\findings\\result.md")).toBe("finding")
    expect(inferWikiTypeFromPath("/project/wiki/overview.md")).toBe("overview")
  })

  it("uses custom wiki subdirectories as dynamic types", () => {
    expect(inferWikiTypeFromPath("/project/wiki/people/ada-lovelace.md")).toBe("people")
    expect(inferWikiTypeFromPath("/project/wiki/technologies/vector-db.md")).toBe("technologies")
  })
})

describe("wikiTypeLabel", () => {
  it("uses readable singular labels for research-template types", () => {
    expect(wikiTypeLabel("finding")).toBe("Finding")
    expect(wikiTypeLabel("thesis")).toBe("Thesis")
    expect(wikiTypeLabel("methodology")).toBe("Methodology")
    expect(wikiTypeLabel("custom-topic")).toBe("Custom Topic")
  })

  it("keeps generation prompt type list aligned with research-template types", () => {
    expect(GENERATION_WIKI_TYPES).toContain("finding")
    expect(GENERATION_WIKI_TYPES).toContain("thesis")
    expect(GENERATION_WIKI_TYPES).toContain("methodology")
  })
})
