import { describe, expect, it } from "vitest"
import {
  isGraphExcludedNode,
  isGraphInputExcludedPage,
  isGraphViewExcludedPage,
} from "./graph-exclusions"

function page(frontmatter: string): string {
  return ["---", frontmatter.trim(), "---", "", "Body"].join("\n")
}

describe("graph exclusions", () => {
  it("keeps query records available for maintenance readers but excludes them from graph view", () => {
    const content = page("type: query\ntitle: Research Question")
    const path = "/project/wiki/queries/research-question.md"

    expect(isGraphInputExcludedPage(path, "research-question.md", content)).toBe(false)
    expect(isGraphViewExcludedPage(path, "research-question.md", content)).toBe(true)
    expect(isGraphExcludedNode({ id: "research-question", path, type: "query" })).toBe(true)
  })

  it("excludes overview and index-like pages from all graph inputs", () => {
    expect(isGraphInputExcludedPage("/project/wiki/overview.md", "overview.md", page("type: overview"))).toBe(true)
    expect(isGraphViewExcludedPage("/project/wiki/index.md", "index.md", page("type: index"))).toBe(true)
    expect(isGraphExcludedNode({ id: "overview", path: "/project/wiki/overview.md", type: "overview" })).toBe(true)
  })
})
