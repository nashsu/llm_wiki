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

  it("includes the stabilized lifecycle metadata contract", () => {
    const general = getTemplate("general")

    expect(general.schema).toContain("state: seed | draft | active | canonical | deprecated | archived")
    expect(general.schema).toContain("evidence_strength: weak | moderate | strong")
    expect(general.schema).toContain("review_status: ai_generated | ai_reviewed | human_reviewed | validated")
    expect(general.schema).toContain("knowledge_type: conceptual | operational | experimental | strategic")
    expect(general.schema).toContain("retention: ephemeral | reusable | promote | archive")
  })

  it("keeps index and log as compact operating documents", () => {
    const general = getTemplate("general")

    expect(general.schema).toContain("사람이 읽는 compact index")
    expect(general.schema).toContain("ephemeral/archive query")
    expect(general.schema).toContain(".llm-wiki/health.json")
    expect(general.schema).toContain("최근 30일 또는 최근 50개 항목")
    expect(general.schema).toContain(".llm-wiki/log-archive/YYYY-MM.md")
  })
})
