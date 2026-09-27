import { describe, expect, it } from "vitest"
import {
  buildJiraExportFileName,
  findExportsForIssue,
  JIRA_FILE_SEGMENT_MAX_LENGTH,
  parseJiraExportFileName,
  sanitizeJiraFileSegment,
} from "./jira-filename"

/** Local-time construction so the expected date does not depend on the runner's zone. */
const day = (year: number, month: number, date: number) => new Date(year, month - 1, date, 14, 3)

describe("buildJiraExportFileName", () => {
  it("builds the agreed shape", () => {
    expect(buildJiraExportFileName(day(2026, 9, 27), "AERDM-1234", "DAB_box 收音")).toBe(
      "2026-09-27 AERDM-1234 DAB_box 收音.md",
    )
  })

  it("keeps the underscores and the space in the title intact", () => {
    // `safeSlug` would have produced `DAB-box-收音` and broken discovery by title.
    const name = buildJiraExportFileName(day(2026, 9, 27), "AERDM-1234", "DAB_box 收音")
    expect(name).toContain("DAB_box 收音")
  })

  it("pads a single-digit month and day", () => {
    expect(buildJiraExportFileName(day(2026, 1, 5), "AERDM-1", "x")).toBe("2026-01-05 AERDM-1 x.md")
  })

  it("replaces path separators so a title can never create a directory", () => {
    const name = buildJiraExportFileName(day(2026, 9, 27), "AERDM-1", "fix: a/b\\c")
    expect(name).toBe("2026-09-27 AERDM-1 fix a b c.md")
    expect(name).not.toContain("/")
    expect(name).not.toContain("\\")
  })

  it("falls back when the title is empty after sanitising", () => {
    expect(buildJiraExportFileName(day(2026, 9, 27), "AERDM-1", "   ")).toBe(
      "2026-09-27 AERDM-1 untitled.md",
    )
  })

  it("honours a non-default extension", () => {
    expect(buildJiraExportFileName(day(2026, 9, 27), "AERDM-1", "x", "json")).toBe(
      "2026-09-27 AERDM-1 x.json",
    )
  })
})

describe("sanitizeJiraFileSegment", () => {
  it("turns the illegal Windows characters into spaces and collapses runs", () => {
    expect(sanitizeJiraFileSegment('a<b>c:d"e/f\\g|h?i*j')).toBe("a b c d e f g h i j")
  })

  it("strips a trailing dot or space, which Windows would silently drop anyway", () => {
    expect(sanitizeJiraFileSegment("title...")).toBe("title")
    expect(sanitizeJiraFileSegment("title . . ")).toBe("title")
  })

  it("escapes the reserved DOS device names", () => {
    expect(sanitizeJiraFileSegment("CON")).toBe("CON_")
    expect(sanitizeJiraFileSegment("nul")).toBe("nul_")
    expect(sanitizeJiraFileSegment("LPT1")).toBe("LPT1_")
    expect(sanitizeJiraFileSegment("COM9")).toBe("COM9_")
  })

  it("does not escape a name that merely starts with a device name", () => {
    expect(sanitizeJiraFileSegment("COM10")).toBe("COM10")
    expect(sanitizeJiraFileSegment("console")).toBe("console")
  })

  it("uses the fallback when nothing is left", () => {
    expect(sanitizeJiraFileSegment("///")).toBe("untitled")
    expect(sanitizeJiraFileSegment("   ", { fallback: "ISSUE" })).toBe("ISSUE")
  })

  it("truncates by code point, never splitting a surrogate pair", () => {
    const segment = sanitizeJiraFileSegment("🎧".repeat(100))
    expect(Array.from(segment)).toHaveLength(JIRA_FILE_SEGMENT_MAX_LENGTH)
    // A split pair would leave a lone surrogate, which is not valid UTF-16 the
    // other way round — the round trip catches it.
    expect(segment).toBe("🎧".repeat(JIRA_FILE_SEGMENT_MAX_LENGTH))
    expect(segment).not.toContain("�")
  })

  it("honours a custom max length", () => {
    expect(sanitizeJiraFileSegment("abcdef", { maxLength: 3 })).toBe("abc")
  })

  it("keeps CJK and underscores untouched", () => {
    expect(sanitizeJiraFileSegment("DAB_box 收音")).toBe("DAB_box 收音")
  })

  it("keeps a leading dot from producing a hidden file", () => {
    expect(sanitizeJiraFileSegment(".hidden")).toBe(".hidden")
  })
})

describe("parseJiraExportFileName", () => {
  it("round-trips what we write", () => {
    const name = buildJiraExportFileName(day(2026, 9, 27), "AERDM-1234", "DAB_box 收音")
    expect(parseJiraExportFileName(name)).toEqual({
      date: "2026-09-27",
      key: "AERDM-1234",
      title: "DAB_box 收音",
    })
  })

  it("rejects anything that is not our shape", () => {
    expect(parseJiraExportFileName("README.md")).toBeNull()
    expect(parseJiraExportFileName("2026-09-27 AERDM-1234 no extension")).toBeNull()
    expect(parseJiraExportFileName("2026-9-27 AERDM-1234 x.md")).toBeNull()
    expect(parseJiraExportFileName("2026-09-27 aerDM-1234 x.md")).toBeNull()
    expect(parseJiraExportFileName("2026-09-27 AERDM x.md")).toBeNull()
    expect(parseJiraExportFileName("2026-09-27 AERDM-1234 .md")).toBeNull()
  })

  it("tolerates surrounding whitespace from a directory listing", () => {
    expect(parseJiraExportFileName("  2026-09-27 AERDM-1234 x.md  ")?.key).toBe("AERDM-1234")
  })

  it("keeps a dotted title in one piece", () => {
    expect(parseJiraExportFileName("2026-09-27 AERDM-1 v1.2.3 fixes.md")?.title).toBe("v1.2.3 fixes")
  })
})

describe("findExportsForIssue", () => {
  const files = [
    "2026-09-27 AERDM-1234 DAB_box 收音.md",
    "2026-03-01 AERDM-1234 DAB_box 收音.md",
    "2026-09-30 AERDM-1234 DAB_box 收音.md",
    "2026-09-27 AERDM-12345 another issue.md",
    "2026-09-27 AERDM-1234 screenshot.png",
    "notes.md",
  ]

  it("returns only that issue's exports, newest first", () => {
    expect(findExportsForIssue(files, "AERDM-1234")).toEqual([
      "2026-09-30 AERDM-1234 DAB_box 收音.md",
      "2026-09-27 AERDM-1234 DAB_box 收音.md",
      "2026-03-01 AERDM-1234 DAB_box 收音.md",
    ])
  })

  it("does not let a short key pick up a longer one", () => {
    expect(findExportsForIssue(files, "AERDM-123")).toEqual([])
    expect(findExportsForIssue(files, "AERDM-12345")).toEqual([
      "2026-09-27 AERDM-12345 another issue.md",
    ])
  })

  it("ignores a non-markdown file that happens to share the key", () => {
    expect(findExportsForIssue(files, "AERDM-1234").some((f) => f.endsWith(".png"))).toBe(false)
  })

  it("returns an empty list when nothing matches", () => {
    expect(findExportsForIssue(files, "AERDM-9999")).toEqual([])
    expect(findExportsForIssue([], "AERDM-1234")).toEqual([])
  })

  it("orders same-day exports deterministically", () => {
    const sameDay = [
      "2026-09-27 AERDM-1 zzz.md",
      "2026-09-27 AERDM-1 aaa.md",
    ]
    expect(findExportsForIssue(sameDay, "AERDM-1")).toEqual([
      "2026-09-27 AERDM-1 zzz.md",
      "2026-09-27 AERDM-1 aaa.md",
    ])
  })
})
