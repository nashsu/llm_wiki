import { describe, expect, it } from "vitest"
import { getTemplate, templates } from "./templates"

describe("wiki templates", () => {
  it("does not expose the removed Codexian Memory template", () => {
    expect(templates.map((t) => t.id)).not.toContain("codexian-memory")
    expect(() => getTemplate("codexian-memory")).toThrow(/Unknown template id/)
  })

  it("keeps the standard templates available", () => {
    expect(templates.map((t) => t.id)).toEqual([
      "research",
      "reading",
      "personal",
      "business",
      "general",
    ])
  })

  it("does not create new decision directories while preserving legacy guidance", () => {
    const business = getTemplate("business")

    expect(business.extraDirs).not.toContain("wiki/decisions")
    expect(business.schema).not.toContain("| decision |")
    expect(business.schema).not.toContain("type: entity | concept | source | query | comparison | synthesis | decision | overview")
    expect(business.schema).toContain("type: decision")
    expect(business.schema).toContain("wiki/decisions/")
    expect(business.purpose).toContain("wiki/queries/")
  })
})
