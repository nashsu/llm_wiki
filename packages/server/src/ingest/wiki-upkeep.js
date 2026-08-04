// Wiki-upkeep pipeline helpers for the server-driven ingest pipeline
// (issue #14 P0). Port of src/lib/ingest.ts regions:
//   - tryReadSourceTextFile                     (~2456, plus the Rust
//     read_file(extractImages:false) semantics it delegates to, from
//     src-tauri/src/commands/fs.rs)
//   - appendIngestWarningLog                    (~620-638)
//   - updateWikiIndexDeterministically          (~1475-1507)
//   - normalizeIndexTarget                      (~1509-1514)
//   - buildFallbackSourceSummary                (~1732-1756)
//   - shouldRunDedicatedReviewStage             (~2058-2062)
//   - migrateLegacySourceSummaryIfSafe          (~1574-1634)
//   - migrateExactLegacySourceSummaryIfSafe     (~1636-1686)
//   - matchingRawSourceIdentitiesForBasename    (~1688-1723)
//   - reembedSourceSummary                      (~3104-3125)
//
// Port deviations (all mandated by the server-ingest assignment):
//   1. tryReadSourceTextFile: the client delegates to the Rust read_file
//      command; this port replicates that command's semantics directly:
//      cache check first (<dir>/.cache/<fileName>.txt, used when its
//      mtime >= the original's), extraction dispatch for the binary
//      formats packages/server/src/commands/preprocess.js supports
//      (routed through the worker pool so multi-second PDF/Office parses
//      don't block the event loop — the server equivalent of the Rust
//      spawn_blocking), image/media/legacy-doc placeholders, and a utf8
//      read fallback. The extraction result is ALSO written back to the
//      .cache file best-effort (mirroring Rust write_cache, which on the
//      desktop only happened in the separate preprocess_file command —
//      the server has no separate preprocess step, so the first read
//      warms the cache for every later reader).
//   2. Tauri readFile/writeFile/createDirectory/fileExists/deleteFile/
//      listDirectory → node:fs/promises. writeFile uses the
//      writeFileEnsuringDirs pattern (write.js): the Rust write_file
//      creates parent directories, so the server must too.
//   3. matchingRawSourceIdentitiesForBasename: the client's recursive
//      listDirectory FileNode traversal becomes a flat
//      readdir({recursive:true, withFileTypes:true}) traversal. Matching
//      rules (basename match, rootPrefix stripping, case-insensitive
//      keys) are preserved; hidden entries (dot-names at any depth) are
//      excluded for parity with Rust list_directory(include_hidden=false).
//   4. reembedSourceSummary: the embedding config was read from
//      useWikiStore on the client; the server takes it as an explicit
//      parameter (plus a defensive !cfg guard so the "never throws"
//      contract holds even for a missing config). embedPage is imported
//      statically instead of the client's dynamic import() (no cycle).
//
// Everything else — regexes, placeholders, thresholds, log/warning
// message strings — is byte-identical to the client/Rust sources.

import { access, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { basename as fsBasename, dirname, extname, join } from "node:path"
import { runInWorker as runInWorkerDefault } from "../workers/pool.js"
import {
  AGGREGATE_WIKI_PATHS,
  formatIngestWarningLogEntry,
  REVIEW_STAGE_MIN_SIGNAL_CHARS,
  REVIEW_STAGE_MIN_FILE_BLOCKS,
} from "./prompts.js"
import {
  normalizePath,
  getFileName,
  countFileBlocks,
  updateBoundedRecentIndexSection,
  canonicalizeSourcesField,
} from "./parse.js"
import { parseSources } from "./sources-merge.js"
import { sourceSummarySlugCandidatesFromIdentity } from "./identity.js"
import { parseFrontmatter } from "./frontmatter.js"
import { tryReadFile } from "./write.js"
import { embedPage } from "./embed.js"

// ── tryReadSourceTextFile ───────────────────────────────────────────────
// Extension sets byte-identical to src-tauri/src/commands/fs.rs.
const OFFICE_EXTS = ["doc", "docx", "pptx", "xls", "xlsx", "odt", "ods", "odp"]
const IMAGE_EXTS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "avif", "heic", "heif", "svg",
]
const MEDIA_EXTS = [
  "mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "m4v", "mp3", "wav", "ogg", "flac", "aac",
  "m4a", "wma",
]
const EBOOK_EXTS = ["epub", "mobi"]
const LEGACY_DOC_EXTS = ["ppt", "pages", "numbers", "key"]

// Formats the server preprocess worker can extract text from (the Rust
// read_file match arms: pdf, org, OFFICE_EXTS, EBOOK_EXTS).
const PREPROCESS_EXTS = new Set(["pdf", "org", ...OFFICE_EXTS, ...EBOOK_EXTS])

function cachePathFor(originalPath) {
  return join(dirname(originalPath), ".cache", `${fsBasename(originalPath)}.txt`)
}

/**
 * Rust read_cache parity (fs.rs): the cache file is authoritative only
 * when it is at least as new as the original; a stale cache (or any
 * stat/read failure) falls through to the dispatch below.
 */
async function readPreprocessCache(originalPath) {
  const cachePath = cachePathFor(originalPath)
  let originalMtimeMs
  let cacheMtimeMs
  try {
    originalMtimeMs = (await stat(originalPath)).mtimeMs
    cacheMtimeMs = (await stat(cachePath)).mtimeMs
  } catch {
    return null
  }
  if (cacheMtimeMs < originalMtimeMs) return null
  try {
    return await readFile(cachePath, "utf8")
  } catch {
    return null
  }
}

/** Rust write_cache parity, best-effort: a cache-write failure never fails the read. */
async function writePreprocessCache(originalPath, text) {
  try {
    const cachePath = cachePathFor(originalPath)
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, text, "utf8")
  } catch {
    // Best-effort (Rust write_cache errors only fail preprocess_file,
    // never the read path).
  }
}

/** Inner implementation that MAY THROW; the try* wrapper swallows everything. */
async function readSourceTextFile(sourcePath, runInWorkerImpl) {
  const ext = (extname(sourcePath).slice(1) || "").toLowerCase()

  // a. Cache check first (Rust read_file ordering).
  const cached = await readPreprocessCache(sourcePath)
  if (cached !== null) return cached

  // b. Extraction dispatch through the worker pool.
  if (PREPROCESS_EXTS.has(ext)) {
    const text = await runInWorkerImpl("preprocess", { filePath: sourcePath })
    await writePreprocessCache(sourcePath, text)
    return text
  }

  // c. Placeholders byte-identical to Rust read_file.
  if (IMAGE_EXTS.includes(ext)) {
    const size = await stat(sourcePath).then((m) => m.size).catch(() => 0)
    return `[Image: ${fsBasename(sourcePath)} (${(size / 1024).toFixed(1)} KB)]`
  }
  if (MEDIA_EXTS.includes(ext)) {
    const size = await stat(sourcePath).then((m) => m.size).catch(() => 0)
    return `[Media: ${fsBasename(sourcePath)} (${(size / 1048576).toFixed(1)} MB)]`
  }
  if (LEGACY_DOC_EXTS.includes(ext)) {
    return `[Document: ${fsBasename(sourcePath)} — text extraction not supported for .${ext} format]`
  }

  // d. Everything else: plain utf8 read.
  return await readFile(sourcePath, "utf8")
}

/**
 * Read a source file as text, never throwing (the try* contract).
 * `runInWorker` is injectable for tests; it defaults to the shared
 * worker pool (workers/pool.js).
 */
export async function tryReadSourceTextFile(sourcePath, { runInWorker: runInWorkerImpl = runInWorkerDefault } = {}) {
  try {
    return await readSourceTextFile(sourcePath, runInWorkerImpl)
  } catch {
    return ""
  }
}

// ── appendIngestWarningLog ──────────────────────────────────────────────

export async function appendIngestWarningLog(projectPath, sourceIdentity, warnings) {
  if (warnings.length === 0) return
  const logPath = `${projectPath}/.llm-wiki/ingest-warnings.log`
  try {
    await mkdir(`${projectPath}/.llm-wiki`, { recursive: true })
    const existing = await tryReadFile(logPath)
    const next = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${formatIngestWarningLogEntry(sourceIdentity, warnings).trimEnd()}\n`
    await writeFile(logPath, next, "utf8")
  } catch (err) {
    console.warn(
      `[ingest] Failed to write ingest warning log for "${sourceIdentity}":`,
      err instanceof Error ? err.message : err,
    )
  }
}

// ── updateWikiIndexDeterministically ────────────────────────────────────

/**
 * node:fs/promises replacement for the Tauri writeFile command (same
 * pattern as write.js): the Rust command creates parent directories
 * before writing, so this helper must too.
 */
async function writeFileEnsuringDirs(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, "utf8")
}

export async function updateWikiIndexDeterministically(projectPath, writtenPaths) {
  const candidates = Array.from(new Set(writtenPaths.map(normalizePath))).filter((path) =>
    path.startsWith("wiki/")
      && path.endsWith(".md")
      && !AGGREGATE_WIKI_PATHS.includes(path),
  )
  if (candidates.length === 0) return false

  const indexPath = `${projectPath}/wiki/index.md`
  const index = await readFile(indexPath, "utf8").catch(() => "# Wiki Index\n")
  const knownTargets = new Set(
    Array.from(index.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g))
      .map((match) => normalizeIndexTarget(match[1])),
  )
  const additions = []
  for (const path of candidates) {
    const target = path.replace(/^wiki\//, "").replace(/\.md$/i, "")
    if (knownTargets.has(normalizeIndexTarget(target))) continue
    const content = await readFile(`${projectPath}/${path}`, "utf8").catch(() => "")
    const parsed = parseFrontmatter(content)
    const title = typeof parsed.frontmatter?.title === "string"
      ? parsed.frontmatter.title.trim()
      : getFileName(path).replace(/\.md$/i, "")
    additions.push(`- [[${target}]] — ${title}`)
  }
  if (additions.length === 0) return false

  await writeFileEnsuringDirs(indexPath, updateBoundedRecentIndexSection(index, additions))
  return true
}

export function normalizeIndexTarget(target) {
  return normalizePath(target)
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
}

// ── buildFallbackSourceSummary ──────────────────────────────────────────

export function buildFallbackSourceSummary(sourceIdentity, analysis, date) {
  return [
    "---",
    "type: source",
    `title: "Source: ${sourceIdentity}"`,
    `created: ${date}`,
    `updated: ${date}`,
    `sources: ["${sourceIdentity}"]`,
    "tags: []",
    "related: []",
    "---",
    "",
    `# Source: ${sourceIdentity}`,
    "",
    // This is a recovery page, so preserving the complete analysis matters
    // more than keeping the page short. Truncating here used to create
    // syntactically valid but silently incomplete source summaries.
    analysis || "(Analysis not available)",
    "",
  ].join("\n")
}

// ── shouldRunDedicatedReviewStage ───────────────────────────────────────

export function shouldRunDedicatedReviewStage(generation) {
  return generation.length >= REVIEW_STAGE_MIN_SIGNAL_CHARS
    || countFileBlocks(generation) >= REVIEW_STAGE_MIN_FILE_BLOCKS
    || /---REVIEW:\s*[\w-]+\s*\|[\s\S]*$/i.test(generation)
}

// ── Legacy source-summary migration ─────────────────────────────────────

async function fileExists(fullPath) {
  try {
    await access(fullPath)
    return true
  } catch {
    return false
  }
}

export async function migrateLegacySourceSummaryIfSafe(projectPath, sourceIdentity, sourceSummaryPath) {
  const normalizedIdentity = normalizePath(sourceIdentity)
  if (!normalizedIdentity.includes("/")) return

  if (await migrateExactLegacySourceSummaryIfSafe(projectPath, normalizedIdentity, sourceSummaryPath)) {
    return
  }

  const basename = getFileName(normalizedIdentity)
  const legacySlug = basename.replace(/\.[^.]+$/, "")
  const legacyPath = `wiki/sources/${legacySlug}.md`
  if (legacyPath === sourceSummaryPath) return

  const pp = normalizePath(projectPath)
  const legacyFullPath = `${pp}/${legacyPath}`
  const canonicalFullPath = `${pp}/${sourceSummaryPath}`

  const matchingIdentities = await matchingRawSourceIdentitiesForBasename(pp, basename)
  const normalizedIdentityKey = normalizedIdentity.toLowerCase()
  if (
    matchingIdentities.length !== 1 ||
    normalizePath(matchingIdentities[0]).toLowerCase() !== normalizedIdentityKey
  ) {
    return
  }

  try {
    if (await fileExists(canonicalFullPath)) return
    if (await fileExists(`${pp}/raw/sources/${basename}`)) return
  } catch {
    return
  }

  const legacyContent = await tryReadFile(legacyFullPath)
  if (!legacyContent) return

  const sources = parseSources(legacyContent)
  const basenameKey = basename.toLowerCase()
  const legacyOnlyReferencesBasename =
    sources.length > 0 &&
    sources.every(
      (source) =>
        !normalizePath(source).includes("/") &&
        getFileName(source).toLowerCase() === basenameKey,
    )
  if (!legacyOnlyReferencesBasename) return

  try {
    await writeFileEnsuringDirs(canonicalFullPath, canonicalizeSourcesField(legacyContent, sourceIdentity))
    await unlink(legacyFullPath)
  } catch (err) {
    console.warn(
      `[ingest] failed to migrate legacy source summary ${legacyPath} -> ${sourceSummaryPath}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

export async function migrateExactLegacySourceSummaryIfSafe(projectPath, sourceIdentity, sourceSummaryPath) {
  const pp = normalizePath(projectPath)
  const canonicalFullPath = `${pp}/${sourceSummaryPath}`
  let canonicalExists = false
  try {
    canonicalExists = await fileExists(canonicalFullPath)
  } catch {
    return false
  }
  if (canonicalExists) return false

  const sourceKey = normalizePath(sourceIdentity).toLowerCase()
  const legacyPaths = sourceSummarySlugCandidatesFromIdentity(sourceIdentity)
    .map((slug) => `wiki/sources/${slug}.md`)
    .filter((path) => path !== sourceSummaryPath)

  for (const legacyPath of legacyPaths) {
    const legacyFullPath = `${pp}/${legacyPath}`
    let legacyContent = ""
    try {
      if (!(await fileExists(legacyFullPath))) continue
      legacyContent = await readFile(legacyFullPath, "utf8")
    } catch {
      continue
    }

    const sources = parseSources(legacyContent)
    const referencesSameSource = sources.some(
      (source) => normalizePath(source).toLowerCase() === sourceKey,
    )
    if (!referencesSameSource) continue

    try {
      await writeFileEnsuringDirs(canonicalFullPath, canonicalizeSourcesField(legacyContent, sourceIdentity))
      await unlink(legacyFullPath)
      return true
    } catch (err) {
      console.warn(
        `[ingest] failed to migrate legacy source summary ${legacyPath} -> ${sourceSummaryPath}:`,
        err instanceof Error ? err.message : err,
      )
      return false
    }
  }

  return false
}

export async function matchingRawSourceIdentitiesForBasename(projectPath, basename) {
  const rawRoot = `${projectPath}/raw/sources`
  let entries
  try {
    entries = await readdir(rawRoot, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }

  const rootPrefix = `${normalizePath(rawRoot).replace(/\/+$/, "")}/`
  const rootPrefixKey = rootPrefix.toLowerCase()
  const basenameKey = basename.toLowerCase()
  const matches = []

  for (const entry of entries) {
    if (entry.isDirectory()) continue
    const fullPath = normalizePath(join(entry.parentPath ?? entry.path ?? rawRoot, entry.name))
    if (!fullPath.toLowerCase().startsWith(rootPrefixKey)) continue
    const relative = fullPath.slice(rootPrefix.length)
    // Parity with the client's listDirectory(rawRoot), which runs Rust
    // list_directory with include_hidden=false: dot-entries (and anything
    // nested under a dot-directory) are invisible.
    if (relative.split("/").some((segment) => segment.startsWith("."))) continue
    if (getFileName(fullPath).toLowerCase() === basenameKey) {
      matches.push(relative)
    }
  }

  return matches
}

// ── reembedSourceSummary ────────────────────────────────────────────────

/**
 * Re-embed the source-summary page after we've rewritten its
 * `## Embedded Images` safety-net section with captions. The full
 * autoIngest pipeline calls `embedPage` at step 6 unconditionally;
 * this is the cache-hit equivalent (where step 6 is skipped) and
 * exists specifically to keep the search index in sync after a
 * caption refresh.
 *
 * Why not just call `embedPage` inline at the call site: the
 * embedding config check, the readFile-then-parse-title
 * dance, and the no-op behavior when embedding is disabled all
 * already exist in the step-6 logic. Wrapping them once here
 * avoids drift between the two paths if either side changes.
 */
export async function reembedSourceSummary(pp, sourceIdentity, sourceSummarySlug, embeddingConfig) {
  const embCfg = embeddingConfig
  if (!embCfg || !embCfg.enabled || !embCfg.model) return
  const sourceSummaryFullPath = `${pp}/wiki/sources/${sourceSummarySlug}.md`
  try {
    const content = await readFile(sourceSummaryFullPath, "utf8")
    const fmTitle = parseFrontmatter(content).frontmatter?.title
    const title = typeof fmTitle === "string" && fmTitle.trim() ? fmTitle.trim() : sourceIdentity
    await embedPage(pp, sourceSummarySlug, title, content, embCfg)
    console.log(`[ingest:caption] re-embedded ${sourceSummarySlug} with captioned alt text`)
  } catch (err) {
    console.warn(
      `[ingest:caption] re-embed failed for ${sourceSummarySlug}:`,
      err instanceof Error ? err.message : err,
    )
  }
}
