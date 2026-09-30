/**
 * Jira connection/export defaults and the pure path/URL helpers built on them.
 *
 * Mirrors the `jira-commit` skill's setup: Server/Data Center, REST API v2,
 * username + password over HTTP Basic, TLS verification off. Credentials are
 * stored in plain text in `app-state.json`, like every other token this app
 * keeps — see the warning in the settings section.
 */

import { isAbsolutePath, joinPath, normalizePath } from "@/lib/path-utils"
import type { JiraConfig } from "@/stores/wiki-store"
import { DEFAULT_JIRA_SEARCH_DIMENSIONS } from "@/types/jira"

export const JIRA_DEFAULT_BASE_URL = "https://jira.cvte.com"
export const JIRA_DEFAULT_EXPORT_DIR = "raw/sources/Collection/JIRA"
/** The skill's UA already gets past the corporate WAF, so keep it as the default. */
export const JIRA_DEFAULT_USER_AGENT = "JIRA-Connection-Test/1.0"

export const DEFAULT_JIRA_CONFIG: JiraConfig = {
  baseUrl: JIRA_DEFAULT_BASE_URL,
  username: "",
  password: "",
  processFieldId: "",
  exportDir: JIRA_DEFAULT_EXPORT_DIR,
  scopeJql: "",
  matchCase: false,
  searchDims: { ...DEFAULT_JIRA_SEARCH_DIMENSIONS },
  acceptInvalidCerts: true,
  userAgent: JIRA_DEFAULT_USER_AGENT,
  maxAttachmentMb: 50,
  sweepPageSize: 200,
  maxSweepIssues: 1000,
  sweepThreshold: 20,
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function trimmed(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback
}

/** Trailing slashes are dropped so `jiraApiUrl` never emits a doubled slash. */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

/**
 * Coerce a stored (or partially typed) config into a usable one. Numeric limits
 * are clamped rather than rejected — a bad stored value should not leave the
 * user with an unusable settings page.
 *
 * The password is deliberately *not* trimmed: leading/trailing spaces can be
 * part of a real password.
 */
export function normalizeJiraConfig(input?: Partial<JiraConfig> | null): JiraConfig {
  const merged = { ...DEFAULT_JIRA_CONFIG, ...(input ?? {}) }
  return {
    baseUrl: normalizeBaseUrl(merged.baseUrl),
    username: merged.username.trim(),
    password: typeof merged.password === "string" ? merged.password : "",
    processFieldId: merged.processFieldId.trim(),
    exportDir: trimmed(merged.exportDir) || JIRA_DEFAULT_EXPORT_DIR,
    scopeJql: merged.scopeJql.trim(),
    matchCase: merged.matchCase === true,
    // Each checkbox defaults to on; a missing/invalid stored value re-enables it.
    searchDims: {
      title: merged.searchDims?.title !== false,
      keyword: merged.searchDims?.keyword !== false,
      issueKey: merged.searchDims?.issueKey !== false,
    },
    acceptInvalidCerts: merged.acceptInvalidCerts !== false,
    userAgent: trimmed(merged.userAgent) || JIRA_DEFAULT_USER_AGENT,
    maxAttachmentMb: clampInt(merged.maxAttachmentMb, DEFAULT_JIRA_CONFIG.maxAttachmentMb, 1, 2048),
    sweepPageSize: clampInt(merged.sweepPageSize, DEFAULT_JIRA_CONFIG.sweepPageSize, 25, 200),
    maxSweepIssues: clampInt(merged.maxSweepIssues, DEFAULT_JIRA_CONFIG.maxSweepIssues, 100, 5000),
    sweepThreshold: clampInt(merged.sweepThreshold, DEFAULT_JIRA_CONFIG.sweepThreshold, 0, 500),
  }
}

/** `https://host/rest/api/2/<path>` — the only REST prefix this app talks to. */
export function jiraApiUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl)
  const suffix = path.replace(/^\/+/, "")
  return `${base}/rest/api/2/${suffix}`
}

/** The human-facing issue page — what the card's Jira button opens. */
export function jiraBrowseUrl(baseUrl: string, key: string): string {
  const base = normalizeBaseUrl(baseUrl)
  return `${base}/browse/${encodeURIComponent(key)}`
}

/**
 * Absolute export dirs are used as-is; relative ones resolve against the
 * project root (`raw/sources/Collection/JIRA` is the default, and it must stay
 * inside the project so the source tree and watcher see it).
 */
export function resolveJiraExportDir(projectPath: string, exportDir: string): string {
  const dir = exportDir.trim() || JIRA_DEFAULT_EXPORT_DIR
  if (isAbsolutePath(dir)) return normalizePath(dir)
  const root = normalizePath(projectPath ?? "").replace(/\/+$/, "")
  if (!root) return normalizePath(dir)
  return joinPath(root, dir)
}

/** Attachment subdirectory for one issue, kept next to its md file. */
export function jiraAttachmentsDirName(key: string): string {
  return `${key}.attachments`
}

export function isJiraConfigured(config: JiraConfig): boolean {
  return (
    config.baseUrl.trim().length > 0 &&
    config.username.trim().length > 0 &&
    config.password.length > 0
  )
}
