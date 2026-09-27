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

import type { JiraIssueSummary } from "@/types/jira"

/** JQL text-search operators and syntax — stripped from user input before quoting. */
const JQL_SPECIAL_CHARS = /[+\-&|!(){}[\]^"~*?:\\/]/g

/**
 * Fold both sides. NFKC turns full-width `ＢＯＸ` into `BOX`; the lowercase step
 * is skipped entirely when the user asked for case-sensitive matching.
 */
export function normalizeForJiraMatch(value: string, matchCase: boolean): string {
  const folded = (value ?? "").normalize("NFKC")
  return matchCase ? folded : folded.toLocaleLowerCase()
}

/** What a query is matched against: the title and every label. */
export function buildJiraHaystack(issue: JiraIssueSummary): string {
  const labels = issue.fields?.labels ?? []
  return [issue.fields?.summary ?? "", ...labels].join("\n")
}

export function matchesJiraQuery(
  issue: JiraIssueSummary,
  query: string,
  matchCase: boolean,
): boolean {
  const needle = normalizeForJiraMatch(query.trim(), matchCase)
  if (!needle) return true
  return normalizeForJiraMatch(buildJiraHaystack(issue), matchCase).includes(needle)
}

export function filterJiraIssues(
  issues: readonly JiraIssueSummary[],
  query: string,
  matchCase: boolean,
): JiraIssueSummary[] {
  return issues.filter((issue) => matchesJiraQuery(issue, query, matchCase))
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
}): string {
  const clauses: string[] = []
  const scope = stripTrailingOrderBy(params.scopeJql)
  if (scope) clauses.push(`(${scope})`)
  if (params.mode === "narrow") {
    const term = sanitizeJqlTextTerm(params.query)
    if (term) {
      clauses.push(`(summary ~ "${term}*" OR labels ~ "${term}*" OR text ~ "${term}*")`)
    }
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
