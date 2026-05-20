import { describe, expect, it } from "vitest"
import {
  appendCatalogEntryContent,
  removeCatalogEntriesContent,
  sectionForCatalogPage,
} from "./catalog-index"
import { normalizeWikiRefKey } from "./wiki-cleanup"

describe("sectionForCatalogPage", () => {
  it("maps folders when page type is omitted", () => {
    expect(sectionForCatalogPage("entities/acme")).toBe("Entities")
  })

  it("prefers frontmatter page type when provided", () => {
    expect(sectionForCatalogPage("misc/page", "source")).toBe("Sources")
  })
})

describe("appendCatalogEntryContent", () => {
  it("inserts a line under the section", () => {
    const out = appendCatalogEntryContent(
      "# Wiki Index\n\n## Entities\n- [[entities/old]] — x\n",
      "Queries",
      "queries/q1",
      "Saved from chat",
      { displayTitle: "Q1" },
    )
    expect(out).toContain("## Queries")
    expect(out).toContain("[[queries/q1|Q1]]")
  })
})

describe("removeCatalogEntriesContent", () => {
  it("delegates to cleanIndexListing semantics", () => {
    const text = "## Entities\n- [[entities/gone]] — x\n- [[entities/kept]] — y\n"
    const keys = new Set([normalizeWikiRefKey("entities/gone")])
    const result = removeCatalogEntriesContent(text, keys)
    expect(result).not.toContain("entities/gone")
    expect(result).toContain("entities/kept")
  })
})
