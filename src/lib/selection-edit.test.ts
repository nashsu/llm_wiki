import { describe, expect, it } from "vitest"
import { findUniqueTextSelection, normalizeSelectionReplacement } from "./selection-edit"

describe("normalizeSelectionReplacement", () => {
  it("removes one complete outer Markdown fence", () => {
    expect(normalizeSelectionReplacement("```markdown\nreplacement\n```"))
      .toBe("replacement")
  })

  it("preserves whitespace and incomplete or embedded fences", () => {
    expect(normalizeSelectionReplacement("  replacement  ")).toBe("  replacement  ")
    expect(normalizeSelectionReplacement("before\n```text\ninside\n```\nafter"))
      .toBe("before\n```text\ninside\n```\nafter")
  })
})

describe("findUniqueTextSelection", () => {
  it("maps a unique rendered selection to its exact source range", () => {
    expect(findUniqueTextSelection("before selected after", "selected")).toEqual({
      prefix: "before ",
      selectedText: "selected",
      suffix: " after",
    })
  })

  it("accepts browser-collapsed whitespace when the match is unique", () => {
    expect(findUniqueTextSelection("before\nselected   words\nafter", "selected words")?.selectedText)
      .toBe("selected   words")
  })

  it("rejects empty and ambiguous selections", () => {
    expect(findUniqueTextSelection("same and same", "same")).toBeNull()
    expect(findUniqueTextSelection("content", "  ")).toBeNull()
  })
})
