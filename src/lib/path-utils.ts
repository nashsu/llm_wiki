/**
 * Normalize a path to use forward slashes (works on both macOS and Windows).
 * Windows APIs accept forward slashes, so normalizing to / is safe everywhere.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

/**
 * Join path segments with forward slashes.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/\\/g, "/"))
    .join("/")
    .replace(/\/+/g, "/")
}

/**
 * Get the filename from a path (handles both / and \).
 */
export function getFileName(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? p
}

/**
 * Get the file stem (filename without extension).
 */
export function getFileStem(p: string): string {
  const name = getFileName(p)
  const lastDot = name.lastIndexOf(".")
  return lastDot > 0 ? name.slice(0, lastDot) : name
}

/**
 * Vector-store identity for a wiki markdown path.
 *
 * LanceDB page ids cannot contain `/`, so the wiki-relative path
 * without `.md` is encoded with `__` between directory segments:
 * `wiki/sources/mobile-architecture.md` → `sources__mobile-architecture`.
 * Pages that share a filename stem across schema directories therefore
 * keep distinct embeddings.
 */
export function vectorPageIdFromWikiPath(path: string): string {
  const normalized = normalizePath(path)
  let wikiRel = ""
  if (normalized === "wiki" || normalized.startsWith("wiki/")) {
    wikiRel = normalized.slice("wiki/".length)
  } else {
    const idx = normalized.indexOf("/wiki/")
    wikiRel = idx >= 0 ? normalized.slice(idx + "/wiki/".length) : getFileName(normalized)
  }
  if (!wikiRel) return ""
  const withoutExt = wikiRel.toLowerCase().endsWith(".md")
    ? wikiRel.slice(0, -3)
    : wikiRel
  if (!withoutExt || withoutExt.endsWith("/")) return ""
  return withoutExt.replace(/\//g, "__")
}

// Windows drive-letter and UNC paths are case-insensitive; fold them for
// comparison purposes only (never for the paths actually returned/written).
function caseFoldPath(normalized: string): string {
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized
}

/**
 * Get relative path from base.
 */
export function getRelativePath(fullPath: string, basePath: string): string {
  const normalFull = normalizePath(fullPath)
  const normalBase = normalizePath(basePath).replace(/\/$/, "")
  const fullKey = caseFoldPath(normalFull)
  const baseKey = caseFoldPath(normalBase)
  if (fullKey.startsWith(baseKey + "/")) {
    // Slice by path segments rather than the original string length. Unicode
    // case folding can change UTF-16 length, so an offset derived from the
    // differently-cased base can split the returned relative path incorrectly.
    return normalFull.split("/").slice(normalBase.split("/").length).join("/")
  }
  return normalFull
}

/**
 * Cross-platform absolute-path detection.
 *
 * Unix:     "/foo/bar"
 * Windows:  "C:\foo", "C:/foo", "\\server\share", "//server/share"
 *
 * A bare `.startsWith("/")` check wrongly treats Windows paths like
 * "C:/project/file.pdf" as relative, which produced double-joined
 * garbage like "C:/project/C:/project/file.pdf" in the ingest queue.
 */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (p.startsWith("\\\\") || p.startsWith("//")) return true
  return false
}
