import { describe, expect, it } from "vitest"
import type { LintItem } from "@/stores/lint-store"
import { groupLintResultsForDisplay, shouldShowLintResults } from "./lint-view"

let counter = 0

function lintItem(
  page: string,
  severity: LintItem["severity"],
): LintItem {
  return {
    id: `lint-${++counter}`,
    type: severity === "warning" ? "broken-link" : "orphan",
    severity,
    page,
    detail: `${page} detail`,
    createdAt: Date.now(),
  }
}

describe("groupLintResultsForDisplay", () => {
  it("separates warnings and infos correctly", () => {
    counter = 0
    const items = [
      lintItem("info-a.md", "info"),
      lintItem("warning-b.md", "warning"),
      lintItem("info-c.md", "info"),
      lintItem("warning-d.md", "warning"),
    ]

    const grouped = groupLintResultsForDisplay(items)

    expect(grouped.warnings.map((item) => item.page)).toEqual([
      "warning-b.md",
      "warning-d.md",
    ])
    expect(grouped.infos.map((item) => item.page)).toEqual([
      "info-a.md",
      "info-c.md",
    ])
  })
})

describe("shouldShowLintResults", () => {
  it("shows results when agent lint has populated items before a manual run", () => {
    expect(shouldShowLintResults(false, 1)).toBe(true)
  })

  it("keeps the initial hint when no lint has run and no items exist", () => {
    expect(shouldShowLintResults(false, 0)).toBe(false)
  })
})
