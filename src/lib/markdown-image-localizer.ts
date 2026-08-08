/**
 * Markdown image localizer — Phase 1 (v0.6.6).
 *
 * When a user ingests a `.md` file, this module downloads/copies every
 * `![alt](url "title")` image reference into `wiki/media/<slug>/` and
 * rewrites the body to point at the local copy. See
 * `plans/markdown-image-localizer.md` for the full spec.
 *
 * COMMIT 3a SCOPE: module skeleton — types, extended regex + reference
 * scanner, URL classification with §5's 3-step already-localized check,
 * `resolveLocalRelative` with `isInsideProject` path-traversal defense.
 * COMMIT 3b ADDS: URL cache data layer (`UrlCacheEntry`, `readUrlCache`,
 * `upsertUrlCacheEntry`, `isUrlCacheEntryFresh`, `sha8OfBytes`).
 * COMMIT 3c ADDS: HTTP fetch with SSRF / Content-Length / streaming size /
 * Content-Type / timeout defenses, data-URI decoder with truncation and
 * MIME/size guards, and the main `localizeMarkdownImages` entry point
 * (no VLM yet — that's Commit 4b).
 * COMMIT 4a ADDS: Two-form body rewrite — `rewriteBySlot` replaces
 * `![alt](url ...)` at each ref's recorded offset (in reverse order to
 * keep earlier offsets valid), using a `pathForm` helper to emit either
 * the `../../wiki/media/...` source-relative form or the `../media/...`
 * wiki-relative form. `formatImageAlt` / `formatImageTitle` implement §7
 * escape (alt: `]`→`\]`, `\n`→space, zero-width strip) vs sanitize (title:
 * `"`→`\u201D`, `\n`→space). At this commit the alt/title values are
 * still taken verbatim from `ref.alt` / `ref.title` — VLM captioning
 * (which decides whether to overwrite empty alts) lands in Commit 4b.
 * Frontmatter `image_sources:` merging via `mergeImageSourcesFrontmatter`
 * is Commit 4c.
 */
import {
  copyFile,
  createDirectory,
  fileExists,
  readFile,
  writeFile,
  writeFileBase64,
  readFileAsBase64,
} from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { isInsideProject } from "@/lib/markdown-image-resolver"
import { parseFrontmatter } from "@/lib/frontmatter"
import { captionImage } from "@/lib/vision-caption"
import { embedImageMetadata } from "@/lib/image-metadata-embed"
import {
  fetchImportUrl,
  isPrivateNetworkHost,
  validateHttpUrl,
} from "@/lib/url-source-import"
import type { LlmConfig, MultimodalConfig } from "@/stores/wiki-store"
import type { SavedImage } from "@/lib/extract-source-images"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LocalizeOptions {
  projectPath: string
  /** Absolute path of the raw-sources copy (e.g. `<pp>/raw/sources/foo.md`). */
  sourcePath: string
  /** Matches ingest.ts's local var; drives `wiki/media/<slug>/` dir. */
  sourceSummarySlug: string
  /** Markdown body (may include frontmatter). */
  markdown: string
  llmConfig: LlmConfig
  multimodalConfig: MultimodalConfig
  signal?: AbortSignal
  onProgress?: (done: number, total: number, stage: "download" | "caption") => void
  /**
   * Wiki output language (e.g. "Chinese", "English"). Forwarded to
   * `captionImage` so VLM alt text matches the wiki's language.
   * "auto" or undefined → model matches image content language.
   */
  outputLanguage?: string
  /**
   * Optional override for image dimension probing. Injected primarily
   * for tests — vitest runs under jsdom where `createImageBitmap` is
   * undefined, so unit tests supply a stub. Production callers omit
   * this and get the default `createImageBitmap`-based implementation.
   * Also the seam Phase 2's Rust probe drops in through.
   */
  probeImageDimensions?: (
    mimeType: string,
    bytes: Uint8Array,
  ) => Promise<{ width: number; height: number }>
}

export interface LocalizeResult {
  /**
   * Rewritten md ready to write to `raw/sources/<slug>.md`. Image refs use
   * the `../../wiki/media/<slug>/...` relative form. Frontmatter carries
   * the `image_sources:` mapping.
   */
  rewrittenSourceMarkdown: string
  /**
   * Rewritten md ready to seed `wiki/sources/<slug>.md`. Same body, same
   * frontmatter, but image refs use the `../media/<slug>/...` relative
   * form.
   */
  rewrittenWikiMarkdown: string
  /** Localized image metadata for `injectImagesIntoSourceSummary`. */
  savedImages: SavedImage[]
  /**
   * Frontmatter `image_sources:` mapping for THIS run. Populated per §11:
   * one entry per remote-http OR data-uri image. Local-relative and
   * already-localized refs are excluded. Data-URI values are already
   * truncated via {@link truncateDataUriForFrontmatter}. The caller
   * passes this straight to {@link mergeImageSourcesFrontmatter}.
   */
  frontmatterEntries: FrontmatterImageEntry[]
  stats: {
    // I/O
    downloaded: number
    urlCacheHits: number
    copied: number
    decoded: number
    alreadyLocalized: number
    // VLM
    captioned: number
    captionCacheHits: number
    skippedAuthorAlt: number
    skippedTooSmall: number
    /**
     * Provider can't run VLM (codex-cli); ALL images with empty alt get
     * counted here regardless of size/kind. See §1 Provider capability gate.
     */
    skippedNoVlmProvider: number
    failed: number
    // Metadata embedding (Phase 3)
    metadataEmbedded: number
    metadataSkipped: number
  }
}

/**
 * One-of classification of an image `src` URL. See §1 and §5 of the plan.
 *
 * - `remote-http`      — `http://` or `https://`
 * - `data-uri`         — `data:image/...`
 * - `local-relative`   — relative filesystem path, resolves inside project
 * - `already-localized`— matches `wiki/media/<slug>/<name>-<sha8>.<ext>` AND file on disk
 * - `unsupported`      — recognized shape we deliberately don't handle (e.g. `ftp://`)
 * - `failed`           — reference cannot be resolved (missing file, path traversal, malformed)
 */
export type ImageClass =
  | "remote-http"
  | "data-uri"
  | "local-relative"
  | "already-localized"
  | "unsupported"
  | "failed"

// ---------------------------------------------------------------------------
// Regex + scanner (§7)
// ---------------------------------------------------------------------------

/**
 * Extended markdown-image regex. Matches:
 *
 *   ![alt](url)
 *   ![alt](url "title")
 *   ![alt](url 'title')
 *
 * Groups:
 *   1: `![`
 *   2: alt (may be empty, may contain `\]` escaped brackets)
 *   3: `](`
 *   4: url (no whitespace, no `<>`)
 *   5: title delimiter (`"` or `'`) — captured for reference, unused
 *   6: title inner text (whatever the author wrote, incl. escaped delim)
 *   7: `)`
 *
 * Does NOT match `<img>` HTML tags, angle-bracket URLs `![alt](<url>)`,
 * or reference-style images `![alt][id]` — all documented non-goals for
 * Phase 1 (§7).
 */
export const MD_IMAGE_RE_WITH_TITLE =
  /(!\[)((?:\\\]|[^\]])*)(\]\()([^)\s]+)(?:\s+(["'])((?:(?!\5).)*)\5)?(\))/g

/**
 * One image reference found in a markdown body. Offsets are relative
 * to the input string.
 */
export interface ImageRef {
  /** Character offset of the leading `!`. */
  offset: number
  /** Character length of the whole `![...](...)` match. */
  length: number
  /** Alt text, verbatim from source (may contain `\]`). */
  alt: string
  /** URL (no whitespace). */
  url: string
  /**
   * Title inner text, verbatim from source. `undefined` when no title
   * was written; `""` when the author wrote empty quotes.
   */
  title: string | undefined
  /** Title delimiter (`"` or `'`) — undefined when no title. */
  titleDelim: '"' | "'" | undefined
}

/**
 * Scan a markdown body for image references using `MD_IMAGE_RE_WITH_TITLE`.
 * Returns them in source order.
 */
export function findImageReferencesWithTitle(markdown: string): ImageRef[] {
  const refs: ImageRef[] = []
  // Local regex clone — global regexes carry lastIndex state; using
  // `matchAll` on the module-level constant is safe but cloning makes
  // this function reentrant regardless of caller usage.
  const re = new RegExp(MD_IMAGE_RE_WITH_TITLE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    const [full, , alt, , url, delim, titleInner] = m
    refs.push({
      offset: m.index,
      length: full.length,
      alt,
      url,
      title: titleInner,
      titleDelim: delim as '"' | "'" | undefined,
    })
  }
  return refs
}

// ---------------------------------------------------------------------------
// Path helpers (§5, §4)
// ---------------------------------------------------------------------------

/**
 * Regex matching the shape `.../wiki/media/<slug>/<name>-<sha8>.<ext>`
 * anchored at the end of an absolute path. Used by `classifyImageUrl`
 * to detect already-localized references (§5 step 2).
 *
 * `<slug>` and `<name>` allow anything but `/`; `<sha8>` is 8 lowercase
 * hex chars; `<ext>` is any lowercase alphanumeric extension.
 */
export const ALREADY_LOCALIZED_SUFFIX_RE =
  /\/wiki\/media\/[^/]+\/[^/]+-[0-9a-f]{8}\.[a-z0-9]+$/

/**
 * Resolve a relative URL against the raw-sources file's directory,
 * then validate the resulting absolute path stays inside the project
 * root. Path-traversal defense: reuses `isInsideProject`.
 *
 * Returns:
 *   { absPath, insideProject: true }   when resolution succeeds and stays put
 *   { absPath, insideProject: false }  when resolved path escapes the project
 *
 * The absolute path uses forward slashes (`normalizePath` output).
 * Does NOT perform `fileExists` — that's the caller's responsibility.
 */
export function resolveLocalRelative(
  url: string,
  sourceDir: string,
  projectPath: string,
): { absPath: string; insideProject: boolean } {
  const dir = normalizePath(sourceDir).replace(/\/$/, "")
  // Normalize URL: strip any `./` prefix and collapse `\` → `/`.
  const rel = normalizePath(url)

  // Split into segments and resolve `..` / `.` manually. Path.resolve
  // isn't available in the browser bundle, and we want deterministic
  // POSIX-style behavior regardless of host OS.
  const dirSegments = dir.split("/").filter((s) => s.length > 0)
  const relSegments = rel.split("/").filter((s) => s.length > 0)
  const combined: string[] = [...dirSegments]
  for (const seg of relSegments) {
    if (seg === ".") continue
    if (seg === "..") {
      if (combined.length === 0) {
        // Trying to escape the root prefix (e.g. `../` from `/`).
        // isInsideProject will catch this via the reconstructed prefix.
        continue
      }
      combined.pop()
      continue
    }
    combined.push(seg)
  }

  // Preserve leading slash for POSIX absolute paths; preserve
  // `C:` drive letter for Windows absolute paths.
  let absPath: string
  if (dir.startsWith("/")) {
    absPath = "/" + combined.join("/")
  } else if (/^[A-Za-z]:$/.test(dirSegments[0] ?? "")) {
    // `C:` starts a Windows drive; keep it as the first segment.
    absPath = combined.join("/")
  } else {
    absPath = combined.join("/")
  }

  return {
    absPath,
    insideProject: isInsideProject(absPath, projectPath),
  }
}

// ---------------------------------------------------------------------------
// URL cache (§3.2) — data layer only; Commit 3c consumes this
// ---------------------------------------------------------------------------

/**
 * One entry in `.llm-wiki/image-url-cache.json`. Keyed by URL. See §3.2.
 *
 * The `bytesLen` field is recorded for diagnostics/telemetry (activity
 * feed, backup triage) but is not read by the localizer logic itself
 * in Phase 1.
 */
export interface UrlCacheEntry {
  sha256: string
  mimeType: string
  /** 0 when unknown (SVG, decode failed, or probe skipped). */
  width: number
  height: number
  /** Recorded for diagnostics/telemetry; not read by localizer logic in Phase 1. */
  bytesLen: number
  /** ISO 8601 timestamp of the last successful fetch. TTL is measured from here. */
  fetchedAt: string
  /**
   * Project-root-relative path of the FIRST place we wrote this
   * content. Later hits `copyFile` from here instead of re-downloading.
   *
   * Example: "wiki/media/my-notes/logo-abc12345.png".
   */
  canonicalRelPath: string
}

export type UrlCache = Record<string /* url */, UrlCacheEntry>

/** Project-relative path of the on-disk URL cache. */
export const URL_CACHE_REL_PATH = ".llm-wiki/image-url-cache.json"

/**
 * Read the on-disk URL cache. Returns an empty map when the file
 * doesn't exist, is unreadable, or contains malformed JSON. Corrupt
 * cache files log a warning and start fresh — same pattern as
 * `image-caption-pipeline.ts` (see §Risk #5 of the plan).
 */
export async function readUrlCache(projectPath: string): Promise<UrlCache> {
  const cachePath = `${normalizePath(projectPath)}/${URL_CACHE_REL_PATH}`
  if (!(await fileExists(cachePath))) return {}
  try {
    const raw = await readFile(cachePath)
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as UrlCache
    }
  } catch (err) {
    console.warn(
      `[url-cache] corrupt cache at ${cachePath}, starting empty:`,
      err instanceof Error ? err.message : err,
    )
  }
  return {}
}

/**
 * Write the full cache back to disk. Callers should prefer
 * `upsertUrlCacheEntry` — writing a mutated whole map from stale
 * memory drops concurrent updates from other in-flight images
 * (see §3.2 concurrency note). Exposed for tests and one-shot
 * bulk operations only.
 */
async function writeUrlCache(
  projectPath: string,
  cache: UrlCache,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const cachePath = `${pp}/${URL_CACHE_REL_PATH}`
  // `.llm-wiki/` may not exist on a fresh project — createDirectory
  // is idempotent and chains parents.
  await createDirectory(`${pp}/.llm-wiki`)
  await writeFile(cachePath, JSON.stringify(cache, null, 2))
}

/**
 * Per-entry upsert. Re-reads the on-disk cache, sets the one key, and
 * writes the merged result back. This is the pattern used by
 * `image-caption-pipeline.ts` for the same reason: parallel image
 * fetches within a single ingest each finish at different times, and
 * a pipeline-end batch write would drop earlier writes when a later
 * one held a stale in-memory snapshot.
 *
 * The read-modify-write is not atomic — a truly concurrent second
 * writer landing between our read and our write can still lose. That
 * failure mode is documented and accepted in §Risk #5 of the plan
 * (matches the caption cache's behavior).
 */
export async function upsertUrlCacheEntry(
  projectPath: string,
  url: string,
  entry: UrlCacheEntry,
): Promise<void> {
  const current = await readUrlCache(projectPath)
  current[url] = entry
  await writeUrlCache(projectPath, current)
}

/**
 * TTL check. `ttlDays` comes from `multimodalConfig.urlCacheTtlDays`
 * (default 45; see §9). `now` is passed in so tests are deterministic
 * — production callers use `Date.now()`.
 *
 * A malformed / missing `fetchedAt` counts as stale (returns `false`) —
 * safer than a silent "always fresh" pass that would suppress a
 * needed re-fetch. Same story for a fetchedAt in the future (clock
 * skew): we still treat it as fresh, since a false "stale" would
 * force wasted network I/O.
 */
export function isUrlCacheEntryFresh(
  entry: Pick<UrlCacheEntry, "fetchedAt">,
  ttlDays: number,
  now: number,
): boolean {
  const fetched = Date.parse(entry.fetchedAt)
  if (!Number.isFinite(fetched)) return false
  const ageMs = now - fetched
  if (ageMs < 0) return true // future fetchedAt — treat as fresh
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000
  return ageMs <= ttlMs
}

/**
 * Compute an 8-char lowercase hex prefix of SHA-256(bytes). This is
 * the filename disambiguator we append to every localized image
 * (`<name>-<sha8>.<ext>`) and the key we hand to the caption cache.
 *
 * 8 hex chars = 32 bits = collision odds of ~1 in 4B — a design
 * choice: filenames stay human-scannable at the cost of tiny
 * collision risk. Real collisions would surface as one image
 * overwriting another with an unrelated caption; not silent-corruption
 * severity but still worth logging when detected (Commit 3c's dedup
 * path.)
 */
export async function sha8OfBytes(bytes: Uint8Array): Promise<string> {
  // Slice into a fresh ArrayBuffer — TS strict mode treats a bare
  // `Uint8Array` parameter as potentially SharedArrayBuffer-backed,
  // which `crypto.subtle.digest` rejects at the type level. Same
  // workaround as `mineru.ts:bytesToUploadBody`.
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest("SHA-256", buf)
  const arr = new Uint8Array(digest).slice(0, 4)
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// ---------------------------------------------------------------------------
// URL classification (§5)
// ---------------------------------------------------------------------------

/**
 * Classify an image `src` URL. See `ImageClass` for the possible
 * outcomes and their semantics.
 *
 * Runs the §5 3-step already-localized check on any local-shape URL
 * (relative or absolute):
 *
 *   1. resolve to absolute path against `sourceDir`
 *   2. regex-match the suffix against `ALREADY_LOCALIZED_SUFFIX_RE`
 *   3. `fileExists(absPath)`
 *
 * All three must pass for `already-localized`; otherwise fall through
 * to `local-relative` (which then requires the file to exist to avoid
 * being marked `failed`).
 *
 * `sourceDir` should be the directory of the raw-sources markdown file
 * (`raw/sources/<slug>.md`'s parent). Callers pass `sourceDir` directly
 * so they can be explicit about which markdown file relative URLs
 * resolve against.
 */
export async function classifyImageUrl(
  url: string,
  sourceDir: string,
  projectPath: string,
): Promise<ImageClass> {
  // 1. Scheme sniff — handled before anything filesystem-y.
  if (url.startsWith("data:")) {
    // Only image/* data URIs are supported; other MIME types are
    // treated as unsupported (Commit 3c's data-URI decoder rejects
    // non-image MIME via its own check).
    if (/^data:image\//i.test(url)) return "data-uri"
    return "unsupported"
  }
  if (/^https?:\/\//i.test(url)) return "remote-http"
  // Any other scheme is deliberately unsupported (ftp, mailto, file, …).
  // Matches the plan's Test 2 expectation for `ftp://x/y` → unsupported.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return "unsupported"

  // 2. Local-shape URL — resolve, validate, then run the 3-step
  //    already-localized check.
  const { absPath, insideProject } = resolveLocalRelative(
    url,
    sourceDir,
    projectPath,
  )
  if (!insideProject) return "failed"

  const exists = await fileExists(absPath).catch(() => false)

  if (ALREADY_LOCALIZED_SUFFIX_RE.test(absPath) && exists) {
    return "already-localized"
  }

  // §5 fall-through: shape matches `wiki/media/<slug>/<name>-<sha8>.<ext>`
  // but file is missing → treat as `local-relative` (and copyFile will
  // fail, at which point the batch marks it `failed`).
  if (exists) return "local-relative"

  return "failed"
}

// ---------------------------------------------------------------------------
// Network / data-URI defenses (§10, Commit 3c)
// ---------------------------------------------------------------------------

/**
 * Hard cap on any image byte payload we accept — remote body, data URI
 * decoded size, or copied local file. 20 MB is the same limit as
 * `mineru.ts`'s upload guard. Prevents a 4K video linked as an
 * "image" from filling the media dir.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Default HTTP fetch timeout (matches §10 rule 6). */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/** Content-Type prefix every remote image response must carry. */
const IMAGE_MIME_PREFIX = "image/"

/** Data URI truncation cap for frontmatter (§11 table). */
const DATA_URI_FRONTMATTER_CAP = 64

/**
 * Minimal MIME → extension map. Only the shapes we actually emit into
 * `wiki/media/<slug>/<name>-<sha8>.<ext>`. Unknown MIME → `bin`; the
 * caller can log a warning and count the image as `failed` upstream
 * if `bin` isn't acceptable.
 */
function extFromMime(mime: string): string {
  const norm = mime.toLowerCase().split(";")[0].trim()
  switch (norm) {
    case "image/png":
      return "png"
    case "image/jpeg":
    case "image/jpg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    case "image/svg+xml":
      return "svg"
    case "image/bmp":
      return "bmp"
    case "image/avif":
      return "avif"
    case "image/heic":
    case "image/heif":
      return "heic"
    case "image/tiff":
      return "tiff"
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return "ico"
    default:
      return "bin"
  }
}

/**
 * Convert `Uint8Array` to base64 in fixed-size chunks. Same shape as
 * the private helper in `mineru.ts` — inlined here to keep the two
 * modules from sharing an ad-hoc utility.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/** Inverse of `bytesToBase64` — decode a base64 string to raw bytes. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Read a `Response.body` stream, refusing to buffer more than `cap`
 * bytes. Aborts the stream and throws when the cap is exceeded. Used
 * for the streaming-size defense in §10 rule 5 — catches missing or
 * lying `Content-Length`.
 */
async function readBodyWithLimit(
  response: Response,
  cap: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    // No stream — fall back to arrayBuffer(), but still enforce cap
    // after the fact.
    const buf = new Uint8Array(await response.arrayBuffer())
    if (buf.byteLength > cap) {
      throw new Error(
        `Image body exceeds ${cap} bytes (received ${buf.byteLength})`,
      )
    }
    return buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > cap) {
      // Cancel the underlying stream so the socket closes.
      await reader.cancel().catch(() => {})
      throw new Error(
        `Image body exceeds ${cap} bytes during streaming read`,
      )
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Fetch a remote image URL with the full §10 defense stack:
 *
 *   1. `validateHttpUrl` — scheme + no embedded credentials
 *   2. `isPrivateNetworkHost` on the initial host
 *   3. `fetchImportUrl` — MAX_REDIRECTS loop + public→private block
 *   4. `AbortSignal.timeout(timeoutMs)` (composed with an optional
 *      caller signal)
 *   5. `Content-Type` prefix check → must start with `image/`
 *   6. `Content-Length` preflight → reject > 20 MB
 *   7. Streaming size cap during body read
 *
 * Returns the raw bytes and the response's declared MIME type.
 * `fetchImpl` is injected for tests; production callers omit it and
 * get `globalThis.fetch`.
 */
export async function fetchRemoteImage(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  callerSignal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  // 1 + 2: scheme + initial host guard. `fetchImportUrl` re-validates
  // on every redirect hop, but the initial check here gives a clean
  // error path before we open any socket.
  const initial = validateHttpUrl(url)
  if (isPrivateNetworkHost(initial.hostname)) {
    throw new Error(
      `Refusing to fetch image from private/local host: ${initial.hostname}`,
    )
  }

  // Compose timeout with caller's abort. Prefer `AbortSignal.any`
  // (standard since 2024); fall back to a manual combiner that
  // forwards either signal's abort to a fresh controller.
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  let signal: AbortSignal
  if (!callerSignal) {
    signal = timeoutSignal
  } else if (typeof (AbortSignal as unknown as { any?: unknown }).any === "function") {
    signal = (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([
      timeoutSignal,
      callerSignal,
    ])
  } else {
    // Manual composition — ensures callerSignal is never silently dropped.
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort()
    if (timeoutSignal.aborted || callerSignal.aborted) {
      ctrl.abort()
    } else {
      timeoutSignal.addEventListener("abort", onAbort, { once: true })
      callerSignal.addEventListener("abort", onAbort, { once: true })
    }
    signal = ctrl.signal
  }

  // 3: redirect-safe fetch with standard browser headers.
  // Many CDNs (WeChat, Zhihu, etc.) reject requests that lack a
  // browser-like User-Agent. We send generic headers for ALL image
  // fetches — no per-domain special-casing. If a platform still
  // blocks (cookie-gated, signed URLs), that's beyond generic
  // header fixes; the error propagates and the image is skipped.
  const browserHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept:
      "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  }
  const response = await fetchImportUrl(fetchImpl, url, signal, browserHeaders)

  if (!response.ok) {
    throw new Error(
      `Image fetch failed: ${response.status} ${response.statusText || ""}`.trim(),
    )
  }

  // 5: Content-Type gate.
  const rawType = response.headers.get("content-type") ?? ""
  const mimeType = rawType.split(";")[0].trim().toLowerCase()
  if (!mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    throw new Error(
      `Refusing non-image response: Content-Type=${rawType || "(missing)"}`,
    )
  }

  // 6: Content-Length preflight.
  const declaredLen = response.headers.get("content-length")
  if (declaredLen) {
    const n = Number.parseInt(declaredLen, 10)
    if (Number.isFinite(n) && n > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image body exceeds ${MAX_IMAGE_BYTES} bytes (Content-Length=${n})`,
      )
    }
  }

  // 7: streaming read with hard cap.
  const bytes = await readBodyWithLimit(response, MAX_IMAGE_BYTES)
  return { bytes, mimeType }
}

/**
 * Decode a `data:image/...;base64,...` URI. Enforces:
 *
 *   - MIME must start with `image/`
 *   - encoding must be base64 (charset= is tolerated but ignored)
 *   - decoded size must be ≤ 20 MB
 *   - malformed base64 rejected
 *
 * Non-base64 data URIs (e.g. `data:image/svg+xml,<svg...`) are
 * currently rejected — Phase 1 non-goal. Not a security concern
 * (they can be added later) — just a scope choice.
 */
export function resolveDataUri(
  dataUri: string,
): { bytes: Uint8Array; mimeType: string } {
  // Shape: data:<mediatype>[;<param>]*[;base64],<data>
  const match = /^data:([^,;]+)((?:;[^,]+)*),(.*)$/i.exec(dataUri)
  if (!match) throw new Error("Malformed data URI")
  const mimeType = match[1].toLowerCase().trim()
  const params = match[2].toLowerCase()
  const payload = match[3]
  if (!mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    throw new Error(`Non-image data URI: ${mimeType}`)
  }
  if (!/;base64\b/.test(params)) {
    throw new Error("Data URI is not base64-encoded (Phase 1 non-goal)")
  }
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(payload)
  } catch {
    throw new Error("Malformed base64 in data URI")
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Data URI decoded size exceeds ${MAX_IMAGE_BYTES} bytes`,
    )
  }
  return { bytes, mimeType }
}

/**
 * Truncate a data URI for frontmatter storage per §11 table.
 * Full base64 in YAML bloats the file; a short marker preserves the
 * "this was inline base64" signal without the size penalty.
 */
export function truncateDataUriForFrontmatter(dataUri: string): string {
  if (dataUri.length <= DATA_URI_FRONTMATTER_CAP) return dataUri
  return dataUri.slice(0, DATA_URI_FRONTMATTER_CAP) + "…"
}

// ---------------------------------------------------------------------------
// Body rewrite (§4, §7) — Commit 4a
// ---------------------------------------------------------------------------

/**
 * Which relative-path form the rewriter should emit. See §4 of the plan.
 *
 * - `source`: for `raw/sources/<slug>.md` — uses `../../wiki/media/...`
 * - `wiki`:   for `wiki/sources/<slug>.md` — uses `../media/...`
 *
 * The two forms share zero unique anchor substring, so the rewriter
 * generates both from the same `SavedImage`-like input rather than
 * string-replacing one into the other.
 */
export type PathForm = "source" | "wiki"

/**
 * Compute the target-directory-relative path for a localized image,
 * given its project-root-relative canonical path.
 *
 * Input `canonicalRelPath` is always of the shape
 * `wiki/media/<slug>/<name>-<sha8>.<ext>` (see §4). The two output
 * forms are literal string prefixes swapped in for the leading
 * `wiki/`:
 *
 *   source → `../../wiki/media/<slug>/<name>-<sha8>.<ext>`
 *   wiki   → `../media/<slug>/<name>-<sha8>.<ext>`
 *
 * Rationale for hardcoded prefixes rather than computing depth from
 * `sourcePath`: the layout is a project invariant (raw/sources vs
 * wiki/sources), and hardcoding matches the plan's literal §4 spec.
 * If a future layout change moves either directory, this helper is
 * the single point of update.
 */
export function pathFormFor(canonicalRelPath: string, form: PathForm): string {
  // Defensive: some already-localized refs come through with an
  // absolute path (see main pipeline's already-localized branch).
  // Rewrite only when we recognize the `wiki/media/` prefix; otherwise
  // pass through unchanged so the author's original reference isn't
  // silently mangled.
  const clean = canonicalRelPath.replace(/^\/+/, "")
  if (!clean.startsWith("wiki/media/")) {
    return canonicalRelPath
  }
  if (form === "source") {
    // ../../wiki/media/…
    return `../../${clean}`
  }
  // wiki form: drop the leading `wiki/` and prepend `../`
  //   wiki/media/notes/foo-abc12345.png → ../media/notes/foo-abc12345.png
  return `../${clean.slice("wiki/".length)}`
}

// Zero-width whitespace chars that should be stripped from alt text
// before emission. Includes ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D),
// and the byte-order mark (U+FEFF).
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g

/**
 * §7 alt handling — escape, not sanitize. Author or VLM alt text is
 * emitted such that a CommonMark parser round-trips back to the
 * original semantic content:
 *
 * - `]` → `\]` (CommonMark parsers reverse the backslash-escape on
 *   read, preserving citation-style `[N]` markers)
 * - Newlines and tabs → single space (image alt is single-line)
 * - Zero-width chars stripped
 * - Backslash before `]` in the input is preserved verbatim (we do
 *   NOT double-escape an already-escaped bracket).
 *
 * The generator never emits `<img>`, angle-bracket URLs, or reference
 * links — see §7 top-of-file.
 */
export function formatImageAlt(alt: string): string {
  if (alt.length === 0) return ""
  // Normalize whitespace first so escape logic sees a clean stream.
  let out = alt
    .replace(ZERO_WIDTH_RE, "")
    .replace(/[\r\n\t]+/g, " ")
  // Escape unescaped `]`. A single character walk keeps this cheap and
  // avoids regex-driven double-escapes of `\]` sequences the caller
  // may have already produced.
  let escaped = ""
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]
    if (ch === "]") {
      // Look back one char — if it's a backslash, leave the input as-is.
      if (i > 0 && out[i - 1] === "\\") {
        escaped += ch
      } else {
        escaped += "\\]"
      }
    } else {
      escaped += ch
    }
  }
  // Collapse runs of whitespace introduced by the newline replacement.
  return escaped.replace(/  +/g, " ")
}

/**
 * §7 title handling — sanitize, not escape. Titles are decorative
 * (hover tooltip) and CJK-friendly emission matters more than
 * round-trip fidelity:
 *
 * - `"` → `\u201D` (right double curly quote, uniform substitution)
 * - Newlines and tabs → single space
 * - Zero-width chars stripped
 *
 * Backslashes are left as-is; single quotes are left as-is because
 * the emitted form always wraps in double quotes.
 */
export function formatImageTitle(title: string): string {
  if (title.length === 0) return ""
  return title
    .replace(ZERO_WIDTH_RE, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/"/g, "\u201D")
    .replace(/  +/g, " ")
}

/**
 * A single slot to be rewritten. Produced by the main pipeline from
 * the `LocalizedImage[]` list plus per-ref alt/title decisions from
 * the (future) decision matrix. Commit 4a builds these directly from
 * `ref.alt` / `ref.title` — VLM-driven overrides land in Commit 4b.
 */
export interface RewriteSlot {
  /** Offset and length inside the original body — from `ImageRef`. */
  offset: number
  length: number
  /** Project-root-relative canonical path (`wiki/media/<slug>/…`). */
  canonicalRelPath: string
  /** Final alt text to emit (verbatim, before §7 escape). */
  alt: string
  /**
   * Final title to emit (verbatim, before §7 sanitize). Pass
   * `undefined` to omit the title portion entirely; `""` (empty
   * string) means "emit empty double quotes" — usually the caller
   * wants `undefined`.
   */
  title: string | undefined
}

/**
 * Rewrite `![alt](url ...)` occurrences at each recorded offset,
 * emitting the target `pathForm` for each slot's canonical path.
 *
 * Slots are applied in **reverse offset order** so that patching one
 * slot doesn't invalidate the offsets of earlier slots. Slots with
 * overlapping ranges are undefined behavior (the caller — the main
 * pipeline — never produces overlaps because `findImageReferencesWithTitle`
 * yields non-overlapping matches).
 *
 * Emitted form is always double-quoted title, single line:
 *
 *   ![escaped-alt](sanitized-url "sanitized-title")   — with title
 *   ![escaped-alt](sanitized-url)                     — no title
 */
export function rewriteBySlot(
  markdown: string,
  slots: readonly RewriteSlot[],
  form: PathForm,
): string {
  if (slots.length === 0) return markdown
  // Sort a defensive copy in reverse offset order. Callers may pass
  // any order.
  const ordered = [...slots].sort((a, b) => b.offset - a.offset)
  let out = markdown
  for (const slot of ordered) {
    const emittedAlt = formatImageAlt(slot.alt)
    const emittedUrl = pathFormFor(slot.canonicalRelPath, form)
    let replacement: string
    if (slot.title === undefined) {
      replacement = `![${emittedAlt}](${emittedUrl})`
    } else {
      const emittedTitle = formatImageTitle(slot.title)
      replacement = `![${emittedAlt}](${emittedUrl} "${emittedTitle}")`
    }
    out = out.slice(0, slot.offset) + replacement + out.slice(slot.offset + slot.length)
  }
  return out
}

// ---------------------------------------------------------------------------
// Frontmatter `image_sources:` merge (§11) — Commit 4c
// ---------------------------------------------------------------------------
//
// Contract:
//   - Foreign entries (keys NOT matching `^wiki/media/<slug>/<name>-<sha8>.<ext>$`)
//     are preserved VERBATIM in their original order, at the top of the
//     re-emitted `image_sources:` block.
//   - Localizer-owned entries are fully rewritten each run from
//     `localizerEntries` — that's the §11 rule-1 lifecycle (this-run's
//     mapping REPLACES the previous localizer-owned set; entries whose
//     local path is no longer referenced disappear).
//   - The rest of the frontmatter is untouched (targeted regex edit,
//     never a whole-block yaml.dump).
//   - If the caller's `localizerEntries` is empty AND no foreign entries
//     exist, the `image_sources:` block is REMOVED entirely (avoids
//     leaving a phantom `image_sources: {}` behind after the last remote
//     image is deleted).
//
// Key ownership regex — matches the localizer's canonical filename
// shape: `wiki/media/<slug>/<name>-<sha8>.<ext>` where slug and name
// can contain any non-`/` byte and ext is [a-z0-9]+. Anchored with
// `^` and `$` to prevent a `wiki/media/foo/bar/qux-...` (nested subdir)
// from being reclassified as localizer-owned — that shape is a
// future cross-subsystem prefix per §11.5 and stays "foreign".
const LOCALIZER_KEY_RE =
  /^wiki\/media\/[^/]+\/[^/]+-[0-9a-f]{8}\.[a-z0-9]+$/

/**
 * Single entry the localizer contributes to `image_sources:`. `source`
 * is the ORIGINAL URL (remote-http) or a truncated data URI (see
 * `truncateDataUriForFrontmatter`).
 */
export interface FrontmatterImageEntry {
  /** Project-relative local path — the map KEY. */
  localPath: string
  /** Original URL or truncated data-URI marker — the map VALUE. */
  source: string
}

/**
 * Locate the `image_sources:` block within a frontmatter YAML payload,
 * or return null when absent. Matches the block header line plus all
 * indented continuation lines that follow it until the first line at
 * a shallower indent OR the payload end.
 *
 * The returned match is bounded to the YAML payload only (caller
 * substrings the block into `rawBlock` at the right offset).
 */
function findImageSourcesBlockInYaml(
  yamlPayload: string,
): { blockStart: number; blockEnd: number; existingEntries: Record<string, string> } | null {
  // Header on its own line, at column 0. Payload always has trailing
  // newlines from the YAML fence, so `^` is well-defined.
  const headerRe = /^image_sources:[^\S\r\n]*\r?\n/m
  const headerMatch = headerRe.exec(yamlPayload)
  if (!headerMatch) return null
  const blockStart = headerMatch.index
  const contentStart = headerMatch.index + headerMatch[0].length

  // Every following line must start with at least one space to belong
  // to this block. Stop at first zero-indent line or end of payload.
  // Use a regex that preserves the actual line-separator length so
  // `consumed` stays correct on both LF and CRLF payloads.
  const lineRe = /([^\r\n]*)(\r?\n|$)/g
  let consumed = 0
  const entries: Record<string, string> = {}
  let lm: RegExpExecArray | null
  while ((lm = lineRe.exec(yamlPayload.slice(contentStart))) !== null) {
    const line = lm[1]
    const sepLen = lm[2].length
    if (line.length === 0) {
      // Blank line — end of block (YAML treats bare blank as separator).
      break
    }
    if (!/^\s/.test(line)) {
      // Zero-indent line → next top-level YAML key. Stop.
      break
    }
    consumed += line.length + sepLen
    // Parse `  "key": "value"` or `  key: value` (quoted or bare).
    const kv = line.match(/^\s+"?([^"]+?)"?:\s*"?([^"]*?)"?\s*$/)
    if (kv) {
      entries[kv[1]] = kv[2]
    }
    // If the separator was empty we hit the end of the string.
    if (sepLen === 0) break
  }
  const blockEnd = contentStart + consumed
  return { blockStart, blockEnd, existingEntries: entries }
}

/**
 * Serialize a `{ key: value }` mapping into the YAML block body
 * (indented 2-space, double-quoted keys and values, one entry per
 * line, no trailing newline). Values are escaped for YAML double-
 * quote syntax: `"` → `\"`, `\` → `\\`.
 */
function serializeImageSourcesEntries(
  entries: Array<{ localPath: string; source: string }>,
): string {
  if (entries.length === 0) return ""
  return entries
    .map(({ localPath, source }) => {
      const k = escapeYamlDoubleQuoted(localPath)
      const v = escapeYamlDoubleQuoted(source)
      return `  "${k}": "${v}"`
    })
    .join("\n")
}

function escapeYamlDoubleQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * Merge the localizer's current-run entries into the source's
 * frontmatter `image_sources:` block per §11 lifecycle rules. Returns
 * the full rewritten content (frontmatter + body).
 *
 * @param content - full markdown content (with or without frontmatter)
 * @param localizerEntries - THIS run's localizer-owned entries. Empty
 *   array = "this run produced no remote/data-uri images".
 */
export function mergeImageSourcesFrontmatter(
  content: string,
  localizerEntries: FrontmatterImageEntry[],
): string {
  const parsed = parseFrontmatter(content)
  const { rawBlock, body } = parsed
  // Deduplicate localizerEntries by key — later wins, mirrors what a
  // Map produces if the caller happens to pass duplicates.
  const localizerMap = new Map<string, string>()
  for (const e of localizerEntries) {
    localizerMap.set(e.localPath, e.source)
  }
  const currentLocalizerEntries: Array<{ localPath: string; source: string }> =
    [...localizerMap.entries()].map(([localPath, source]) => ({
      localPath,
      source,
    }))

  // Case 1: No frontmatter at all.
  if (rawBlock.length === 0) {
    if (currentLocalizerEntries.length === 0) return content
    const serialized = serializeImageSourcesEntries(currentLocalizerEntries)
    return `---\nimage_sources:\n${serialized}\n---\n${content.startsWith("\n") ? content.slice(1) : content}`
  }

  // Case 2: Frontmatter present. Locate/edit `image_sources:` in-place.
  // `rawBlock` includes opening `---\n`, YAML payload, closing `---\n`.
  const openingFenceMatch = rawBlock.match(/^---\s*\r?\n/)
  const closingFenceMatch = rawBlock.match(/\r?\n---\s*(?:\r?\n|$)/)
  if (!openingFenceMatch || !closingFenceMatch) {
    // Should not happen — parseFrontmatter emits well-formed rawBlock.
    // Defensive: bail out unchanged.
    return content
  }
  const openingLen = openingFenceMatch[0].length
  const closingStart = rawBlock.length - closingFenceMatch[0].length
  const yamlPayload = rawBlock.slice(openingLen, closingStart)

  const found = findImageSourcesBlockInYaml(yamlPayload)
  const foreignEntries: Array<{ localPath: string; source: string }> = []
  if (found) {
    for (const [k, v] of Object.entries(found.existingEntries)) {
      // Localizer-owned entries are replaced wholesale by
      // currentLocalizerEntries. Only foreign entries survive.
      if (!LOCALIZER_KEY_RE.test(k)) {
        foreignEntries.push({ localPath: k, source: v })
      }
    }
  }

  // If no entries at all after merge, drop the block entirely.
  const mergedEntries = [...foreignEntries, ...currentLocalizerEntries]
  const newBlockText =
    mergedEntries.length === 0
      ? ""
      : `image_sources:\n${serializeImageSourcesEntries(mergedEntries)}\n`

  let newYamlPayload: string
  if (found) {
    // Replace the existing block in-place.
    newYamlPayload =
      yamlPayload.slice(0, found.blockStart) +
      newBlockText +
      yamlPayload.slice(found.blockEnd)
  } else if (mergedEntries.length > 0) {
    // No existing block — append before closing fence. Ensure a
    // trailing newline between the previous YAML content and the new
    // block; if payload already ends with \n, don't double up.
    const sep = yamlPayload.length === 0 || yamlPayload.endsWith("\n") ? "" : "\n"
    newYamlPayload = yamlPayload + sep + newBlockText
  } else {
    // No block and nothing to add → payload unchanged.
    newYamlPayload = yamlPayload
  }

  const newRawBlock =
    openingFenceMatch[0] + newYamlPayload + closingFenceMatch[0]
  return newRawBlock + body
}

// ---------------------------------------------------------------------------
// Caption cache (Commit 4b) — writer-side helpers over `.llm-wiki/image-caption-cache.json`
// ---------------------------------------------------------------------------
//
// `image-caption-pipeline.ts` owns the schema (`CaptionEntry`) and the
// reader used by the source-summary safety net (`loadCaptionCache`), but
// its writer helpers are module-private. Rather than widen its public
// surface, the localizer keeps its own read/write over the same file
// path — a documented multi-writer arrangement:
//
//   - Both writers use `SHA-256 of image bytes` as the key.
//   - When both write the same key, last-writer-wins is acceptable:
//     they run in different lifecycles (image-caption-pipeline captions
//     images embedded in the SOURCE by the previous ingestion stage;
//     the localizer captions IMAGES INSIDE THE MARKDOWN BODY discovered
//     at Step 0.4). A caption written by either is content-appropriate
//     for the same bytes.
//   - The schema field additions here (`title`, `originalUrl`) are
//     documented in `image-caption-pipeline.ts` as optional; reading
//     back an entry the localizer wrote is safe from either side.

const CAPTION_CACHE_REL_PATH = ".llm-wiki/image-caption-cache.json"

/**
 * Persisted per-image caption entry. Mirrors
 * `image-caption-pipeline.ts:CaptionEntry` — kept in sync manually
 * because that type is module-private.
 */
interface CaptionCacheEntry {
  caption: string
  mimeType: string
  model: string
  capturedAt: string
  title?: string
  originalUrl?: string
}

type CaptionCache = Record<string /* sha256 of bytes */, CaptionCacheEntry>

async function readCaptionCache(projectPath: string): Promise<CaptionCache> {
  const cachePath = `${normalizePath(projectPath)}/${CAPTION_CACHE_REL_PATH}`
  if (!(await fileExists(cachePath))) return {}
  try {
    const raw = await readFile(cachePath)
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CaptionCache
    }
  } catch (err) {
    console.warn(
      `[localizer] Corrupt caption cache at ${cachePath}, starting empty:`,
      err instanceof Error ? err.message : err,
    )
  }
  return {}
}

async function writeCaptionCache(
  projectPath: string,
  cache: CaptionCache,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.llm-wiki`)
  await writeFile(`${pp}/${CAPTION_CACHE_REL_PATH}`, JSON.stringify(cache, null, 2))
}

// ---------------------------------------------------------------------------
// VLM decision matrix (§1) — Commit 4b
// ---------------------------------------------------------------------------

/**
 * Which per-image outcome the decision matrix landed on. Drives the
 * per-image stat counter increment. `captioned` and `cache-hit` both
 * mean the ref gets alt+title from VLM (fresh call vs cached call);
 * `captioned` also counts a network call.
 */
type VlmOutcome =
  | "captioned"
  | "cache-hit"
  | "skipped-author-alt"
  | "skipped-too-small"
  | "skipped-no-vlm-provider"
  | "skipped-already-localized"
  | "failed"

/**
 * Whitespace-only alt is treated as empty per §1 (test case 9).
 * `"image"` (single generic word) is treated as non-empty per test 10.
 */
function isAltEmpty(alt: string): boolean {
  return alt.trim().length === 0
}

/**
 * Default `probeImageDimensions` implementation for production callers
 * (Tauri webview). Uses `createImageBitmap`, which understands PNG /
 * JPEG / WebP / GIF and returns SVG at its rasterized bounds.
 *
 * Returns `{ width: 0, height: 0 }` on decode failure — the caller
 * (`decideVlmOutcome`) treats zero dimensions as "unknown, run VLM"
 * per §2 ("SVG or decode failure → treated as over threshold").
 */
async function defaultProbeImageDimensions(
  mimeType: string,
  bytes: Uint8Array,
): Promise<{ width: number; height: number }> {
  // SVG can't go through createImageBitmap reliably across all
  // Chromium versions; treat as unknown.
  if (mimeType === "image/svg+xml") return { width: 0, height: 0 }
  try {
    // Node/jsdom test paths inject their own probe so this branch is
    // only exercised in the Tauri webview.
    if (typeof createImageBitmap !== "function") {
      return { width: 0, height: 0 }
    }
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const blob = new Blob([buf], { type: mimeType })
    const bmp = await createImageBitmap(blob)
    const out = { width: bmp.width, height: bmp.height }
    bmp.close()
    return out
  } catch {
    return { width: 0, height: 0 }
  }
}

/**
 * Extract full SHA-256 hex for a bytes buffer. Used as the caption
 * cache key and the URL cache digest. Same TS-strict-mode ArrayBuffer
 * dance as `sha8OfBytes`.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Split a VLM caption into `{ alt, title }`. Contract with the caption
 * prompt (see `vision-caption.ts:CAPTION_PROMPT`): the caption is a
 * single flowing paragraph of plain text with no line breaks, so the
 * common case is `lines.length === 1` → alt = full caption, title =
 * undefined. The multi-line branch is a defensive fallback for models
 * that ignore the no-line-breaks instruction: first line becomes `alt`
 * and the rest joined with " " becomes `title`.
 *
 * The alt/title returned here go through `formatImageAlt` /
 * `formatImageTitle` in `rewriteBySlot` — this function does NOT do
 * the §7 escape/sanitize. It only splits.
 */
function splitCaptionIntoAltAndTitle(
  caption: string,
): { alt: string; title: string | undefined } {
  const trimmed = caption.trim()
  if (trimmed.length === 0) return { alt: "", title: undefined }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length <= 1) {
    return { alt: trimmed, title: undefined }
  }
  return {
    alt: lines[0].trim(),
    title: lines.slice(1).map((l) => l.trim()).join(" "),
  }
}

/**
 * Minimal p-limit-style concurrency limiter — private to this module
 * so we don't pull `p-limit` into the dep tree just for this. Preserves
 * order of resolution matching order of the input array (unlike
 * `Promise.all` with `Promise.race`-based reordering).
 */
function pLimit<T>(
  concurrency: number,
): (fn: () => Promise<T>) => Promise<T> {
  const cap = Math.max(1, Math.floor(concurrency))
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    if (active >= cap) return
    const runner = queue.shift()
    if (runner) runner()
  }
  return (fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const runner = () => {
        active += 1
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1
            next()
          })
      }
      queue.push(runner)
      next()
    })
}

// ---------------------------------------------------------------------------
// Public entry — main pipeline (Commit 3c; no VLM, no body rewrite)
// ---------------------------------------------------------------------------

/**
 * One localized image on the way into `SavedImage[]`. Internal shape;
 * `localizeMarkdownImages` converts these into the public `SavedImage`.
 */
interface LocalizedImage {
  ref: ImageRef
  sha8: string
  /** Full SHA-256 hex, used as caption cache key. Empty for `already-localized`. */
  sha256: string
  mimeType: string
  width: number
  height: number
  /** Absolute filesystem path where the bytes were written. */
  absPath: string
  /** Project-root-relative path (e.g. `wiki/media/slug/foo-abc12345.png`). */
  relPath: string
  /** For remote-http and data-uri: original URL for frontmatter mapping. */
  originalUrl: string | undefined
  /** Byte length — recorded for stats/telemetry. */
  bytesLen: number
  /** Which classification path produced this image. */
  origin: "remote-http" | "data-uri" | "local-relative" | "already-localized"
  /**
   * Base64-encoded bytes captured during Step-1 I/O, retained ONLY when
   * the ref is captionable (empty author alt + captionable classification).
   * Reused for `captionImage`. `undefined` when we don't intend to caption
   * this image (author alt non-empty, provider gate closed, etc.) so we
   * don't hold big buffers alive for nothing.
   */
  base64ForCaption: string | undefined
  /** Final alt to emit — starts as ref.alt; VLM overwrites when applicable. */
  finalAlt: string
  /** Final title to emit — starts as ref.title; VLM overwrites when applicable. */
  finalTitle: string | undefined
  /**
   * Which decision matrix cell this ended up in. Written by the
   * decision-matrix pass so the stats-increment step doesn't have to
   * re-derive from the state.
   */
  vlmOutcome: VlmOutcome
}

/**
 * Main entry: for every `![alt](url ...)` reference in `opts.markdown`,
 * resolve/download/copy the bytes into `wiki/media/<slug>/`, dedup
 * by content SHA, update the URL cache, run the v3 decision matrix
 * (author-alt / provider gate / size threshold) to decide whether
 * to call the VLM, and emit two rewritten forms of the body plus
 * `SavedImage[]` and a `stats` summary.
 */
export async function localizeMarkdownImages(
  opts: LocalizeOptions,
): Promise<LocalizeResult> {
  const {
    projectPath,
    sourcePath,
    sourceSummarySlug,
    markdown,
    llmConfig,
    multimodalConfig,
    signal,
    onProgress,
    outputLanguage,
    probeImageDimensions,
  } = opts

  const pp = normalizePath(projectPath)
  const sourceDir = normalizePath(sourcePath).replace(/\/[^/]+$/, "")
  const mediaDir = `${pp}/wiki/media/${sourceSummarySlug}`
  const now = Date.now()
  const timeoutMs =
    multimodalConfig.imageFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const ttlDays = multimodalConfig.urlCacheTtlDays ?? 45
  const minPixel = multimodalConfig.minImagePixelSize ?? 100
  const concurrency = multimodalConfig.concurrency ?? 4
  const probe = probeImageDimensions ?? defaultProbeImageDimensions

  // §1 Provider capability gate — evaluated ONCE, up front.
  const canRunVlm = llmConfig?.provider !== "codex-cli"

  const refs = findImageReferencesWithTitle(markdown)
  const stats: LocalizeResult["stats"] = {
    downloaded: 0,
    urlCacheHits: 0,
    copied: 0,
    decoded: 0,
    alreadyLocalized: 0,
    captioned: 0,
    captionCacheHits: 0,
    skippedAuthorAlt: 0,
    skippedTooSmall: 0,
    skippedNoVlmProvider: 0,
    failed: 0,
    metadataEmbedded: 0,
    metadataSkipped: 0,
  }

  if (refs.length === 0) {
    return {
      rewrittenSourceMarkdown: markdown,
      rewrittenWikiMarkdown: markdown,
      savedImages: [],
      frontmatterEntries: [],
      stats,
    }
  }

  await createDirectory(mediaDir)

  // In-run URL cache snapshot to avoid re-reading disk between refs;
  // updates are still persisted per-image via `upsertUrlCacheEntry` to
  // survive interleaved runs (§3.2 concurrency note).
  const urlCache = await readUrlCache(projectPath)

  // -------------------------------------------------------------------
  // Phase 1: I/O — classify + fetch/copy/decode. Concurrency-bounded.
  // -------------------------------------------------------------------
  const limit = pLimit<LocalizedImage | null>(concurrency)
  const phase1Total = refs.length
  let phase1Done = 0

  const phase1Tasks = refs.map((ref) =>
    limit(async (): Promise<LocalizedImage | null> => {
      if (signal?.aborted) return null
      try {
        const cls = await classifyImageUrl(ref.url, sourceDir, projectPath)
        switch (cls) {
          case "already-localized": {
            stats.alreadyLocalized += 1
            const { absPath } = resolveLocalRelative(
              ref.url,
              sourceDir,
              projectPath,
            )
            const relPath = absPath.startsWith(pp + "/")
              ? absPath.slice(pp.length + 1)
              : absPath
            return {
              ref,
              sha8: "",
              sha256: "",
              mimeType: "",
              width: 0,
              height: 0,
              absPath,
              relPath,
              originalUrl: undefined,
              bytesLen: 0,
              origin: "already-localized",
              base64ForCaption: undefined,
              finalAlt: ref.alt,
              finalTitle: ref.title,
              vlmOutcome: "skipped-already-localized",
            }
          }
          case "remote-http": {
            const result = await handleRemoteHttp(ref.url, {
              projectPath,
              pp,
              mediaDir,
              sourceSummarySlug,
              urlCache,
              ttlDays,
              timeoutMs,
              now,
              signal,
            })
            if (result.cacheHit) stats.urlCacheHits += 1
            else stats.downloaded += 1
            return {
              ref,
              sha8: result.sha8,
              sha256: result.sha256,
              mimeType: result.mimeType,
              width: result.width,
              height: result.height,
              absPath: result.absPath,
              relPath: result.relPath,
              originalUrl: ref.url,
              bytesLen: result.bytesLen,
              origin: "remote-http",
              // Only retain base64 when the ref is a caption candidate.
              base64ForCaption:
                canRunVlm && isAltEmpty(ref.alt) && result.bytesB64
                  ? result.bytesB64
                  : undefined,
              finalAlt: ref.alt,
              finalTitle: ref.title,
              vlmOutcome: "failed", // Phase 2 overwrites
            }
          }
          case "data-uri": {
            const result = await handleDataUri(ref.url, {
              mediaDir,
              pp,
            })
            stats.decoded += 1
            return {
              ref,
              sha8: result.sha8,
              sha256: result.sha256,
              mimeType: result.mimeType,
              width: 0,
              height: 0,
              absPath: result.absPath,
              relPath: result.relPath,
              originalUrl: ref.url,
              bytesLen: result.bytesLen,
              origin: "data-uri",
              base64ForCaption:
                canRunVlm && isAltEmpty(ref.alt) ? result.bytesB64 : undefined,
              finalAlt: ref.alt,
              finalTitle: ref.title,
              vlmOutcome: "failed",
            }
          }
          case "local-relative": {
            const result = await handleLocalRelative(ref.url, {
              sourceDir,
              projectPath,
              mediaDir,
              pp,
            })
            stats.copied += 1
            return {
              ref,
              sha8: result.sha8,
              sha256: result.sha256,
              mimeType: result.mimeType,
              width: 0,
              height: 0,
              absPath: result.absPath,
              relPath: result.relPath,
              originalUrl: undefined,
              bytesLen: result.bytesLen,
              origin: "local-relative",
              base64ForCaption:
                canRunVlm && isAltEmpty(ref.alt) ? result.bytesB64 : undefined,
              finalAlt: ref.alt,
              finalTitle: ref.title,
              vlmOutcome: "failed",
            }
          }
          case "unsupported":
          case "failed":
          default: {
            stats.failed += 1
            console.warn(
              `[localizer] Skipping image (${cls}): ${ref.url.slice(0, 120)}`,
            )
            return null
          }
        }
      } catch (err) {
        stats.failed += 1
        console.warn(
          `[localizer] Failed to localize ${ref.url.slice(0, 120)}: `,
          err instanceof Error ? err.message : err,
        )
        return null
      } finally {
        phase1Done += 1
        onProgress?.(phase1Done, phase1Total, "download")
      }
    }),
  )

  const phase1Results = await Promise.all(phase1Tasks)
  const localized: LocalizedImage[] = phase1Results.filter(
    (li): li is LocalizedImage => li !== null,
  )

  // -------------------------------------------------------------------
  // Phase 2: VLM decision matrix — per §1 + §2. Runs serially by design:
  // caption-cache updates read-modify-write the same JSON file, and
  // captionImage is already IO-bound (network + LLM), so per-image
  // concurrency doesn't help meaningfully. Provider gate closes the
  // entire phase early.
  // -------------------------------------------------------------------
  const captionCache: CaptionCache = await readCaptionCache(projectPath)
  let captionCacheDirty = false
  const captionTotal = localized.filter(
    (li) => li.base64ForCaption !== undefined,
  ).length
  let captionDone = 0

  for (const li of localized) {
    if (signal?.aborted) break
    // Already-localized refs bypass every axis.
    if (li.origin === "already-localized") {
      li.vlmOutcome = "skipped-already-localized"
      continue
    }
    // Axis B: author alt non-empty → skip VLM, preserve verbatim.
    if (!isAltEmpty(li.ref.alt)) {
      stats.skippedAuthorAlt += 1
      li.vlmOutcome = "skipped-author-alt"
      continue
    }
    // §1 Provider gate: closed → skip VLM for every empty-alt image
    // in the batch. I/O already ran; alt/title stay verbatim (empty).
    if (!canRunVlm) {
      stats.skippedNoVlmProvider += 1
      li.vlmOutcome = "skipped-no-vlm-provider"
      continue
    }
    // §3.1 Caption cache: keyed by full SHA-256 of image bytes.
    // Same image ref'd in N places → 1 VLM call across the whole
    // project's history.
    const cached = captionCache[li.sha256]
    if (cached && cached.caption.trim().length > 0) {
      stats.captionCacheHits += 1
      const split = splitCaptionIntoAltAndTitle(cached.caption)
      li.finalAlt = split.alt
      li.finalTitle = cached.title ?? split.title ?? li.ref.title
      li.vlmOutcome = "cache-hit"
      continue
    }
    // §2 Threshold: probe dimensions, skip if under threshold on EITHER
    // axis. Unknown dims (probe returned 0) → treat as over threshold
    // so we don't miss real charts on decode failure.
    let dims = { width: li.width, height: li.height }
    if (li.base64ForCaption && (dims.width === 0 || dims.height === 0)) {
      // Decode base64 → bytes for the probe. Skip probe on empty base64.
      const bytes = base64ToBytes(li.base64ForCaption)
      dims = await probe(li.mimeType, bytes)
      li.width = dims.width
      li.height = dims.height
    }
    const knownDims = dims.width > 0 && dims.height > 0
    if (knownDims && (dims.width < minPixel || dims.height < minPixel)) {
      stats.skippedTooSmall += 1
      li.vlmOutcome = "skipped-too-small"
      continue
    }
    // §1 Axis B empty alt + captionable → call VLM.
    if (!li.base64ForCaption) {
      // Defensive: bytes were not retained (e.g. URL cache hit skips
      // re-read). VLM can't run without bytes — count as skipped.
      // Reuses the too-small bucket to avoid adding a new stat field;
      // the per-image vlmOutcome still records the real reason.
      li.vlmOutcome = "skipped-too-small"
      stats.skippedTooSmall += 1
      continue
    }
    try {
      const caption = await captionImage(
        li.base64ForCaption,
        li.mimeType,
        llmConfig,
        signal,
        { outputLanguage },
      )
      stats.captioned += 1
      captionDone += 1
      onProgress?.(captionDone, captionTotal, "caption")
      const split = splitCaptionIntoAltAndTitle(caption)
      li.finalAlt = split.alt
      li.finalTitle = split.title ?? li.ref.title
      li.vlmOutcome = "captioned"
      captionCache[li.sha256] = {
        caption,
        mimeType: li.mimeType,
        model: multimodalConfig.model ?? llmConfig.model ?? "unknown",
        capturedAt: new Date().toISOString(),
        title: split.title,
        originalUrl: li.originalUrl,
      }
      captionCacheDirty = true
    } catch (err) {
      // Caption failure is isolated: this image keeps empty alt,
      // batch continues. Not counted as `failed` (I/O succeeded);
      // logged for diagnostics.
      console.warn(
        `[localizer] Caption failed for ${li.ref.url.slice(0, 120)}: `,
        err instanceof Error ? err.message : err,
      )
      li.vlmOutcome = "failed"
    }
  }

  if (captionCacheDirty) {
    await writeCaptionCache(projectPath, captionCache)
  }

  // -------------------------------------------------------------------
  // Phase 3: Metadata embedding — write VLM-generated alt/title into
  // the image file's own metadata (XMP/EXIF/IPTC/PNG text chunks).
  // Runs after files are on disk and VLM captions are finalized.
  // Non-fatal: failures are counted in stats but never abort the batch.
  // -------------------------------------------------------------------
  const embedCandidates = localized.filter(
    (li) =>
      li.origin !== "already-localized" &&
      (li.vlmOutcome === "captioned" || li.vlmOutcome === "cache-hit"),
  )
  for (const li of embedCandidates) {
    if (signal?.aborted) break
    const alt = li.finalAlt
    const title = li.finalTitle ?? ""
    if (!alt && !title) {
      stats.metadataSkipped += 1
      continue
    }
    const result = await embedImageMetadata({
      absPath: li.absPath,
      alt,
      title,
      mimeType: li.mimeType,
    })
    if (result.written) stats.metadataEmbedded += 1
    else stats.metadataSkipped += 1
  }

  const savedImages: SavedImage[] = localized
    .filter((li) => li.origin !== "already-localized")
    .map((li, index) => ({
      index,
      mimeType: li.mimeType,
      page: null,
      width: li.width,
      height: li.height,
      relPath: li.relPath.startsWith("wiki/")
        ? li.relPath.slice("wiki/".length)
        : li.relPath,
      absPath: li.absPath,
      sha256: li.sha256 || li.sha8,
    }))

  // Build rewrite slots from the FINAL alt/title values set by the
  // decision matrix. `already-localized` refs are intentionally
  // skipped — see the §5 fall-through contract in the module header.
  const slots: RewriteSlot[] = localized
    .filter((li) => li.origin !== "already-localized")
    .map((li) => ({
      offset: li.ref.offset,
      length: li.ref.length,
      canonicalRelPath: li.relPath,
      alt: li.finalAlt,
      title: li.finalTitle,
    }))
  const rewrittenSourceMarkdown = rewriteBySlot(markdown, slots, "source")
  const rewrittenWikiMarkdown = rewriteBySlot(markdown, slots, "wiki")

  // §11 frontmatter mapping: only remote-http + data-uri qualify.
  // Data-URI values are truncated to keep the frontmatter block readable.
  const frontmatterEntries: FrontmatterImageEntry[] = localized
    .filter(
      (li) =>
        (li.origin === "remote-http" || li.origin === "data-uri") &&
        li.originalUrl !== undefined,
    )
    .map((li) => ({
      localPath: li.relPath,
      source:
        li.origin === "data-uri"
          ? truncateDataUriForFrontmatter(li.originalUrl!)
          : li.originalUrl!,
    }))

  return {
    rewrittenSourceMarkdown,
    rewrittenWikiMarkdown,
    savedImages,
    frontmatterEntries,
    stats,
  }
}

// ---------------------------------------------------------------------------
// Per-branch handlers (private)
// ---------------------------------------------------------------------------

interface RemoteContext {
  projectPath: string
  pp: string
  mediaDir: string
  sourceSummarySlug: string
  urlCache: UrlCache
  ttlDays: number
  timeoutMs: number
  now: number
  signal: AbortSignal | undefined
}

async function handleRemoteHttp(
  url: string,
  ctx: RemoteContext,
): Promise<{
  sha8: string
  sha256: string
  mimeType: string
  width: number
  height: number
  absPath: string
  relPath: string
  bytesLen: number
  cacheHit: boolean
  /** Base64-encoded bytes for VLM. `undefined` on URL cache hit (bytes not re-read). */
  bytesB64: string | undefined
}> {
  const cached = ctx.urlCache[url]
  if (cached && isUrlCacheEntryFresh(cached, ctx.ttlDays, ctx.now)) {
    // URL cache hit within TTL — canonical file must be readable for
    // the hit to count. If the canonical file was deleted since,
    // fall through to a fresh fetch.
    const canonicalAbs = `${ctx.pp}/${cached.canonicalRelPath}`
    if (await fileExists(canonicalAbs)) {
      return {
        sha8: cached.sha256.slice(0, 8),
        sha256: cached.sha256,
        mimeType: cached.mimeType,
        width: cached.width,
        height: cached.height,
        absPath: canonicalAbs,
        relPath: cached.canonicalRelPath,
        bytesLen: cached.bytesLen,
        cacheHit: true,
        bytesB64: undefined,
      }
    }
  }

  // Cache miss OR expired OR canonical file missing → fetch.
  const { bytes, mimeType } = await fetchRemoteImage(
    url,
    ctx.timeoutMs,
    globalThis.fetch,
    ctx.signal,
  )
  // Single SHA-256 pass — sha8 is the first 8 hex chars of the full
  // digest (avoids a second crypto.subtle.digest on potentially large
  // buffers).
  const fullSha256 = await sha256Hex(bytes)
  const sha8 = fullSha256.slice(0, 8)
  const ext = extFromMime(mimeType)
  const baseName = deriveNameFromUrl(url)
  const fileName = `${baseName}-${sha8}.${ext}`
  const absPath = `${ctx.mediaDir}/${fileName}`
  const relPath = `wiki/media/${ctx.sourceSummarySlug}/${fileName}`

  // If the canonical file already exists (same bytes → same sha8 → same
  // filename), skip the write — copyFile is idempotent but writeFileBase64
  // isn't guaranteed to be atomic on all backends.
  if (!(await fileExists(absPath))) {
    await writeFileBase64(absPath, bytesToBase64(bytes))
  }

  await upsertUrlCacheEntry(ctx.projectPath, url, {
    sha256: fullSha256,
    mimeType,
    width: 0,
    height: 0,
    bytesLen: bytes.byteLength,
    fetchedAt: new Date(ctx.now).toISOString(),
    canonicalRelPath: relPath,
  })

  return {
    sha8,
    sha256: fullSha256,
    mimeType,
    width: 0,
    height: 0,
    absPath,
    relPath,
    bytesLen: bytes.byteLength,
    cacheHit: false,
    bytesB64: bytesToBase64(bytes),
  }
}

interface DataUriContext {
  mediaDir: string
  pp: string
}

async function handleDataUri(
  dataUri: string,
  ctx: DataUriContext,
): Promise<{
  sha8: string
  sha256: string
  mimeType: string
  absPath: string
  relPath: string
  bytesLen: number
  bytesB64: string
}> {
  const { bytes, mimeType } = resolveDataUri(dataUri)
  const sha256 = await sha256Hex(bytes)
  const sha8 = sha256.slice(0, 8)
  const ext = extFromMime(mimeType)
  const fileName = `inline-${sha8}.${ext}`
  const absPath = `${ctx.mediaDir}/${fileName}`
  const relPath = absPath.startsWith(ctx.pp + "/")
    ? absPath.slice(ctx.pp.length + 1)
    : absPath
  if (!(await fileExists(absPath))) {
    await writeFileBase64(absPath, bytesToBase64(bytes))
  }
  return {
    sha8,
    sha256,
    mimeType,
    absPath,
    relPath,
    bytesLen: bytes.byteLength,
    bytesB64: bytesToBase64(bytes),
  }
}

interface LocalRelativeContext {
  sourceDir: string
  projectPath: string
  mediaDir: string
  pp: string
}

async function handleLocalRelative(
  url: string,
  ctx: LocalRelativeContext,
): Promise<{
  sha8: string
  sha256: string
  mimeType: string
  absPath: string
  relPath: string
  bytesLen: number
  bytesB64: string
}> {
  const { absPath: srcAbs } = resolveLocalRelative(
    url,
    ctx.sourceDir,
    ctx.projectPath,
  )
  // Reading via readFile (utf8) would corrupt binary bytes; use the
  // base64 command so we get raw bytes back through a text-safe channel.
  // The command also returns the Rust-side MIME guess, which is more
  // accurate than sniffing the extension.
  const { base64: b64, mimeType: probedMime } = await readFileAsBase64(srcAbs)
  const bytes = base64ToBytes(b64)
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Local image exceeds ${MAX_IMAGE_BYTES} bytes: ${srcAbs}`,
    )
  }
  const sha256 = await sha256Hex(bytes)
  const sha8 = sha256.slice(0, 8)
  const mimeType = probedMime && probedMime.startsWith(IMAGE_MIME_PREFIX)
    ? probedMime
    : extToMime(
        (url.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1] ?? "bin").toLowerCase(),
      )
  const ext = extFromMime(mimeType)
  const baseName = deriveNameFromUrl(url)
  const fileName = `${baseName}-${sha8}.${ext}`
  const absPath = `${ctx.mediaDir}/${fileName}`
  const relPath = absPath.startsWith(ctx.pp + "/")
    ? absPath.slice(ctx.pp.length + 1)
    : absPath
  if (!(await fileExists(absPath))) {
    await copyFile(srcAbs, absPath)
  }
  return {
    sha8,
    sha256,
    mimeType,
    absPath,
    relPath,
    bytesLen: bytes.byteLength,
    bytesB64: b64,
  }
}

/**
 * Extract a filename stem from the URL path, sanitized for filesystem
 * use. Falls back to `"image"` when the URL has no useful basename.
 */
function deriveNameFromUrl(url: string): string {
  try {
    // Try URL parsing first — handles query strings and hashes cleanly.
    const parsed = new URL(
      url,
      // A bogus base is enough to parse relative URLs; we only use
      // `.pathname`.
      "https://placeholder.invalid/",
    )
    const leaf = parsed.pathname.split("/").filter(Boolean).pop() ?? ""
    const stem = leaf.replace(/\.[a-z0-9]+$/i, "")
    const cleaned = stem
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
    return cleaned || "image"
  } catch {
    return "image"
  }
}

/** Inverse of `extFromMime` for a few common extensions. */
function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "gif":
      return "image/gif"
    case "svg":
      return "image/svg+xml"
    case "bmp":
      return "image/bmp"
    case "avif":
      return "image/avif"
    case "heic":
    case "heif":
      return "image/heic"
    case "tiff":
    case "tif":
      return "image/tiff"
    case "ico":
      return "image/x-icon"
    default:
      return "application/octet-stream"
  }
}


