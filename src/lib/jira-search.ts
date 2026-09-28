/**
 * Query matching for the Jira view, plus the JQL that feeds it.
 *
 * The acceptance case is: the issue titled `DAB_box 收音` must be found by
 * typing `BOX` (any case) and by typing `收音`.
 *
 * JQL cannot do that job. `summary ~ "BOX"` is a Lucene *term* query against an
 * analysed field, not a substring search: whether `DAB_box` even yields a `box`
 * term depends on the instance's analyser treating `_` as a separator, and CJK
 * text has no spaces to tokenise on at all. So JQL is only a recall pre-filter
 * and the substring matcher below is the authoritative one — the same
 * NFKC + substring semantics as the source-tree search the user already knows
 * (`filterSourceTreeByQuery`), with `toLocaleLowerCase` gated by `matchCase`.
 */

import type { JiraIssueSummary, JiraSearchDimensions } from "@/types/jira"

/** JQL text-search operators and syntax — stripped from user input before quoting. */
const JQL_SPECIAL_CHARS = /[+\-&|!(){}[\]^"~*?:\\/]/g

/** `PROJECT-123` style issue keys, case-insensitively. */
const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

/**
 * Fold both sides. NFKC turns full-width `ＢＯＸ` into `BOX`; the lowercase step
 * is skipped entirely when the user asked for case-sensitive matching.
 */
export function normalizeForJiraMatch(value: string, matchCase: boolean): string {
  const folded = (value ?? "").normalize("NFKC")
  return matchCase ? folded : folded.toLocaleLowerCase()
}

/**
 * Split the query on commas/whitespace and keep only well-formed issue keys,
 * upper-cased (Jira keys are upper). `AERDM-1, aerdm-2` → `["AERDM-1", "AERDM-2"]`.
 */
export function parseJiraIssueKeys(query: string): string[] {
  return (query ?? "")
    .split(/[\s,;，；]+/)
    .map((token) => token.trim().toUpperCase())
    .filter((token) => ISSUE_KEY_PATTERN.test(token))
}

/**
 * The client-side dimensions of the haystack: title when `title` is checked,
 * labels (the stand-in for "keyword" — the client has no full-text index) when
 * `keyword` is checked, and the issue key itself when `issueKey` is checked.
 */
export function buildJiraHaystack(
  issue: JiraIssueSummary,
  dimensions: JiraSearchDimensions,
): string {
  const parts: string[] = []
  if (dimensions.title) parts.push(issue.fields?.summary ?? "")
  if (dimensions.keyword) parts.push(...(issue.fields?.labels ?? []))
  if (dimensions.issueKey) parts.push(issue.key)
  return parts.join("\n")
}

export function matchesJiraQuery(
  issue: JiraIssueSummary,
  query: string,
  matchCase: boolean,
  dimensions: JiraSearchDimensions,
): boolean {
  const needle = normalizeForJiraMatch(query.trim(), matchCase)
  if (!needle) return true
  return normalizeForJiraMatch(buildJiraHaystack(issue, dimensions), matchCase).includes(needle)
}

export function filterJiraIssues(
  issues: readonly JiraIssueSummary[],
  query: string,
  matchCase: boolean,
  dimensions: JiraSearchDimensions,
): JiraIssueSummary[] {
  return issues.filter((issue) => matchesJiraQuery(issue, query, matchCase, dimensions))
}

/**
 * Reduce a query to something safe to drop inside a JQL quoted string.
 * Returns `""` when nothing survives (e.g. the user typed `"*()`), which the
 * JQL builder reads as "no text clause".
 *
 * Because this strips both `"` and `\`, the term can be interpolated into
 * `"…"` without further escaping.
 */
export function sanitizeJqlTextTerm(query: string): string {
  return (query ?? "")
    .normalize("NFKC")
    .replace(JQL_SPECIAL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Drop a trailing `ORDER BY …` so the appended one is the only sort clause. */
function stripTrailingOrderBy(jql: string): string {
  return jql.replace(/\s*ORDER\s+BY\s+[\s\S]*$/i, "").trim()
}

/**
 * Two shapes of request:
 *  - `narrow` — the user's text against summary/labels/full text.
 *  - `sweep`  — the recent window, unfiltered. This is what makes `BOX` find
 *    `DAB_box 收音` when the analyser tokenised the title differently: the
 *    narrow pass returns 0, the sweep brings the issue back, and the client-side
 *    substring matcher on the merged list decides.
 *
 * Everything is sorted by `updated DESC` — the sweep's whole value is that it
 * covers a recent window, so the user's own ORDER BY (if any) is replaced.
 */
export function buildJiraSearchJql(params: {
  query: string
  scopeJql: string
  mode: "narrow" | "sweep"
  /** Pre-escaped filter clauses (from `filterJqlClauses`) — applied to both modes. */
  filterClauses?: readonly string[]
  /** Which dimensions the query searches; missing = all on. */
  dimensions?: JiraSearchDimensions
}): string {
  const clauses: string[] = []
  const scope = stripTrailingOrderBy(params.scopeJql)
  if (scope) clauses.push(`(${scope})`)
  for (const clause of params.filterClauses ?? []) clauses.push(`(${clause})`)
  if (params.mode === "narrow") {
    const dims = params.dimensions ?? { title: true, keyword: true, issueKey: true }
    const parts: string[] = []
    const term = sanitizeJqlTextTerm(params.query)
    if (dims.title && term) parts.push(`summary ~ "${term}*"`)
    if (dims.keyword && term) parts.push(`text ~ "${term}*"`)
    if (dims.issueKey) {
      const keys = parseJiraIssueKeys(params.query)
      if (keys.length === 1) parts.push(`issuekey = ${keys[0]}`)
      else if (keys.length > 1) parts.push(`issuekey in (${keys.join(", ")})`)
    }
    if (parts.length > 0) clauses.push(`(${parts.join(" OR ")})`)
  }
  const where = clauses.join(" AND ")
  return where ? `${where} ORDER BY updated DESC` : "ORDER BY updated DESC"
}

function updatedEpoch(issue: JiraIssueSummary): number {
  const parsed = Date.parse(issue.fields?.updated ?? "")
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

/** Newest first; ties and unparseable dates fall back to the issue key so the order is stable. */
function compareByRecency(left: JiraIssueSummary, right: JiraIssueSummary): number {
  const diff = updatedEpoch(right) - updatedEpoch(left)
  if (diff !== 0) return diff
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
}

/** Narrow hits first (they are the better ones), sweep-only extras appended, deduped by key. */
export function mergeJiraResults(
  narrow: readonly JiraIssueSummary[],
  sweep: readonly JiraIssueSummary[],
): JiraIssueSummary[] {
  const seen = new Set<string>()
  const merged: JiraIssueSummary[] = []
  for (const issue of [...narrow, ...sweep]) {
    if (seen.has(issue.key)) continue
    seen.add(issue.key)
    merged.push(issue)
  }
  return merged.sort(compareByRecency)
}

/**
 * The sweep costs a second request over a wider window, so only run it when the
 * cheap pass came back thin. A query with no usable text is the browse case —
 * the narrow request is already the recent window, so sweeping adds nothing.
 */
export function shouldRunSweep(narrowCount: number, query: string, threshold: number): boolean {
  if (!sanitizeJqlTextTerm(query)) return false
  return narrowCount < threshold
}

/** Case-folded tokens the view highlights inside titles/labels, longest first. */
export function jiraHighlightTokens(query: string, matchCase: boolean): string[] {
  const tokens = normalizeForJiraMatch(query.trim(), matchCase)
    .split(/\s+/)
    .filter((token) => token.length > 0)
  const unique = Array.from(new Set(tokens))
  return unique.sort((a, b) => b.length - a.length)
}

/**
 * Filter option for one dimension. `value` is what filtering compares against
 * (the raw field value, or `JIRA_UNASSIGNED_VALUE` for a missing user);
 * `label` is what the dropdown shows; `jql` is the ready-made clause for the
 * server-side re-query (e.g. `assignee = "wangjin0115"`, `assignee is EMPTY`).
 */
export interface JiraFilterOption {
  value: string
  label: string
  count: number
  jql: string
}

export interface JiraFilterOptions {
  project: JiraFilterOption[]
  issuetype: JiraFilterOption[]
  status: JiraFilterOption[]
  assignee: JiraFilterOption[]
  reporter: JiraFilterOption[]
}

/** Marker for issues whose assignee/reporter is null — a real, selectable state. */
export const JIRA_UNASSIGNED_VALUE = "__unassigned__"

/** The five dropdown dimensions, in toolbar order. */
export type JiraFilterKey = keyof JiraFilterOptions

export const JIRA_FILTER_KEYS: readonly JiraFilterKey[] = [
  "project",
  "issuetype",
  "status",
  "assignee",
  "reporter",
]

export type JiraIssueFilters = Record<JiraFilterKey, string>

/** Every dimension off — what the view starts from and "clear" returns to. */
export const EMPTY_JIRA_FILTERS: JiraIssueFilters = {
  project: "",
  issuetype: "",
  status: "",
  assignee: "",
  reporter: "",
}

/**
 * What one issue contributes to a dimension:
 *  - `undefined`  → the field is missing entirely (skipped, except users where
 *    it means "unassigned" and becomes a selectable option)
 *  - `{ value, label, jql }` → a concrete option with its server-side clause
 */
type JiraFilterPicker = (issue: JiraIssueSummary) => { value: string; label: string; jql: string } | undefined

/** Escape a value for interpolation into a JQL `"…"` string. */
function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

const pickProject: JiraFilterPicker = (issue) => {
  const project = issue.fields?.project
  const key = project?.key?.trim()
  const name = project?.name?.trim()
  if (!key && !name) return undefined
  // Prefer the key as the stable value; show both when they differ.
  const value = key || name || ""
  const label = key && name && key !== name ? `${key} — ${name}` : value
  // A project key is an identifier — bare, never quoted.
  return { value, label, jql: `project = ${value}` }
}

const pickIssueType: JiraFilterPicker = (issue) => {
  const name = issue.fields?.issuetype?.name?.trim()
  return name ? { value: name, label: name, jql: `issuetype = ${jqlQuote(name)}` } : undefined
}

const pickStatus: JiraFilterPicker = (issue) => {
  const name = issue.fields?.status?.name?.trim()
  return name ? { value: name, label: name, jql: `status = ${jqlQuote(name)}` } : undefined
}

function pickUser(
  field: "assignee" | "reporter",
  user: JiraIssueSummary["fields"]["assignee"],
): { value: string; label: string; jql: string } | undefined {
  if (!user) return { value: JIRA_UNASSIGNED_VALUE, label: "", jql: `${field} is EMPTY` }
  const name = user.displayName?.trim() || user.name?.trim() || user.key?.trim()
  if (!name) return { value: JIRA_UNASSIGNED_VALUE, label: "", jql: `${field} is EMPTY` }
  // JQL matches the login name (unique); displayName may collide across users.
  const login = user.name?.trim() || user.key?.trim() || name
  return { value: name, label: name, jql: `${field} = ${jqlQuote(login)}` }
}

const pickAssignee: JiraFilterPicker = (issue) => pickUser("assignee", issue.fields?.assignee)

const pickReporter: JiraFilterPicker = (issue) => pickUser("reporter", issue.fields?.reporter)

const FILTER_PICKERS: Record<JiraFilterKey, JiraFilterPicker> = {
  project: pickProject,
  issuetype: pickIssueType,
  status: pickStatus,
  assignee: pickAssignee,
  reporter: pickReporter,
}

/**
 * Build every dropdown's options from the issues currently loaded. Values are
 * deduped with counts, sorted by label (locale-aware so Chinese names order
 * sensibly), and unassigned sinks to the end of the user dimensions.
 */
export function extractJiraFilterOptions(
  issues: readonly JiraIssueSummary[],
  unassignedLabel: string,
): JiraFilterOptions {
  const result = {} as JiraFilterOptions
  for (const key of JIRA_FILTER_KEYS) {
    const counts = new Map<string, JiraFilterOption>()
    for (const issue of issues) {
      const picked = FILTER_PICKERS[key](issue)
      if (!picked) continue
      const label = picked.value === JIRA_UNASSIGNED_VALUE ? unassignedLabel : picked.label
      const existing = counts.get(picked.value)
      if (existing) existing.count += 1
      else counts.set(picked.value, { value: picked.value, label, count: 1, jql: picked.jql })
    }
    const options = Array.from(counts.values()).sort((left, right) => {
      const leftUnassigned = left.value === JIRA_UNASSIGNED_VALUE
      const rightUnassigned = right.value === JIRA_UNASSIGNED_VALUE
      if (leftUnassigned !== rightUnassigned) return leftUnassigned ? 1 : -1
      return left.label.localeCompare(right.label, "zh-Hans-CN")
    })
    result[key] = options
  }
  return result
}

function matchesDimension(
  issue: JiraIssueSummary,
  key: JiraFilterKey,
  filterValue: string,
): boolean {
  if (!filterValue) return true
  const picked = FILTER_PICKERS[key](issue)
  const value = picked?.value
  if (filterValue === JIRA_UNASSIGNED_VALUE) {
    // "Unassigned" matches both an explicit null user and a missing field.
    return !value || value === JIRA_UNASSIGNED_VALUE
  }
  return value === filterValue
}

/**
 * Apply the dropdown filters on top of the text-filtered list. A filter value
 * that no longer exists in `issues` simply yields no rows for that dimension —
 * the view is expected to feed `effectiveJiraFilters` output here so the
 * dropdown and the filter never disagree.
 */
export function applyJiraFilters(
  issues: readonly JiraIssueSummary[],
  filters: JiraIssueFilters,
): JiraIssueSummary[] {
  const active = JIRA_FILTER_KEYS.filter((key) => filters[key])
  if (active.length === 0) return [...issues]
  return issues.filter((issue) => active.every((key) => matchesDimension(issue, key, filters[key])))
}

/**
 * Drop selections the current result set can no longer represent (the user
 * retyped and the previous dimension value vanished). Keeps the select's
 * displayed value and the filtering in lockstep without a state-effect loop.
 */
export function effectiveJiraFilters(
  filters: JiraIssueFilters,
  options: JiraFilterOptions,
): JiraIssueFilters {
  const result = { ...filters }
  for (const key of JIRA_FILTER_KEYS) {
    const value = filters[key]
    if (value && !options[key].some((option) => option.value === value)) {
      result[key] = ""
    }
  }
  return result
}

/** Whether any dropdown has a selection — drives the "clear" button. */
export function hasActiveJiraFilters(filters: JiraIssueFilters): boolean {
  return JIRA_FILTER_KEYS.some((key) => filters[key] !== "")
}

/**
 * The JQL clauses for the current dropdown selections, looked up from the
 * option pool (the pool carries the pre-escaped clause). A selection with no
 * matching option contributes nothing — the view feeds it `effectiveJiraFilters`
 * output so that state cannot happen anyway.
 */
export function filterJqlClauses(
  filters: JiraIssueFilters,
  options: JiraFilterOptions,
): string[] {
  const clauses: string[] = []
  for (const key of JIRA_FILTER_KEYS) {
    const value = filters[key]
    if (!value) continue
    const option = options[key].find((candidate) => candidate.value === value)
    if (option) clauses.push(option.jql)
  }
  return clauses
}

/**
 * Union two issue sets by key (first occurrence wins) so the option pool built
 * from an inventory sweep plus the current results never double-counts an issue.
 */
export function dedupeJiraIssuesByKey(
  ...groups: readonly (readonly JiraIssueSummary[])[]
): JiraIssueSummary[] {
  const seen = new Set<string>()
  const merged: JiraIssueSummary[] = []
  for (const group of groups) {
    for (const issue of group) {
      if (seen.has(issue.key)) continue
      seen.add(issue.key)
      merged.push(issue)
    }
  }
  return merged
}
