import { describe, expect, it } from "vitest"
import { groupLintResultsForDisplay, shouldShowLintResults } from "./lint-view"
import type { LintItem } from "@/stores/lint-store"

function makeLintItem(
  page: string,
  severity: "warning" | "info",
  index: number,
): LintItem {
  return {
    id: `lint-${index}`,
    type: severity === "warning" ? "broken-link" : "orphan",
    severity,
    page,
    detail: `${page} detail`,
    createdAt: Date.now(),
  }
}

describe("groupLintResultsForDisplay", () => {
  it("groups warnings and infos separately", () => {
    const items: LintItem[] = [
      makeLintItem("info-a.md", "info", 0),
      makeLintItem("warning-b.md", "warning", 1),
      makeLintItem("info-c.md", "info", 2),
      makeLintItem("warning-d.md", "warning", 3),
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
  it("shows restored persisted lint items before a new run in the current view", () => {
    expect(shouldShowLintResults(false, 2)).toBe(true)
  })

  it("keeps the first-run empty prompt when no run has happened and nothing was restored", () => {
    expect(shouldShowLintResults(false, 0)).toBe(false)
  })

  it("shows the all-clear state after a run with no items", () => {
    expect(shouldShowLintResults(true, 0)).toBe(true)
  })
})
