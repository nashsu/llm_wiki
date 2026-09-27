import { describe, expect, it } from "vitest"
import type { JiraIssueSummary } from "@/types/jira"
import {
  buildJiraHaystack,
  buildJiraSearchJql,
  filterJiraIssues,
  jiraHighlightTokens,
  matchesJiraQuery,
  mergeJiraResults,
  normalizeForJiraMatch,
  sanitizeJqlTextTerm,
  shouldRunSweep,
} from "./jira-search"

/** The issue the whole feature is acceptance-tested against. */
const DAB = issue("AERDM-1234", "DAB_box 收音", ["DAB", "radio"], "2026-03-01T10:22:00.000+0800")
const TIMING = issue("AERDM-2000", "修复 I2C 时序", ["driver"], "2026-03-05T09:10:00.000+0800")

function issue(
  key: string,
  summary: string,
  labels: string[] = [],
  updated = "2026-01-01T00:00:00.000+0800",
): JiraIssueSummary {
  return { id: key, key, fields: { summary, labels, updated } }
}

describe("the acceptance case: BOX finds DAB_box 收音", () => {
  it.each(["BOX", "box", "Box", "bOx"])("matches on %s", (query) => {
    expect(matchesJiraQuery(DAB, query, false)).toBe(true)
  })

  it("matches the CJK half of the title", () => {
    expect(matchesJiraQuery(DAB, "收音", false)).toBe(true)
    expect(matchesJiraQuery(DAB, "收音", true)).toBe(true)
  })

  it("matches a fragment that spans the underscore boundary", () => {
    expect(matchesJiraQuery(DAB, "dab_box", false)).toBe(true)
    expect(matchesJiraQuery(DAB, "ab_bo", false)).toBe(true)
  })

  it("folds full-width input before comparing", () => {
    expect(matchesJiraQuery(DAB, "ＢＯＸ", false)).toBe(true)
  })

  it("matches on a label alone", () => {
    expect(matchesJiraQuery(DAB, "radio", false)).toBe(true)
    expect(matchesJiraQuery(DAB, "RADIO", false)).toBe(true)
  })

  it("rejects a query the issue does not contain", () => {
    expect(matchesJiraQuery(DAB, "bluetooth", false)).toBe(false)
  })
})

describe("matchCase", () => {
  it("is off by default semantics: any case matches", () => {
    expect(normalizeForJiraMatch("DAB_box 收音", false)).toBe("dab_box 收音")
  })

  it("leaves case untouched when on", () => {
    expect(normalizeForJiraMatch("DAB_box 收音", true)).toBe("DAB_box 收音")
  })

  it("still folds full-width characters when on", () => {
    // NFKC is a normalisation, not a case fold — `ＢＯＸ` is `BOX`, not a different word.
    expect(normalizeForJiraMatch("ＢＯＸ", true)).toBe("BOX")
  })

  it("stops BOX from matching the lowercase title", () => {
    expect(matchesJiraQuery(DAB, "BOX", true)).toBe(false)
    expect(matchesJiraQuery(DAB, "Box", true)).toBe(false)
  })

  it("still lets the exact-case substring through", () => {
    expect(matchesJiraQuery(DAB, "DAB_box", true)).toBe(true)
    expect(matchesJiraQuery(DAB, "box", true)).toBe(true)
  })

  it("never widens the result set", () => {
    const issues = [DAB, TIMING]
    const insensitive = filterJiraIssues(issues, "BOX", false)
    const sensitive = filterJiraIssues(issues, "BOX", true)
    expect(insensitive).toHaveLength(1)
    expect(sensitive).toHaveLength(0)
  })
})

describe("filterJiraIssues", () => {
  it("treats an empty or whitespace query as browse mode", () => {
    const issues = [DAB, TIMING]
    expect(filterJiraIssues(issues, "", false)).toHaveLength(2)
    expect(filterJiraIssues(issues, "   ", false)).toHaveLength(2)
  })

  it("preserves the incoming order", () => {
    const issues = [DAB, TIMING]
    expect(filterJiraIssues(issues, "dab", false).map((i) => i.key)).toEqual(["AERDM-1234"])
  })

  it("survives an issue with no fields at all", () => {
    const bare: JiraIssueSummary = { id: "1", key: "AERDM-1", fields: {} }
    expect(buildJiraHaystack(bare)).toBe("")
    expect(matchesJiraQuery(bare, "anything", false)).toBe(false)
  })
})

describe("sanitizeJqlTextTerm", () => {
  it("strips JQL operators and quotes", () => {
    expect(sanitizeJqlTextTerm('a+b&c|d"e')).toBe("a b c d e")
  })

  it("returns an empty string when nothing survives", () => {
    expect(sanitizeJqlTextTerm("*()")).toBe("")
    expect(sanitizeJqlTextTerm("   ")).toBe("")
  })

  it("keeps CJK and word characters", () => {
    expect(sanitizeJqlTextTerm("DAB_box 收音")).toBe("DAB_box 收音")
  })

  it("removes both the quote and the backslash, so the result needs no escaping", () => {
    const term = sanitizeJqlTextTerm('say "hi"\\')
    expect(term).not.toContain('"')
    expect(term).not.toContain("\\")
  })
})

describe("buildJiraSearchJql", () => {
  it("builds the narrow pass against summary, labels and text", () => {
    expect(buildJiraSearchJql({ query: "BOX", scopeJql: "", mode: "narrow" })).toBe(
      '(summary ~ "BOX*" OR labels ~ "BOX*" OR text ~ "BOX*") ORDER BY updated DESC',
    )
  })

  it("omits the text clause entirely when the query sanitises away", () => {
    expect(buildJiraSearchJql({ query: "*()", scopeJql: "", mode: "narrow" })).toBe(
      "ORDER BY updated DESC",
    )
  })

  it("keeps the scope on a text-less narrow query", () => {
    expect(buildJiraSearchJql({ query: "*()", scopeJql: "project = AERDM", mode: "narrow" })).toBe(
      "(project = AERDM) ORDER BY updated DESC",
    )
  })

  it("ANDs the scope with the text clause", () => {
    expect(buildJiraSearchJql({ query: "BOX", scopeJql: "project = AERDM", mode: "narrow" })).toBe(
      '(project = AERDM) AND (summary ~ "BOX*" OR labels ~ "BOX*" OR text ~ "BOX*") ORDER BY updated DESC',
    )
  })

  it("drops the user's own ORDER BY so the appended one is the only sort clause", () => {
    const jql = buildJiraSearchJql({
      query: "",
      scopeJql: "project = AERDM ORDER BY created ASC",
      mode: "sweep",
    })
    expect(jql).toBe("(project = AERDM) ORDER BY updated DESC")
    expect(jql.match(/ORDER BY/gi)).toHaveLength(1)
  })

  it("sweeps without any text filter", () => {
    expect(buildJiraSearchJql({ query: "BOX", scopeJql: "", mode: "sweep" })).toBe(
      "ORDER BY updated DESC",
    )
  })

  it("trims a whitespace-only scope instead of emitting an empty group", () => {
    expect(buildJiraSearchJql({ query: "", scopeJql: "   ", mode: "sweep" })).toBe(
      "ORDER BY updated DESC",
    )
    expect(buildJiraSearchJql({ query: "", scopeJql: "ORDER BY created", mode: "sweep" })).toBe(
      "ORDER BY updated DESC",
    )
  })
})

describe("mergeJiraResults", () => {
  it("dedupes by key, keeping the narrow copy", () => {
    const narrow = [issue("AERDM-1", "narrow copy", [], "2026-03-01T00:00:00.000+0800")]
    const sweep = [issue("AERDM-1", "sweep copy", [], "2026-03-01T00:00:00.000+0800")]
    const merged = mergeJiraResults(narrow, sweep)
    expect(merged).toHaveLength(1)
    expect(merged[0].fields.summary).toBe("narrow copy")
  })

  it("sorts newest first", () => {
    const merged = mergeJiraResults([DAB, TIMING], [])
    expect(merged.map((i) => i.key)).toEqual(["AERDM-2000", "AERDM-1234"])
  })

  it("breaks a timestamp tie by key so the order is stable", () => {
    const same = "2026-03-01T00:00:00.000+0800"
    const merged = mergeJiraResults(
      [issue("AERDM-9", "nine", [], same), issue("AERDM-2", "two", [], same)],
      [],
    )
    expect(merged.map((i) => i.key)).toEqual(["AERDM-2", "AERDM-9"])
  })

  it("sinks unparseable dates to the end rather than scrambling the list", () => {
    const merged = mergeJiraResults([issue("AERDM-1", "no date", [], "not a date"), DAB], [])
    expect(merged.map((i) => i.key)).toEqual(["AERDM-1234", "AERDM-1"])
  })

  it("returns an empty list for two empty inputs", () => {
    expect(mergeJiraResults([], [])).toEqual([])
  })
})

describe("shouldRunSweep", () => {
  it("sweeps when the cheap pass came back thin", () => {
    expect(shouldRunSweep(0, "BOX", 20)).toBe(true)
    expect(shouldRunSweep(19, "BOX", 20)).toBe(true)
  })

  it("does not sweep once the narrow pass is fat enough", () => {
    expect(shouldRunSweep(20, "BOX", 20)).toBe(false)
    expect(shouldRunSweep(50, "BOX", 20)).toBe(false)
  })

  it("never sweeps a query with no usable text — the narrow pass is already the recent window", () => {
    expect(shouldRunSweep(0, "", 20)).toBe(false)
    expect(shouldRunSweep(0, "*()", 20)).toBe(false)
  })

  it("does not sweep when the threshold is zero", () => {
    expect(shouldRunSweep(0, "BOX", 0)).toBe(false)
  })
})

describe("jiraHighlightTokens", () => {
  it("folds like the matcher so the highlight lines up with the hit", () => {
    expect(jiraHighlightTokens("BOX", false)).toEqual(["box"])
  })

  it("splits on whitespace and drops empties", () => {
    expect(jiraHighlightTokens("  DAB   box  ", false)).toEqual(["dab", "box"])
  })

  it("returns the longest token first, so a short token cannot split a longer match", () => {
    expect(jiraHighlightTokens("box dab_box", false)).toEqual(["dab_box", "box"])
  })

  it("dedupes repeated tokens", () => {
    expect(jiraHighlightTokens("box BOX", false)).toEqual(["box"])
  })

  it("returns nothing for an empty query", () => {
    expect(jiraHighlightTokens("   ", false)).toEqual([])
  })
})
