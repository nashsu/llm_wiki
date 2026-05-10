import { describe, expect, it } from "vitest"
import { appendLogContent, normalizeLogAppendContent } from "./log-append"

describe("normalizeLogAppendContent", () => {
  it("strips frontmatter and the log title from generated log FILE blocks", () => {
    const generated = [
      "---",
      "type: log",
      "title: 위키 로그",
      "---",
      "",
      "# 위키 로그",
      "",
      "## [2026-05-08] ingest | Source",
      "",
      "- Added pages.",
    ].join("\n")

    expect(normalizeLogAppendContent(generated)).toBe([
      "## [2026-05-08] ingest | Source",
      "",
      "- Added pages.",
    ].join("\n"))
  })

  it("repeats cleanup when the model emits nested log headers", () => {
    const generated = [
      "---",
      "type: log",
      "---",
      "# Wiki Log",
      "---",
      "type: log",
      "---",
      "# 위키 로그",
      "- 2026-05-08: entry",
    ].join("\n")

    expect(normalizeLogAppendContent(generated)).toBe("- 2026-05-08: entry")
  })
})

describe("appendLogContent", () => {
  it("prepends only the log entry after the title and preserves the existing frontmatter block", () => {
    const existing = [
      "---",
      "type: log",
      "title: Wiki Log",
      "---",
      "",
      "# Wiki Log",
      "",
      "## [2026-05-07] ingest | Older",
      "",
      "- Older entry.",
    ].join("\n")
    const incoming = [
      "---",
      "type: log",
      "title: Wiki Log",
      "---",
      "",
      "# Wiki Log",
      "",
      "## [2026-05-08] ingest | Source",
      "",
      "- Added pages.",
    ].join("\n")

    const appended = appendLogContent(existing, incoming)

    expect(appended.match(/^---$/gm)).toHaveLength(2)
    expect(appended).toContain("# Wiki Log")
    expect(appended).toContain("## [2026-05-08] ingest | Source")
    expect(appended.indexOf("## [2026-05-08] ingest | Source")).toBeLessThan(
      appended.indexOf("## [2026-05-07] ingest | Older"),
    )
  })
})
