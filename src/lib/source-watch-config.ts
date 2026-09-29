import type { SourceWatchConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { clampUserConcurrency } from "@/lib/concurrency-limits"
import sourceWatchDefaults from "@/lib/source-watch-defaults.json"

export const DEFAULT_SOURCE_WATCH_CONFIG: SourceWatchConfig = sourceWatchDefaults

/** Normalize any path (absolute or project-relative) to a stable key relative
 *  to the project's raw/sources root, so exclusions match regardless of the
 *  path form a call site passes in. */
export function sourceRelativeKey(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, "")
  const marker = "/raw/sources/"
  const idx = normalized.indexOf(marker)
  if (idx >= 0) return normalized.slice(idx + marker.length).replace(/^\/+/, "")
  if (normalized.startsWith("raw/sources/")) return normalized.slice("raw/sources/".length)
  return normalized.replace(/^\/+/, "")
}

function normalizeExcludedPaths(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => sourceRelativeKey(value)).filter(Boolean))]
}

export const SOURCE_WATCH_FILE_TYPE_GROUPS = [
  {
    id: "documents",
    extensions: ["md", "mdx", "txt", "org", "pdf", "doc", "docx", "docm", "odt", "rtf", "epub", "mobi"],
  },
  {
    id: "presentations",
    extensions: ["ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm", "odp"],
  },
  {
    id: "spreadsheets",
    extensions: ["xls", "xlsx", "xlsm", "xlsb", "ods", "csv"],
  },
  {
    id: "web",
    extensions: ["html", "htm"],
  },
  {
    id: "data",
    extensions: ["json", "yaml", "yml", "xml"],
  },
  {
    id: "images",
    extensions: ["png", "jpg", "jpeg"],
  },
]

const SOURCE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"] as const
const LEGACY_DEFAULT_INCLUDE_EXTENSIONS = sourceWatchDefaults.includeExtensions.filter(
  (extension) => !SOURCE_IMAGE_EXTENSIONS.includes(extension as typeof SOURCE_IMAGE_EXTENSIONS[number]),
)

function normalizeExtensions(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .flatMap((value) => value.split(/[,，\n]/))
    .map((value) => value.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean))]
}

function normalizeList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .flatMap((value) => value.split(/[,，\n]/))
    .map((value) => value.trim())
    .filter(Boolean))]
}

export function normalizeSourceWatchConfig(config?: Partial<SourceWatchConfig> | null): SourceWatchConfig {
  const rawParsingConcurrency = config?.parsingConcurrency
    ?? DEFAULT_SOURCE_WATCH_CONFIG.parsingConcurrency
  const parsingConcurrency = Number.isFinite(rawParsingConcurrency)
    ? clampUserConcurrency(rawParsingConcurrency)
    : DEFAULT_SOURCE_WATCH_CONFIG.parsingConcurrency
  const rawIngestConcurrency = config?.ingestConcurrency
    ?? DEFAULT_SOURCE_WATCH_CONFIG.ingestConcurrency
  const ingestConcurrency = Number.isFinite(rawIngestConcurrency)
    ? clampUserConcurrency(rawIngestConcurrency)
    : DEFAULT_SOURCE_WATCH_CONFIG.ingestConcurrency
  const includeExtensions = normalizeExtensions(
    config?.includeExtensions ?? DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions,
  )
  const usesLegacyDefaults = includeExtensions.length === LEGACY_DEFAULT_INCLUDE_EXTENSIONS.length
    && LEGACY_DEFAULT_INCLUDE_EXTENSIONS.every((extension) => includeExtensions.includes(extension))
  return {
    enabled: config?.enabled ?? DEFAULT_SOURCE_WATCH_CONFIG.enabled,
    autoIngest: config?.autoIngest ?? DEFAULT_SOURCE_WATCH_CONFIG.autoIngest,
    persistExtractedMarkdown:
      config?.persistExtractedMarkdown ?? DEFAULT_SOURCE_WATCH_CONFIG.persistExtractedMarkdown,
    parsingConcurrency,
    ingestConcurrency,
    includeExtensions: usesLegacyDefaults
      ? [...includeExtensions, ...SOURCE_IMAGE_EXTENSIONS]
      : includeExtensions,
    excludeExtensions: normalizeExtensions(config?.excludeExtensions ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeExtensions),
    excludeDirs: normalizeList(config?.excludeDirs ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeDirs),
    excludeGlobs: normalizeList(config?.excludeGlobs ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeGlobs),
    excludedPaths: normalizeExcludedPaths(config?.excludedPaths ?? DEFAULT_SOURCE_WATCH_CONFIG.excludedPaths),
    maxFileSizeMb: Math.max(1, Math.min(4096, config?.maxFileSizeMb ?? DEFAULT_SOURCE_WATCH_CONFIG.maxFileSizeMb)),
  }
}

export function getSourceWatchExtension(path: string): string {
  const name = normalizePath(path).split("/").pop() ?? ""
  if (!name || !name.includes(".")) return ""
  return name.split(".").pop()?.toLowerCase() ?? ""
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i")
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalized = normalizePath(path)
  const name = normalized.split("/").pop() ?? normalized
  const re = wildcardToRegExp(pattern)
  return re.test(name) || re.test(normalized)
}

function pathMatchesExcludedDir(path: string, excludedDir: string): boolean {
  const normalized = normalizePath(path).toLowerCase()
  const dir = normalizePath(excludedDir).toLowerCase()
  if (!dir) return false
  if (dir.includes("/")) {
    return normalized === dir || normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`)
  }
  return normalized.split("/").some((part) => part === dir)
}

export function isPathAllowedBySourceWatch(path: string, config: SourceWatchConfig): boolean {
  const cfg = normalizeSourceWatchConfig(config)
  const normalized = normalizePath(path)
  const parts = normalized.split("/").filter(Boolean)
  if (cfg.excludeDirs.some((dir) => pathMatchesExcludedDir(normalized, dir))) return false
  if (cfg.excludeGlobs.some((pattern) => matchesGlob(normalized, pattern))) return false
  const key = sourceRelativeKey(normalized)
  if (cfg.excludedPaths.some((ex) => key === ex || key.startsWith(`${ex}/`))) return false
  const name = parts[parts.length - 1] ?? ""
  if (!name || name.startsWith(".")) return false
  const ext = getSourceWatchExtension(normalized)
  if (ext && cfg.excludeExtensions.includes(ext)) return false
  if (cfg.includeExtensions.length > 0 && (!ext || !cfg.includeExtensions.includes(ext))) {
    return false
  }
  return true
}
