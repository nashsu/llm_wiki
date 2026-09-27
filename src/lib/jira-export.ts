/**
 * Fetch one issue and write it into the project as a fixed-format Markdown
 * file plus its downloaded attachments.
 *
 * Two properties this module is responsible for:
 *
 *  1. **Nothing is written before the user has agreed to it.** A second export
 *     of an already-exported issue returns `needs-confirm` without touching the
 *     disk; the caller re-runs with `overwrite: true` only after a dialog.
 *  2. **The document is written last.** Attachments go down first, so the md
 *     file never references a file that is still being downloaded, and a
 *     failure midway leaves no half-finished source in the tree.
 *
 * This module deliberately does NOT enqueue LLM ingest (there is a test that
 * asserts it). The file lands in `raw/sources`, so the background watcher may
 * pick it up on its own — that is accepted behaviour, not something the export
 * should be doing behind the user's back.
 */

import { deleteFile, listDirectory, writeFile, writeFileBase64 } from "@/commands/fs"
import { JiraApiError, JiraClient, bytesToBase64 } from "@/lib/jira-api"
import { isJiraConfigured, jiraAttachmentsDirName, resolveJiraExportDir } from "@/lib/jira-config"
import {
  buildJiraExportFileName,
  findExportsForIssue,
  parseJiraExportFileName,
  sanitizeJiraFileSegment,
} from "@/lib/jira-filename"
import { buildJiraMarkdown, type JiraExportedAttachment } from "@/lib/jira-markdown"
import { joinPath, normalizePath } from "@/lib/path-utils"
import type { JiraConfig } from "@/stores/wiki-store"
import type { JiraErrorKind, JiraIssueFull } from "@/types/jira"

/** Fields a full export asks for. The process custom field is appended when set. */
const EXPORT_FIELDS = [
  "summary",
  "labels",
  "description",
  "status",
  "assignee",
  "reporter",
  "created",
  "updated",
  "issuetype",
  "priority",
  "project",
  "attachment",
  "issuelinks",
  "comment",
]

const COMMENT_PAGE_SIZE = 100
/** Backstop so a misbehaving `total` can't spin forever. */
const MAX_COMMENTS = 2000

export interface JiraExportProgress {
  phase: "fetching" | "attachments" | "writing"
  completed: number
  total: number
}

export interface JiraExportResult {
  status: "exported" | "needs-confirm" | "error"
  key: string
  /** Path of the file just written. */
  path?: string
  /** Path that already exists and needs confirmation before it is replaced. */
  existingPath?: string
  attachments?: JiraExportedAttachment[]
  errorKind?: JiraErrorKind
  error?: string
}

export interface ExportedJiraIssue {
  key: string
  title: string
  date: string
  path: string
  /** Older exports of the same issue, still on disk. Surfaced, never hidden. */
  olderPaths: string[]
}

async function listExportDirFileNames(exportDir: string): Promise<string[]> {
  try {
    // Direct children only — descending would walk into `KEY.attachments/`.
    const entries = await listDirectory(exportDir, { maxDepth: 1 })
    return entries.filter((entry) => !entry.is_dir).map((entry) => entry.name)
  } catch {
    // Directory not created yet.
    return []
  }
}

function describeError(error: unknown): { errorKind: JiraErrorKind; error: string } {
  if (error instanceof JiraApiError) return { errorKind: error.kind, error: error.describe() }
  return { errorKind: "network", error: error instanceof Error ? error.message : String(error) }
}

/** Collapse the paginated comment list into one array, up to the backstop. */
async function fetchAllComments(
  client: JiraClient,
  issue: JiraIssueFull,
  signal: AbortSignal | undefined,
): Promise<JiraIssueFull> {
  const container = issue.fields?.comment
  if (!container) return issue
  const comments = [...(container.comments ?? [])]
  let total = container.total ?? comments.length
  while (comments.length < total && comments.length < MAX_COMMENTS) {
    const page = await client.getCommentsPage(issue.key, comments.length, COMMENT_PAGE_SIZE, signal)
    if (page.comments.length === 0) break
    comments.push(...page.comments)
    total = page.total
  }
  return {
    ...issue,
    fields: { ...issue.fields, comment: { ...container, comments, total } },
  }
}

/** Two attachments can share a filename; the second keeps its id as a prefix. */
function uniqueAttachmentName(
  fileName: string,
  used: Set<string>,
  attachmentId: string,
): string {
  if (!used.has(fileName.toLowerCase())) {
    used.add(fileName.toLowerCase())
    return fileName
  }
  const candidate = sanitizeJiraFileSegment(`${attachmentId} ${fileName}`, { fallback: "attachment" })
  used.add(candidate.toLowerCase())
  return candidate
}

export async function exportJiraIssue(params: {
  projectPath: string
  key: string
  config: JiraConfig
  overwrite?: boolean
  onProgress?: (progress: JiraExportProgress) => void
  signal?: AbortSignal
  client?: JiraClient
  /** Injectable clock, so tests get a deterministic file name. */
  now?: Date
}): Promise<JiraExportResult> {
  const { projectPath, key, config, onProgress, signal } = params
  const now = params.now ?? new Date()
  if (!isJiraConfigured(config)) {
    return { status: "error", key, errorKind: "config" }
  }

  const exportDir = resolveJiraExportDir(projectPath, config.exportDir)

  try {
    const existingNames = await listExportDirFileNames(exportDir)
    const existing = findExportsForIssue(existingNames, key)
    if (existing.length > 0 && !params.overwrite) {
      return { status: "needs-confirm", key, existingPath: joinPath(exportDir, existing[0]) }
    }

    const client = params.client ?? new JiraClient(config)
    const requestedFields = config.processFieldId
      ? [...EXPORT_FIELDS, config.processFieldId]
      : EXPORT_FIELDS

    onProgress?.({ phase: "fetching", completed: 0, total: 1 })
    const fetched = await client.getIssue(key, requestedFields, { expandChangelog: true, signal })
    const issue = await fetchAllComments(client, fetched, signal)
    onProgress?.({ phase: "fetching", completed: 1, total: 1 })

    const resolvedKey = issue.key || key
    const attachmentDirName = jiraAttachmentsDirName(resolvedKey)
    const attachments = issue.fields?.attachment ?? []
    const exportedAttachments: JiraExportedAttachment[] = []
    const usedNames = new Set<string>()

    for (const [index, attachment] of attachments.entries()) {
      onProgress?.({ phase: "attachments", completed: index, total: attachments.length })
      const sizeBytes = attachment.size
      const overLimit =
        typeof sizeBytes === "number" && sizeBytes > config.maxAttachmentMb * 1024 * 1024
      if (overLimit) {
        exportedAttachments.push({
          id: attachment.id,
          filename: attachment.filename,
          sizeBytes,
          mimeType: attachment.mimeType,
          status: "skipped",
          detail: `超出大小上限 ${(sizeBytes! / (1024 * 1024)).toFixed(1)} MB > ${config.maxAttachmentMb} MB`,
        })
        continue
      }
      const fileName = uniqueAttachmentName(
        sanitizeJiraFileSegment(attachment.filename, { fallback: `attachment-${attachment.id}` }),
        usedNames,
        attachment.id,
      )
      try {
        const bytes = await client.downloadAttachment(attachment, signal)
        await writeFileBase64(joinPath(exportDir, attachmentDirName, fileName), bytesToBase64(bytes))
        exportedAttachments.push({
          id: attachment.id,
          filename: attachment.filename,
          relativePath: `./${attachmentDirName}/${fileName}`,
          sizeBytes: typeof sizeBytes === "number" ? sizeBytes : bytes.byteLength,
          mimeType: attachment.mimeType,
          status: "downloaded",
        })
      } catch (error) {
        // One forbidden attachment must not fail the whole export.
        exportedAttachments.push({
          id: attachment.id,
          filename: attachment.filename,
          sizeBytes,
          mimeType: attachment.mimeType,
          status: "failed",
          detail: `下载失败: ${error instanceof JiraApiError ? `HTTP ${error.status}` : (error as Error).message}`,
        })
      }
    }
    if (attachments.length > 0) {
      onProgress?.({ phase: "attachments", completed: attachments.length, total: attachments.length })
    }

    // Reuse the existing file name on an overwrite: the name is this source's
    // identity to the ingest cache, so re-dating it would make the issue look
    // like a brand-new source instead of an update.
    const fileName =
      existing[0] ??
      buildJiraExportFileName(now, resolvedKey, issue.fields?.summary ?? "", "md")
    const filePath = joinPath(exportDir, fileName)
    const markdown = buildJiraMarkdown({
      issue,
      baseUrl: config.baseUrl,
      exportedAt: now,
      processValue: config.processFieldId
        ? issue.fields?.[config.processFieldId]
        : undefined,
      attachments: exportedAttachments,
    })

    onProgress?.({ phase: "writing", completed: 0, total: 1 })
    await writeFile(filePath, markdown)

    // Only the *name* changed files are cleaned up; `KEY.attachments/` is a
    // reusable cache and stays.
    for (const staleName of existing) {
      if (staleName === fileName) continue
      try {
        await deleteFile(joinPath(exportDir, staleName))
      } catch {
        // Already gone, or locked — the new file is written either way.
      }
    }
    onProgress?.({ phase: "writing", completed: 1, total: 1 })

    return { status: "exported", key: resolvedKey, path: filePath, attachments: exportedAttachments }
  } catch (error) {
    return { status: "error", key, ...describeError(error) }
  }
}

/**
 * Discover what has already been exported by reading the directory and parsing
 * file names — no index file, because an index goes stale the moment the user
 * renames or deletes something outside the app, and the name already carries
 * the date, key and title losslessly.
 */
export async function listExportedJiraIssues(exportDir: string): Promise<ExportedJiraIssue[]> {
  let entries
  try {
    entries = await listDirectory(exportDir, { maxDepth: 1 })
  } catch {
    return []
  }
  const byKey = new Map<string, { name: string; path: string }[]>()
  for (const entry of entries) {
    if (entry.is_dir || !entry.name.toLowerCase().endsWith(".md")) continue
    const parsed = parseJiraExportFileName(entry.name)
    if (!parsed) continue
    const list = byKey.get(parsed.key) ?? []
    list.push({ name: entry.name, path: normalizePath(entry.path) })
    byKey.set(parsed.key, list)
  }

  const exported: ExportedJiraIssue[] = []
  for (const [issueKey, files] of byKey) {
    const ordered = findExportsForIssue(files.map((file) => file.name), issueKey)
    const newestName = ordered[0]
    const newest = files.find((file) => file.name === newestName)
    const parsed = parseJiraExportFileName(newestName)
    if (!newest || !parsed) continue
    exported.push({
      key: issueKey,
      title: parsed.title,
      date: parsed.date,
      path: newest.path,
      olderPaths: ordered
        .slice(1)
        .map((name) => files.find((file) => file.name === name)?.path)
        .filter((path): path is string => typeof path === "string"),
    })
  }
  return exported.sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? 1 : -1
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  })
}
