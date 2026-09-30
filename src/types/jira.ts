/**
 * Jira Server / Data Center REST API v2 response shapes.
 *
 * Only the fields this app reads are declared — the API returns far more, and
 * every request names its `fields` explicitly. Everything is optional because a
 * DC instance may omit a field (or return `null`) for a given issue.
 */

export interface JiraNamedValue {
  name?: string
}

export interface JiraUser {
  name?: string
  key?: string
  displayName?: string
  emailAddress?: string
}

export interface JiraProjectRef {
  key?: string
  name?: string
}

/** One row of a search response, and the unit the client-side matcher filters. */
export interface JiraIssueSummary {
  id: string
  key: string
  self?: string
  fields: {
    summary?: string
    labels?: string[]
    status?: JiraNamedValue
    issuetype?: JiraNamedValue
    priority?: JiraNamedValue
    assignee?: JiraUser | null
    reporter?: JiraUser | null
    created?: string
    updated?: string
    project?: JiraProjectRef
  }
}

export interface JiraSearchResponse {
  startAt: number
  maxResults: number
  total: number
  issues: JiraIssueSummary[]
}

export interface JiraAttachment {
  id: string
  filename: string
  size?: number
  mimeType?: string
  /** Absolute download URL, already carrying the instance host. */
  content: string
  created?: string
  author?: JiraUser
}

export interface JiraLinkedIssue {
  key?: string
  fields?: {
    summary?: string
    status?: JiraNamedValue
    issuetype?: JiraNamedValue
    priority?: JiraNamedValue
  }
}

export interface JiraIssueLink {
  id?: string
  type?: {
    name?: string
    inward?: string
    outward?: string
  }
  outwardIssue?: JiraLinkedIssue
  inwardIssue?: JiraLinkedIssue
}

export interface JiraComment {
  id: string
  author?: JiraUser
  /** Jira wiki markup (Server/DC — not ADF). */
  body?: string
  created?: string
  updated?: string
}

export interface JiraCommentContainer {
  startAt?: number
  maxResults?: number
  total?: number
  comments: JiraComment[]
}

export interface JiraChangelogItem {
  field?: string
  fieldtype?: string
  from?: string | null
  fromString?: string | null
  to?: string | null
  toString?: string | null
}

export interface JiraChangelogHistory {
  id: string
  author?: JiraUser
  created?: string
  items: JiraChangelogItem[]
}

export interface JiraChangelog {
  startAt?: number
  maxResults?: number
  total?: number
  histories: JiraChangelogHistory[]
}

export interface JiraIssueFullFields {
  summary?: string
  labels?: string[]
  description?: string | null
  status?: JiraNamedValue
  issuetype?: JiraNamedValue
  priority?: JiraNamedValue
  assignee?: JiraUser | null
  reporter?: JiraUser | null
  created?: string
  updated?: string
  project?: JiraProjectRef
  attachment?: JiraAttachment[]
  issuelinks?: JiraIssueLink[]
  comment?: JiraCommentContainer
  /** Custom fields (e.g. the 「任务过程描述」 field) arrive under their `customfield_*` id. */
  [fieldId: string]: unknown
}

export interface JiraIssueFull {
  id: string
  key: string
  self?: string
  fields: JiraIssueFullFields
  changelog?: JiraChangelog
}

export interface JiraServerInfo {
  baseUrl?: string
  version?: string
  versionNumbers?: number[]
  serverTitle?: string
  deploymentType?: string
}

/** Why a Jira request failed, in terms the view can act on. */
export type JiraErrorKind = "config" | "auth" | "not-found" | "network" | "http"

/**
 * Which dimensions a text query is searched against — each one is a checkbox
 * in the Jira view. All on by default; unchecking everything means the query
 * contributes no text clause (browse mode).
 */
export interface JiraSearchDimensions {
  /** `summary ~ "term*"` + client-side substring match on the title. */
  title: boolean
  /** `text ~ "term*"` (full text) + client-side fallback over title and labels. */
  keyword: boolean
  /** `issuekey = X` / `issuekey in (X, Y)` when the query parses as issue keys. */
  issueKey: boolean
}

export const DEFAULT_JIRA_SEARCH_DIMENSIONS: JiraSearchDimensions = {
  title: true,
  keyword: true,
  issueKey: true,
}
