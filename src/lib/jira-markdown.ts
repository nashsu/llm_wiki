/**
 * The exported document: a fixed seven-section Markdown file.
 *
 * Section headings are always Chinese and always present, in this order —
 * the file is a record meant to be read and diffed, so its shape must not
 * change with the UI language or with which fields an issue happens to fill.
 * Empty sections get `_（无）_` rather than disappearing.
 */

import { formatJiraExportDate } from "@/lib/jira-filename"
import { jiraBrowseUrl } from "@/lib/jira-config"
import {
  jiraWikiToMarkdown,
  markdownLinkDestination,
  type JiraMarkupContext,
} from "@/lib/jira-wiki-markup"
import type { JiraChangelogHistory, JiraComment, JiraIssueFull, JiraUser } from "@/types/jira"

export const JIRA_MD_SECTIONS = ["标题", "标签", "任务过程描述", "描述", "附件", "问题链接", "活动"] as const

/** Rendered in every section that has nothing to show. */
export const JIRA_MD_EMPTY = "_（无）_"

/** Outcome of one attachment, as far as the document is concerned. */
export interface JiraExportedAttachment {
  id: string
  filename: string
  /** Relative path from the md file — present only when the bytes were written. */
  relativePath?: string
  sizeBytes?: number
  mimeType?: string
  status: "downloaded" | "skipped" | "failed"
  /** Why it was skipped/failed. Always rendered as text, never as a link. */
  detail?: string
}

export interface JiraActivityChange {
  field: string
  from: string
  to: string
}

export interface JiraActivityEntry {
  id: string
  kind: "comment" | "change"
  timestamp: string
  author: string
  body?: string
  editedAt?: string
  changes?: JiraActivityChange[]
}

export interface BuildJiraMarkdownInput {
  issue: JiraIssueFull
  baseUrl: string
  exportedAt: Date
  /** Value of the 「任务过程描述」 custom field, if one is configured. */
  processValue?: unknown
  attachments: readonly JiraExportedAttachment[]
}

/** Jira emits `+0800`; `Date.parse` wants `+08:00`. */
function parseJiraDate(value: string): number | null {
  if (!value) return null
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
  const parsed = Date.parse(normalized)
  return Number.isNaN(parsed) ? null : parsed
}

function pad2(value: number): string {
  return `${value}`.padStart(2, "0")
}

export function formatJiraTimestamp(date: Date): string {
  return `${formatJiraExportDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** Falls back to the raw Jira string when it cannot be parsed — never blank. */
export function formatJiraActivityTime(raw: string): string {
  const parsed = parseJiraDate(raw)
  return parsed === null ? raw : formatJiraTimestamp(new Date(parsed))
}

function displayName(user: JiraUser | undefined): string {
  return user?.displayName || user?.name || user?.key || "未知"
}

/**
 * Comments and field changes on one ascending timeline. Ties break on entry id
 * so the document is byte-stable across exports.
 */
export function buildActivityTimeline(input: {
  comments?: readonly JiraComment[]
  histories?: readonly JiraChangelogHistory[]
}): JiraActivityEntry[] {
  const entries: JiraActivityEntry[] = []
  for (const comment of input.comments ?? []) {
    entries.push({
      id: `comment-${comment.id}`,
      kind: "comment",
      timestamp: comment.created ?? "",
      author: displayName(comment.author),
      body: comment.body ?? "",
      editedAt:
        comment.updated && comment.updated !== comment.created ? comment.updated : undefined,
    })
  }
  for (const history of input.histories ?? []) {
    const changes = (history.items ?? []).map((item) => ({
      field: item.field ?? "",
      from: item.fromString ?? item.from ?? "",
      to: item.toString ?? item.to ?? "",
    }))
    if (changes.length === 0) continue
    entries.push({
      id: `change-${history.id}`,
      kind: "change",
      timestamp: history.created ?? "",
      author: displayName(history.author),
      changes,
    })
  }
  return entries.sort((left, right) => {
    const leftTime = parseJiraDate(left.timestamp)
    const rightTime = parseJiraDate(right.timestamp)
    if (leftTime !== null && rightTime !== null) {
      if (leftTime !== rightTime) return leftTime - rightTime
    } else if (left.timestamp !== right.timestamp) {
      return left.timestamp < right.timestamp ? -1 : 1
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

export function formatAttachmentSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "大小未知"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9_.\-/]+$/.test(value) ? value : JSON.stringify(value)
}

/** Cell text is escaped rather than converted — nothing in a summary is markup. */
function escapeTableCell(value: string): string {
  return value
    .replace(/\|/g, "\\|")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A custom field or description arrives as wiki markup on Server/DC, but a
 * migrated instance could hand back ADF or some other JSON shape. Anything
 * non-string goes into the file as JSON rather than being dropped — a fence of
 * JSON is a poor rendering, but losing the content would be worse.
 */
function renderRichValue(value: unknown, context: JiraMarkupContext): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return jiraWikiToMarkdown(value, context).trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n")
}

function renderAttachments(attachments: readonly JiraExportedAttachment[]): string {
  if (attachments.length === 0) return JIRA_MD_EMPTY
  return attachments
    .map((attachment) => {
      const name = attachment.relativePath
        ? `[${attachment.filename}](${markdownLinkDestination(attachment.relativePath)})`
        : attachment.filename
      const detail = attachment.detail ? ` （${attachment.detail}）` : ""
      const type = attachment.mimeType || "application/octet-stream"
      return `- ${name}${detail} （${type}, ${formatAttachmentSize(attachment.sizeBytes)}）`
    })
    .join("\n")
}

function renderIssueLinks(issue: JiraIssueFull, baseUrl: string): string {
  const rows: string[][] = []
  for (const link of issue.fields?.issuelinks ?? []) {
    const type = link.type?.name ?? ""
    for (const [direction, linked] of [
      ["outward", link.outwardIssue],
      ["inward", link.inwardIssue],
    ] as const) {
      if (!linked?.key) continue
      rows.push([
        type,
        direction,
        `[${linked.key}](${jiraBrowseUrl(baseUrl, linked.key)})`,
        linked.fields?.status?.name ?? "",
        linked.fields?.summary ?? "",
      ])
    }
  }
  if (rows.length === 0) return JIRA_MD_EMPTY
  const header = ["类型", "方向", "关联问题", "状态", "摘要"]
  const body = rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`)
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body,
  ].join("\n")
}

function renderActivity(entries: readonly JiraActivityEntry[], context: JiraMarkupContext): string {
  if (entries.length === 0) return JIRA_MD_EMPTY
  return entries
    .map((entry) => {
      const kind = entry.kind === "comment" ? "评论" : "字段变更"
      const edited = entry.editedAt ? ` | 已编辑 ${formatJiraActivityTime(entry.editedAt)}` : ""
      const heading = `### ${formatJiraActivityTime(entry.timestamp)} — ${entry.author}（${kind}${edited}）`
      if (entry.kind === "comment") {
        const body = jiraWikiToMarkdown(entry.body ?? "", context).trim() || JIRA_MD_EMPTY
        return `${heading}\n\n${body}`
      }
      const changes = (entry.changes ?? [])
        .map(
          (change) =>
            `${change.field || "字段"}: ${change.from || JIRA_MD_EMPTY} → ${change.to || JIRA_MD_EMPTY}`,
        )
        .join(", ")
      return `${heading}\n\n${changes || JIRA_MD_EMPTY}`
    })
    .join("\n\n")
}

export function buildJiraMarkdown(input: BuildJiraMarkdownInput): string {
  const { issue, baseUrl, exportedAt } = input
  const fields = issue.fields ?? {}
  const summary = (fields.summary ?? "").trim()
  const labels = fields.labels ?? []
  const browseUrl = baseUrl.trim() ? jiraBrowseUrl(baseUrl, issue.key) : ""

  const attachmentLinks = new Map<string, string>()
  for (const attachment of input.attachments) {
    if (attachment.relativePath) attachmentLinks.set(attachment.filename, attachment.relativePath)
  }
  const context: JiraMarkupContext = { attachmentLinks, baseUrl }

  const frontmatter = [
    "---",
    "source: jira",
    `issue: ${issue.key}`,
    ...(browseUrl ? [`url: ${browseUrl}`] : []),
    `exported_at: ${formatJiraTimestamp(exportedAt)}`,
    ...(labels.length > 0
      ? ["labels:", ...labels.map((label) => `  - ${yamlScalar(label)}`)]
      : ["labels: []"]),
    "---",
  ].join("\n")

  // Keyed by the section constant so a missing section is a type error, and the
  // document order is the constant's own order.
  const sections: Record<(typeof JIRA_MD_SECTIONS)[number], string> = {
    标题: summary || JIRA_MD_EMPTY,
    标签: labels.length > 0 ? labels.map((label) => `- \`${label}\``).join("\n") : JIRA_MD_EMPTY,
    任务过程描述: renderRichValue(input.processValue, context) || JIRA_MD_EMPTY,
    描述: renderRichValue(fields.description, context) || JIRA_MD_EMPTY,
    附件: renderAttachments(input.attachments),
    问题链接: renderIssueLinks(issue, baseUrl),
    活动: renderActivity(
      buildActivityTimeline({
        comments: fields.comment?.comments,
        histories: issue.changelog?.histories,
      }),
      context,
    ),
  }

  const body = JIRA_MD_SECTIONS.map((heading) => `## ${heading}\n\n${sections[heading]}`).join("\n\n")
  const intro = `> 导出时间: ${formatJiraTimestamp(exportedAt)}${browseUrl ? ` · 来源: ${browseUrl}` : ""}`

  return `${frontmatter}\n\n# ${issue.key}${summary ? ` ${summary}` : ""}\n\n${intro}\n\n${body}\n`
}
