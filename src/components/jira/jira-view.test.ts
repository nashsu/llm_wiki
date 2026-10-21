import { describe, expect, it } from "vitest"
import type { JiraIssueSummary } from "@/types/jira"
import {
  exportButtonLabelKey,
  jiraCardMetaLine,
  shouldShowSweepNotice,
  splitHighlight,
} from "./jira-view"

function issue(fields: JiraIssueSummary["fields"]): JiraIssueSummary {
  return { id: "1", key: "AERDM-1234", fields }
}

describe("jiraCardMetaLine", () => {
  it("joins the project, type, status and assignee", () => {
    expect(
      jiraCardMetaLine(
        issue({
          project: { key: "AERDM" },
          issuetype: { name: "缺陷" },
          status: { name: "进行中" },
          assignee: { displayName: "张三" },
        }),
      ),
    ).toBe("AERDM · 缺陷 · 进行中 · 张三")
  })

  it("drops whatever the instance left out rather than leaving a gap", () => {
    expect(jiraCardMetaLine(issue({ project: { key: "AERDM" }, status: { name: "待办" } }))).toBe(
      "AERDM · 待办",
    )
  })

  it("treats an unassigned issue as having no assignee", () => {
    expect(jiraCardMetaLine(issue({ assignee: null, status: { name: "待办" } }))).toBe("待办")
  })

  it("returns an empty line for an issue with nothing to show", () => {
    expect(jiraCardMetaLine(issue({}))).toBe("")
  })
})

describe("exportButtonLabelKey", () => {
  it("offers a plain export before anything has happened", () => {
    expect(exportButtonLabelKey(undefined)).toBe("jira.export.export")
  })

  it("shows progress while exporting", () => {
    expect(exportButtonLabelKey({ phase: "exporting", completed: 1, total: 3 })).toBe(
      "jira.export.exporting",
    )
  })

  it("offers a re-export once the file is on disk", () => {
    expect(exportButtonLabelKey({ phase: "done", completed: 0, total: 0 })).toBe(
      "jira.export.reExport",
    )
  })

  it("offers a retry after a failure", () => {
    expect(exportButtonLabelKey({ phase: "error", completed: 0, total: 0, error: "boom" })).toBe(
      "jira.export.retry",
    )
  })
})

describe("shouldShowSweepNotice", () => {
  it("tells the user how far back the sweep looked", () => {
    expect(shouldShowSweepNotice({ swept: true, query: "BOX", scanned: 200 })).toBe(true)
  })

  it("says nothing when the sweep never ran", () => {
    expect(shouldShowSweepNotice({ swept: false, query: "BOX", scanned: 200 })).toBe(false)
  })

  it("says nothing when the sweep returned nothing to describe", () => {
    expect(shouldShowSweepNotice({ swept: true, query: "BOX", scanned: 0 })).toBe(false)
  })

  it("says nothing for a browse query, which has no sweep behind it", () => {
    expect(shouldShowSweepNotice({ swept: true, query: "", scanned: 200 })).toBe(false)
    expect(shouldShowSweepNotice({ swept: true, query: "*()", scanned: 200 })).toBe(false)
  })
})

describe("splitHighlight", () => {
  it("returns the whole text unmarked when there is nothing to highlight", () => {
    expect(splitHighlight("DAB_box 收音", [], false)).toEqual([
      { value: "DAB_box 收音", match: false },
    ])
  })

  it("returns nothing at all for empty text", () => {
    expect(splitHighlight("", [], false)).toEqual([])
    expect(splitHighlight("", ["box"], false)).toEqual([])
  })

  it("marks the matching slice and keeps the rest intact", () => {
    expect(splitHighlight("DAB_box 收音", ["box"], false)).toEqual([
      { value: "DAB_", match: false },
      { value: "box", match: true },
      { value: " 收音", match: false },
    ])
  })

  it("matches case-insensitively when the toggle is off", () => {
    expect(splitHighlight("DAB_box", ["box"], false)).toEqual([
      { value: "DAB_", match: false },
      { value: "box", match: true },
    ])
  })

  it("stops matching when the toggle is on", () => {
    expect(splitHighlight("DAB_box", ["BOX"], true)).toEqual([{ value: "DAB_box", match: false }])
  })

  it("still matches the exact case when the toggle is on", () => {
    expect(splitHighlight("DAB_box", ["box"], true)).toEqual([
      { value: "DAB_", match: false },
      { value: "box", match: true },
    ])
  })

  it("takes the longest token first so a short one cannot split it", () => {
    expect(splitHighlight("dab_box", ["dab_box", "box"], false)).toEqual([
      { value: "dab_box", match: true },
    ])
  })

  it("treats regex characters in the query as literal text", () => {
    // Unescaped, `a+b` would match `ab` and `aab`; it must not.
    expect(splitHighlight("aab", ["a+b"], false)).toEqual([{ value: "aab", match: false }])
    expect(splitHighlight("a+b", ["a+b"], false)).toEqual([{ value: "a+b", match: true }])
  })

  it("marks every occurrence, including adjacent ones", () => {
    expect(splitHighlight("boxbox", ["box"], false)).toEqual([
      { value: "box", match: true },
      { value: "box", match: true },
    ])
  })

  it("never drops a character from the text", () => {
    const parts = splitHighlight("DAB_box 收音 test", ["box", "收音"], false)
    expect(parts.map((part) => part.value).join("")).toBe("DAB_box 收音 test")
  })
})
