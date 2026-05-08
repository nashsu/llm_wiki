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
})
