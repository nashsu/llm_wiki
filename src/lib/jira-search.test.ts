import { describe, expect, it } from "vitest"
import type { JiraIssueSummary } from "@/types/jira"
import {
  applyJiraFilters,
  buildJiraHaystack,
  buildJiraSearchJql,
  dedupeJiraIssuesByKey,
  effectiveJiraFilters,
  EMPTY_JIRA_FILTERS,
  extractJiraFilterOptions,
  filterJiraIssues,
  filterJqlClauses,
  hasActiveJiraFilters,
  JIRA_FILTER_KEYS,
  jiraHighlightTokens,
  JIRA_UNASSIGNED_VALUE,
  matchesJiraQuery,
  mergeJiraResults,
  normalizeForJiraMatch,
  parseJiraIssueKeys,
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

/** Issues carrying the five filter dimensions. */
const ALL_DIMS = { title: true, keyword: true, issueKey: true }
const FILTERED: JiraIssueSummary[] = [
  {
    id: "AERDM-1",
    key: "AERDM-1",
    fields: {
      summary: "收音搜台",
      project: { key: "AERDM", name: "DAB 项目" },
      issuetype: { name: "Bug" },
      status: { name: "待处理" },
      assignee: { key: "JIRAUSER1", name: "wangjin", displayName: "王锦" },
      reporter: { key: "JIRAUSER2", name: "shixy", displayName: "史晓宇" },
    },
  },
  {
    id: "AERDM-2",
    key: "AERDM-2",
    fields: {
      summary: "I2C 时序",
      project: { key: "AERDM", name: "DAB 项目" },
      issuetype: { name: "任务" },
      status: { name: "处理中" },
      assignee: null,
      reporter: { key: "JIRAUSER3", displayName: "赵舜弦" },
    },
  },
  {
    id: "MCU-3",
    key: "MCU-3",
    fields: {
      summary: "boot 死机",
      project: { key: "MCU" },
      issuetype: { name: "Bug" },
      status: { name: "处理中" },
      assignee: { key: "JIRAUSER1", displayName: "王锦" },
      reporter: { key: "JIRAUSER2", displayName: "史晓宇" },
    },
  },
]

describe("extractJiraFilterOptions", () => {
  const options = extractJiraFilterOptions(FILTERED, "未分配")

  it("counts and dedupes each dimension", () => {
    expect(options.project.map((o) => [o.value, o.label, o.count])).toEqual([
      ["AERDM", "AERDM — DAB 项目", 2],
      ["MCU", "MCU", 1],
    ])
    // zh-Hans-CN collation orders CJK labels before Latin ones.
    expect(options.issuetype.map((o) => o.value)).toEqual(["任务", "Bug"])
    expect(options.issuetype.find((o) => o.value === "Bug")?.count).toBe(2)
    expect(options.status.map((o) => o.value)).toEqual(["处理中", "待处理"])
  })

  it("maps a null user to the unassigned option, sinking it last", () => {
    const assignee = options.assignee.map((o) => o.value)
    expect(assignee[assignee.length - 1]).toBe(JIRA_UNASSIGNED_VALUE)
    expect(options.assignee.find((o) => o.value === JIRA_UNASSIGNED_VALUE)?.label).toBe("未分配")
    expect(options.assignee.find((o) => o.value === "王锦")?.count).toBe(2)
    expect(options.reporter.map((o) => o.value)).toEqual(["史晓宇", "赵舜弦"])
  })

  it("renders every dimension for issues that lack the fields entirely", () => {
    const bare = extractJiraFilterOptions([issue("X-1", "no fields")], "未分配")
    expect(JIRA_FILTER_KEYS.every((key) => Array.isArray(bare[key]))).toBe(true)
    expect(bare.status).toEqual([])
  })
})

describe("applyJiraFilters", () => {
  it("returns the list unchanged when every filter is empty", () => {
    expect(applyJiraFilters(FILTERED, EMPTY_JIRA_FILTERS)).toEqual(FILTERED)
  })

  it("filters by one dimension", () => {
    expect(
      applyJiraFilters(FILTERED, { ...EMPTY_JIRA_FILTERS, project: "MCU" }).map((i) => i.key),
    ).toEqual(["MCU-3"])
    expect(
      applyJiraFilters(FILTERED, { ...EMPTY_JIRA_FILTERS, status: "处理中" }).map((i) => i.key),
    ).toEqual(["AERDM-2", "MCU-3"])
  })

  it("intersects multiple dimensions", () => {
    expect(
      applyJiraFilters(FILTERED, {
        ...EMPTY_JIRA_FILTERS,
        issuetype: "Bug",
        assignee: "王锦",
      }).map((i) => i.key),
    ).toEqual(["AERDM-1", "MCU-3"])
    expect(
      applyJiraFilters(FILTERED, {
        ...EMPTY_JIRA_FILTERS,
        issuetype: "任务",
        assignee: "王锦",
      }),
    ).toEqual([])
  })

  it("matches the unassigned marker against null users", () => {
    expect(
      applyJiraFilters(FILTERED, {
        ...EMPTY_JIRA_FILTERS,
        assignee: JIRA_UNASSIGNED_VALUE,
      }).map((i) => i.key),
    ).toEqual(["AERDM-2"])
  })
})

describe("effectiveJiraFilters", () => {
  it("keeps selections the result set still offers", () => {
    const options = extractJiraFilterOptions(FILTERED, "未分配")
    const filters = { ...EMPTY_JIRA_FILTERS, project: "MCU", status: "处理中" }
    expect(effectiveJiraFilters(filters, options)).toEqual(filters)
  })

  it("drops selections that vanished from the result set", () => {
    const options = extractJiraFilterOptions(FILTERED, "未分配")
    const filters = { ...EMPTY_JIRA_FILTERS, project: "不存在", status: "待处理" }
    expect(effectiveJiraFilters(filters, options)).toEqual({
      ...EMPTY_JIRA_FILTERS,
      status: "待处理",
    })
  })
})

describe("server-side filter clauses", () => {
  it("carries each option's pre-escaped JQL clause", () => {
    const options = extractJiraFilterOptions(FILTERED, "未分配")
    expect(options.project.find((o) => o.value === "MCU")?.jql).toBe("project = MCU")
    expect(options.issuetype.find((o) => o.value === "Bug")?.jql).toBe('issuetype = "Bug"')
    expect(options.status.find((o) => o.value === "处理中")?.jql).toBe('status = "处理中"')
    expect(options.assignee.find((o) => o.value === "王锦")?.jql).toBe('assignee = "wangjin"')
    expect(options.assignee.find((o) => o.value === JIRA_UNASSIGNED_VALUE)?.jql).toBe("assignee is EMPTY")
    expect(options.reporter.find((o) => o.value === "史晓宇")?.jql).toBe('reporter = "shixy"')
  })

  it("resolves the selections to clauses in toolbar order", () => {
    const options = extractJiraFilterOptions(FILTERED, "未分配")
    const clauses = filterJqlClauses(
      { ...EMPTY_JIRA_FILTERS, status: "处理中", project: "AERDM" },
      options,
    )
    expect(clauses).toEqual(["project = AERDM", 'status = "处理中"'])
    expect(filterJqlClauses(EMPTY_JIRA_FILTERS, options)).toEqual([])
  })

  it("interpolates the clauses into both search modes", () => {
    const withClauses = buildJiraSearchJql({
      query: "box",
      scopeJql: "project in (AERDM)",
      mode: "narrow",
      filterClauses: ["assignee is EMPTY", 'status = "处理中"'],
    })
    expect(withClauses).toBe(
      '(project in (AERDM)) AND (assignee is EMPTY) AND (status = "处理中") AND ' +
        '(summary ~ "box*" OR text ~ "box*") ORDER BY updated DESC',
    )
    const sweep = buildJiraSearchJql({
      query: "",
      scopeJql: "",
      mode: "sweep",
      filterClauses: ["project = MCU"],
    })
    expect(sweep).toBe("(project = MCU) ORDER BY updated DESC")
  })

  it("escapes quotes and backslashes inside a JQL string value", () => {
    const hostile = issue("X-1", "x")
    hostile.fields.status = { name: 'Re"open\\ed' }
    const options = extractJiraFilterOptions([hostile], "未分配")
    expect(options.status[0].jql).toBe('status = "Re\\"open\\\\ed"')
  })
})

describe("dedupeJiraIssuesByKey", () => {
  it("unions groups, first occurrence wins, no double counting", () => {
    const merged = dedupeJiraIssuesByKey(FILTERED, [FILTERED[0], issue("NEW-9", "extra")])
    expect(merged.map((i) => i.key)).toEqual(["AERDM-1", "AERDM-2", "MCU-3", "NEW-9"])
    const options = extractJiraFilterOptions(merged, "未分配")
    expect(options.assignee.find((o) => o.value === "王锦")?.count).toBe(2)
  })
})

describe("hasActiveJiraFilters", () => {
  it("is false only when every dimension is off", () => {
    expect(hasActiveJiraFilters(EMPTY_JIRA_FILTERS)).toBe(false)
    expect(hasActiveJiraFilters({ ...EMPTY_JIRA_FILTERS, reporter: "史晓宇" })).toBe(true)
  })
})

describe("the acceptance case: BOX finds DAB_box 收音", () => {
  it.each(["BOX", "box", "Box", "bOx"])("matches on %s", (query) => {
    expect(matchesJiraQuery(DAB, query, false, ALL_DIMS)).toBe(true)
  })

  it("matches the CJK half of the title", () => {
    expect(matchesJiraQuery(DAB, "收音", false, ALL_DIMS)).toBe(true)
    expect(matchesJiraQuery(DAB, "收音", true, ALL_DIMS)).toBe(true)
  })

  it("matches a fragment that spans the underscore boundary", () => {
    expect(matchesJiraQuery(DAB, "dab_box", false, ALL_DIMS)).toBe(true)
    expect(matchesJiraQuery(DAB, "ab_bo", false, ALL_DIMS)).toBe(true)
  })

  it("folds full-width input before comparing", () => {
    expect(matchesJiraQuery(DAB, "ＢＯＸ", false, ALL_DIMS)).toBe(true)
  })

  it("matches on a label alone", () => {
    expect(matchesJiraQuery(DAB, "radio", false, ALL_DIMS)).toBe(true)
    expect(matchesJiraQuery(DAB, "RADIO", false, ALL_DIMS)).toBe(true)
  })

  it("rejects a query the issue does not contain", () => {
    expect(matchesJiraQuery(DAB, "bluetooth", false, ALL_DIMS)).toBe(false)
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
    expect(matchesJiraQuery(DAB, "BOX", true, ALL_DIMS)).toBe(false)
    expect(matchesJiraQuery(DAB, "Box", true, ALL_DIMS)).toBe(false)
  })

  it("still lets the exact-case substring through", () => {
    expect(matchesJiraQuery(DAB, "DAB_box", true, ALL_DIMS)).toBe(true)
    expect(matchesJiraQuery(DAB, "box", true, ALL_DIMS)).toBe(true)
  })

  it("never widens the result set", () => {
    const issues = [DAB, TIMING]
    const insensitive = filterJiraIssues(issues, "BOX", false, ALL_DIMS)
    const sensitive = filterJiraIssues(issues, "BOX", true, ALL_DIMS)
    expect(insensitive).toHaveLength(1)
    expect(sensitive).toHaveLength(0)
  })
})

describe("search dimensions (client side)", () => {
  it("title-only drops label and key matches", () => {
    const dims = { title: true, keyword: false, issueKey: false }
    expect(matchesJiraQuery(DAB, "DAB_box", false, dims)).toBe(true)
    expect(matchesJiraQuery(DAB, "radio", false, dims)).toBe(false)
    expect(matchesJiraQuery(DAB, "AERDM-1234", false, dims)).toBe(false)
  })

  it("keyword-only matches labels but not the bare title fragment", () => {
    const dims = { title: false, keyword: true, issueKey: false }
    expect(matchesJiraQuery(DAB, "radio", false, dims)).toBe(true)
    // `收音` lives in the title, which keyword-only does not cover (labels only).
    expect(matchesJiraQuery(DAB, "收音", false, dims)).toBe(false)
  })

  it("issue-key-only matches the key itself", () => {
    const dims = { title: false, keyword: false, issueKey: true }
    expect(matchesJiraQuery(DAB, "AERDM-1234", false, dims)).toBe(true)
    expect(matchesJiraQuery(DAB, "aerdm-1234", false, dims)).toBe(true)
    expect(matchesJiraQuery(DAB, "DAB_box", false, dims)).toBe(false)
  })
})

describe("parseJiraIssueKeys", () => {
  it("keeps well-formed keys, upper-cased", () => {
    expect(parseJiraIssueKeys("aerdm-1 MCU-42")).toEqual(["AERDM-1", "MCU-42"])
    expect(parseJiraIssueKeys("AERDM-1,AERDM-2；MCU-3")).toEqual([
      "AERDM-1",
      "AERDM-2",
      "MCU-3",
    ])
  })

  it("drops anything that is not an issue key", () => {
    expect(parseJiraIssueKeys("收音 box AERDM- MCU-")).toEqual([])
    expect(parseJiraIssueKeys("")).toEqual([])
  })
})

describe("search dimensions (JQL)", () => {
  it("all on keeps the summary/text pair and adds exact keys", () => {
    // sanitize strips the `-` from the text terms (a JQL operator char) — the
    // exact-match clause is what carries a key query, not the text clauses.
    expect(
      buildJiraSearchJql({ query: "AERDM-1", scopeJql: "", mode: "narrow", dimensions: ALL_DIMS }),
    ).toBe(
      '(summary ~ "AERDM 1*" OR text ~ "AERDM 1*" OR issuekey = AERDM-1) ORDER BY updated DESC',
    )
  })

  it("title-only narrows to the summary clause", () => {
    expect(
      buildJiraSearchJql({
        query: "box",
        scopeJql: "",
        mode: "narrow",
        dimensions: { title: true, keyword: false, issueKey: false },
      }),
    ).toBe('(summary ~ "box*") ORDER BY updated DESC')
  })

  it("issue-key-only turns multiple keys into an IN clause", () => {
    expect(
      buildJiraSearchJql({
        query: "aerdm-1, mcu-2",
        scopeJql: "",
        mode: "narrow",
        dimensions: { title: false, keyword: false, issueKey: true },
      }),
    ).toBe("(issuekey in (AERDM-1, MCU-2)) ORDER BY updated DESC")
  })

  it("a non-key query with only issueKey on contributes no text clause", () => {
    expect(
      buildJiraSearchJql({
        query: "收音",
        scopeJql: "",
        mode: "narrow",
        dimensions: { title: false, keyword: false, issueKey: true },
      }),
    ).toBe("ORDER BY updated DESC")
  })

  it("every dimension off is browse mode too", () => {
    expect(
      buildJiraSearchJql({
        query: "box",
        scopeJql: "",
        mode: "narrow",
        dimensions: { title: false, keyword: false, issueKey: false },
      }),
    ).toBe("ORDER BY updated DESC")
  })
})

describe("filterJiraIssues", () => {
  it("treats an empty or whitespace query as browse mode", () => {
    const issues = [DAB, TIMING]
    expect(filterJiraIssues(issues, "", false, ALL_DIMS)).toHaveLength(2)
    expect(filterJiraIssues(issues, "   ", false, ALL_DIMS)).toHaveLength(2)
  })

  it("preserves the incoming order", () => {
    const issues = [DAB, TIMING]
    expect(filterJiraIssues(issues, "dab", false, ALL_DIMS).map((i) => i.key)).toEqual(["AERDM-1234"])
  })

  it("survives an issue with no fields at all", () => {
    const bare: JiraIssueSummary = { id: "1", key: "AERDM-1", fields: {} }
    expect(buildJiraHaystack(bare, ALL_DIMS)).toBe("\nAERDM-1")
    expect(matchesJiraQuery(bare, "anything", false, ALL_DIMS)).toBe(false)
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
  it("builds the narrow pass against summary and text", () => {
    expect(buildJiraSearchJql({ query: "BOX", scopeJql: "", mode: "narrow" })).toBe(
      '(summary ~ "BOX*" OR text ~ "BOX*") ORDER BY updated DESC',
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
      '(project = AERDM) AND (summary ~ "BOX*" OR text ~ "BOX*") ORDER BY updated DESC',
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
