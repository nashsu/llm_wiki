import { describe, expect, it } from "vitest"
import {
  parseWikiSchemaRouting,
  validateWikiPageRouting,
} from "./wiki-schema"
import { getTemplate } from "./templates"

const SCHEMA = `# Wiki Schema

## Page Types

| Type | Directory | Purpose |
| ---- | --------- | ------- |
| source | wiki/sources/ | Source summaries |
| concept | wiki/concepts/ | Ideas |
| method | wiki/methods/ | Methods |
| overview | wiki/ | Top-level overview |
`

describe("parseWikiSchemaRouting", () => {
  it("extracts type directories from the Page Types table", () => {
    const routing = parseWikiSchemaRouting(SCHEMA)

    expect(routing.typeDirs).toEqual({
      source: "wiki/sources",
      concept: "wiki/concepts",
      method: "wiki/methods",
      overview: "wiki",
    })
  })

  it("ignores unrelated markdown tables outside the Page Types section", () => {
    const routing = parseWikiSchemaRouting([
      "# Wiki Schema",
      "",
      "| Name | Directory |",
      "| ---- | --------- |",
      "| draft | wiki/drafts/ |",
      "",
      "## Page Types",
      "",
      "| Type | Directory | Purpose |",
      "| ---- | --------- | ------- |",
      "| concept | wiki/concepts/ | Ideas |",
      "",
      "## Examples",
      "",
      "| Type | Directory |",
      "| ---- | --------- |",
      "| person | wiki/people/ |",
    ].join("\n"))

    expect(routing.typeDirs).toEqual({
      concept: "wiki/concepts",
    })
  })
})

describe("validateWikiPageRouting", () => {
  const routing = parseWikiSchemaRouting(SCHEMA)

  it("reports a mismatch between frontmatter type and schema directory", () => {
    const issue = validateWikiPageRouting(
      "wiki/concepts/flash-attention.md",
      [
        "---",
        "type: source",
        "title: Flash Attention",
        "---",
        "",
        "# Flash Attention",
      ].join("\n"),
      routing,
    )

    expect(issue?.message).toContain('type "source" must be under "wiki/sources/"')
  })

  it("allows custom schema types routed by the table", () => {
    expect(
      validateWikiPageRouting(
        "wiki/methods/retrieval.md",
        [
          "---",
          "type: method",
          "title: Retrieval",
          "---",
          "",
          "# Retrieval",
        ].join("\n"),
        routing,
      ),
    ).toBeNull()
  })

  it("does not enforce pages without a parseable type", () => {
    expect(validateWikiPageRouting("wiki/concepts/no-type.md", "# No Type", routing)).toBeNull()
  })
})

describe("Research Profile v2 routing", () => {
  const routing = parseWikiSchemaRouting(getTemplate("research").schema)
  const repositoryPage = [
    "---",
    "type: repository",
    "title: Nashsu / llm_wiki",
    "---",
    "",
    "# Nashsu / llm_wiki",
  ].join("\n")

  it("routes repository pages to wiki/repositories", () => {
    expect(routing.typeDirs.repository).toBe("wiki/repositories")
    expect(
      validateWikiPageRouting(
        "wiki/repositories/nashsu-llm-wiki.md",
        repositoryPage,
        routing,
      ),
    ).toBeNull()
  })

  it("rejects repository pages written outside their schema directory", () => {
    expect(
      validateWikiPageRouting(
        "wiki/sources/nashsu-llm-wiki.md",
        repositoryPage,
        routing,
      )?.message,
    ).toContain('type "repository" must be under "wiki/repositories/"')
  })
})
