import type { SourceWatchConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import sourceWatchDefaults from "@/lib/source-watch-defaults.json"
import { AUDIO_VIDEO_SOURCE_EXTENSIONS, IMAGE_SOURCE_EXTENSIONS } from "@/lib/media-extensions"

export const DEFAULT_SOURCE_WATCH_CONFIG: SourceWatchConfig = sourceWatchDefaults

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
    id: "images",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "avif", "heic"],
  },
  {
    id: "media",
    extensions: ["mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a"],
  },
  {
    id: "data",
    extensions: ["json", "yaml", "yml", "xml"],
  },
]

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

/**
 * Media extensions are unioned into a persisted include-list so a config saved
 * before media ingest existed cannot shadow them and make the watcher drop
 * media before `isIngestableSourcePath` (the real toggle gate) runs. An empty
 * include-list means "no extension filter" (see `importSourceFiles`), so it is
 * left empty — unioning there would turn an allow-all into a media-only list.
 */
function withMediaExtensions(includeExtensions: readonly string[]): string[] {
  if (includeExtensions.length === 0) return []
  return normalizeExtensions([
    ...includeExtensions,
    ...AUDIO_VIDEO_SOURCE_EXTENSIONS,
    ...IMAGE_SOURCE_EXTENSIONS,
  ])
}

export function normalizeSourceWatchConfig(config?: Partial<SourceWatchConfig> | null): SourceWatchConfig {
  const rawParsingConcurrency = config?.parsingConcurrency
    ?? DEFAULT_SOURCE_WATCH_CONFIG.parsingConcurrency
  const parsingConcurrency = Number.isFinite(rawParsingConcurrency)
    ? Math.max(1, Math.min(8, Math.floor(rawParsingConcurrency)))
    : DEFAULT_SOURCE_WATCH_CONFIG.parsingConcurrency
  const rawIngestConcurrency = config?.ingestConcurrency
    ?? DEFAULT_SOURCE_WATCH_CONFIG.ingestConcurrency
  const ingestConcurrency = Number.isFinite(rawIngestConcurrency)
    ? Math.max(1, Math.min(5, Math.floor(rawIngestConcurrency)))
    : DEFAULT_SOURCE_WATCH_CONFIG.ingestConcurrency
  return {
    enabled: config?.enabled ?? DEFAULT_SOURCE_WATCH_CONFIG.enabled,
    autoIngest: config?.autoIngest ?? DEFAULT_SOURCE_WATCH_CONFIG.autoIngest,
    persistExtractedMarkdown:
      config?.persistExtractedMarkdown ?? DEFAULT_SOURCE_WATCH_CONFIG.persistExtractedMarkdown,
    parsingConcurrency,
    ingestConcurrency,
    includeExtensions: withMediaExtensions(
      normalizeExtensions(config?.includeExtensions ?? DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions),
    ),
    excludeExtensions: normalizeExtensions(config?.excludeExtensions ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeExtensions),
    excludeDirs: normalizeList(config?.excludeDirs ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeDirs),
    excludeGlobs: normalizeList(config?.excludeGlobs ?? DEFAULT_SOURCE_WATCH_CONFIG.excludeGlobs),
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
  const name = parts[parts.length - 1] ?? ""
  if (!name || name.startsWith(".")) return false
  const ext = getSourceWatchExtension(normalized)
  if (ext && cfg.excludeExtensions.includes(ext)) return false
  if (cfg.includeExtensions.length > 0 && (!ext || !cfg.includeExtensions.includes(ext))) {
    return false
  }
  return true
}
