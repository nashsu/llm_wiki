import { describe, expect, it } from "vitest"
import { buildWordDiff, findUniqueTextSelection, normalizeEditableMarkdown, normalizeSelectionReplacement } from "./selection-edit"

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

describe("normalizeEditableMarkdown", () => {
  it("normalizes CRLF and lone CR without changing existing LF", () => {
    expect(normalizeEditableMarkdown("first\r\nsecond\rthird\nfourth"))
      .toBe("first\nsecond\nthird\nfourth")
  })
})

describe("buildWordDiff", () => {
  it("marks inserted and deleted words while preserving equal text", () => {
    const parts = buildWordDiff("The old text", "The new text")
    expect(parts.some((part) => part.type === "delete" && part.value.includes("old"))).toBe(true)
    expect(parts.some((part) => part.type === "insert" && part.value.includes("new"))).toBe(true)
    expect(parts.filter((part) => part.type === "equal").map((part) => part.value).join(""))
      .toContain("The ")
  })

  it("keeps unchanged CJK characters instead of replacing the whole sentence", () => {
    const parts = buildWordDiff("知识图谱检索", "知识图谱搜索")
    expect(parts.some((part) => part.type === "equal" && part.value.includes("知识图谱"))).toBe(true)
    expect(parts.some((part) => part.type === "delete" && part.value === "检")).toBe(true)
    expect(parts.some((part) => part.type === "insert" && part.value === "搜")).toBe(true)
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

  it("returns null when the rendered text does not exist in the source", () => {
    expect(findUniqueTextSelection("existing content", "missing content")).toBeNull()
  })
})
