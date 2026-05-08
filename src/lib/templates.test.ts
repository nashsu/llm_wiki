import { describe, expect, it } from "vitest"
import { getTemplate, templates } from "./templates"

describe("Codexian Memory template", () => {
  it("is available as the first template", () => {
    expect(templates[0].id).toBe("codexian-memory")
    expect(getTemplate("codexian-memory").name).toBe("Codexian Memory")
  })

  it("declares memory folders, types, and boot context seed file", () => {
    const template = getTemplate("codexian-memory")

    expect(template.extraDirs).toEqual(expect.arrayContaining([
      "wiki/profile",
      "wiki/decisions",
      "wiki/workflows",
      "wiki/sessions",
    ]))
    expect(template.schema).toContain("| profile | wiki/profile/")
    expect(template.schema).toContain("| decision | wiki/decisions/")
    expect(template.schema).toContain("| workflow | wiki/workflows/")
    expect(template.schema).toContain("| session | wiki/sessions/")
    expect(template.extraFiles?.["wiki/synthesis/codex-boot-context.md"]).toContain("type: synthesis")
  })
})
