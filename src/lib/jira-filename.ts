/**
 * Naming and discovery of exported issue files.
 *
 * `<项目>/raw/sources/Collection/JIRA/2026-09-27 AERDM-1234 DAB_box 收音.md`
 *
 * The exported file is also a *source* for the wiki, so its name carries the
 * issue identity: existing exports are discovered by parsing directory
 * listings for this exact shape rather than by maintaining an index file (an
 * index goes stale the moment the user deletes a file behind the app's back).
 */

const JIRA_EXPORT_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2}) ([A-Z][A-Z0-9_]*-\d+) (.+)\.md$/

/** Windows forbids these as a whole filename stem, case-insensitively. */
const RESERVED_FILE_STEMS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

/** C0 controls are illegal in filenames along with the reserved punctuation. */
const ILLEGAL_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

export const JIRA_FILE_SEGMENT_MAX_LENGTH = 80

/**
 * Make one path segment safe on Windows *without* mangling it: unlike the
 * URL-import `safeSlug`, spaces are preserved and case untouched, because the
 * title here is real user-visible text (`DAB_box 收音`, not `DAB-box-收音`).
 */
export function sanitizeJiraFileSegment(
  value: string,
  options: { maxLength?: number; fallback?: string } = {},
): string {
  const maxLength = options.maxLength ?? JIRA_FILE_SEGMENT_MAX_LENGTH
  const fallback = options.fallback ?? "untitled"
  let segment = (value ?? "").replace(ILLEGAL_FILE_CHARS, " ").replace(/\s+/g, " ").trim()
  // Truncate by code point so a surrogate pair is never split in half.
  const codePoints = Array.from(segment)
  if (codePoints.length > maxLength) segment = codePoints.slice(0, maxLength).join("")
  // A truncation can leave a trailing dot/space, which Windows silently strips.
  segment = segment.replace(/[. ]+$/, "").trim()
  if (!segment) return fallback
  if (RESERVED_FILE_STEMS.has(segment.toLowerCase())) return `${segment}_`
  return segment
}

/** Local-time `YYYY-MM-DD` — the date in the name should be the user's today, not UTC's. */
export function formatJiraExportDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function buildJiraExportFileName(
  exportDate: Date,
  key: string,
  summary: string,
  ext = "md",
): string {
  const date = formatJiraExportDate(exportDate)
  const safeKey = sanitizeJiraFileSegment(key, { fallback: "ISSUE" })
  const title = sanitizeJiraFileSegment(summary, { fallback: "untitled" })
  return `${date} ${safeKey} ${title}.${ext}`
}

export interface ParsedJiraExportName {
  date: string
  key: string
  title: string
}

/** Returns `null` for anything that is not exactly the shape we write. */
export function parseJiraExportFileName(fileName: string): ParsedJiraExportName | null {
  const match = JIRA_EXPORT_NAME_PATTERN.exec(fileName.trim())
  if (!match) return null
  return { date: match[1], key: match[2], title: match[3] }
}

/**
 * Every known export of one issue, newest first.
 *
 * The key is compared exactly, so `JIRA-123` never picks up `JIRA-1234`.
 */
export function findExportsForIssue(fileNames: readonly string[], key: string): string[] {
  return fileNames
    .filter((fileName) => parseJiraExportFileName(fileName)?.key === key)
    .sort((a, b) => {
      const left = parseJiraExportFileName(a)!
      const right = parseJiraExportFileName(b)!
      if (left.date !== right.date) return left.date < right.date ? 1 : -1
      return a < b ? 1 : -1
    })
}
