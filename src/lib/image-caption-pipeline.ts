/**
 * Caption-the-images pipeline + persistent cache.
 *
 * Sits between the Rust extractor (which lands images on disk under
 * `raw/assets/<slug>/`) and the ingest LLM (which sees source
 * markdown with `![](abs_path)` references). The job is twofold:
 *
 *   1. For each image referenced in the source markdown, get a
 *      factual caption from the vision model — using the cache if
 *      we've described those exact bytes before.
 *
 *   2. Rewrite the markdown so each `![](path)` becomes
 *      `![<caption>](path)`. The summarizer LLM stripping empty-alt
 *      images is the failure mode this exists to prevent: an alt-
 *      texted image carries enough semantic load that the model
 *      preserves it through paraphrasing.
 *
 * Cache key = SHA-256 of image bytes. This makes duplicate images
 * across PDFs (logos, page headers, recurring chart templates) a
 * single LLM call across the whole project — without it, a corpus
 * of slide decks with shared brand assets would caption the same
 * logo hundreds of times.
 *
 * Cache file lives at
 *   `<project>/.llm-wiki/image-caption-cache.json`
 * keyed `{ "<sha256>": { caption, mimeType, model, capturedAt } }`.
 * The model + capturedAt fields aren't read by anything yet but
 * shipping the metadata now means we can implement Phase 4's
 * "re-caption with new model" without a second cache version.
 *
 * Why JSON-on-disk and not LanceDB / sqlite: the cache is small
 * (10s of KB on real corpora), human-readable for debugging
 * ("why is this caption wrong?"), and survives `npm run dev`
 * restarts — no migration story needed when the embedding-side
 * schema changes. If we ever cache 100k+ images we'll revisit.
 */
import { writeFile, readFile, createDirectory, fileExists, readFileAsBase64 } from "@/commands/fs"
import { captionImage } from "@/lib/vision-caption"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"

interface CaptionEntry {
  caption: string
  mimeType: string
  model: string
  capturedAt: string
}

type CaptionCache = Record<string, CaptionEntry>

const CACHE_REL_PATH = ".llm-wiki/image-caption-cache.json"

/**
 * Compute SHA-256 of a base64 string by decoding to bytes first
 * (the cache key is the hash of the IMAGE BYTES, not the base64
 * string — same image encoded with different base64 line-wrap
 * settings would otherwise miss the cache).
 *
 * Uses `crypto.subtle` which is available in both Tauri's webview
 * and the Node test environment (since Node 19+ exposes the
 * `webcrypto` shape on `globalThis.crypto`).
 */
async function sha256OfBase64(b64: string): Promise<string> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Public read of the on-disk caption cache. Returns the SHA-256 →
 * caption map, or an empty map when the cache file doesn't exist
 * yet / is corrupt. Callers (the source-summary safety-net
 * injector, search result enrichment, etc.) use this to look up
 * captions by image hash without re-running the LLM.
 */
export async function loadCaptionCache(
  projectPath: string,
): Promise<Map<string, string>> {
  const cache = await readCache(projectPath)
  const out = new Map<string, string>()
  for (const [hash, entry] of Object.entries(cache)) {
    out.set(hash, entry.caption)
  }
  return out
}

async function readCache(projectPath: string): Promise<CaptionCache> {
  const cachePath = `${normalizePath(projectPath)}/${CACHE_REL_PATH}`
  if (!(await fileExists(cachePath))) return {}
  try {
    const raw = await readFile(cachePath)
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CaptionCache
    }
  } catch (err) {
    // Corrupt cache (e.g. truncated mid-write before we added
    // atomic writes) — start fresh rather than wedging the whole
    // ingest pipeline. Log so it's visible in the activity feed.
    console.warn(
      `[caption-cache] corrupt cache at ${cachePath}, starting empty:`,
      err instanceof Error ? err.message : err,
    )
  }
  return {}
}

async function writeCache(projectPath: string, cache: CaptionCache): Promise<void> {
  const pp = normalizePath(projectPath)
  const cachePath = `${pp}/${CACHE_REL_PATH}`
  // `.llm-wiki/` may not exist on a fresh project — create_directory
  // is idempotent and chains parents.
  await createDirectory(`${pp}/.llm-wiki`)
  // Pretty-print at 2 spaces. Cache files end up in user backups
  // and source control sometimes; readability outweighs the small
  // size penalty.
  await writeFile(cachePath, JSON.stringify(cache, null, 2))
}

/**
 * Discover every `![](path)` reference in markdown content.
 * Returns the LITERAL strings (so we can string-replace later)
 * along with the captured path.
 *
 * Scope:
 *   - Standard markdown image syntax: `![alt](url)` — alt is
 *     captured but ignored when deciding whether to caption (we
 *     re-caption even non-empty alt because user-typed alt text
 *     usually says "Figure 3" — useless to retrieval).
 *   - HTML `<img src="...">`: NOT captured by this regex; we
 *     don't generate those, and re-captioning hand-typed HTML
 *     would surprise the user.
 *   - Reference-style images (`![alt][ref]` + `[ref]: url`): NOT
 *     handled — we don't generate them either. Add support if
 *     it matters.
 */
const MD_IMAGE_RE = /(!\[)([^\]]*)(\]\()([^)\s]+)(\))/g

interface ImageRef {
  full: string // the entire `![alt](url)` substring
  alt: string
  url: string
  /** 0-based offset of the match in the source markdown — used to
   *  slice the surrounding text for context-aware captioning. */
  index: number
  /** Length of the entire match including `!`, brackets, parens. */
  length: number
}

/**
 * Window size for context-aware captioning. 150 chars ≈ 30 English
 * words ≈ 1-2 sentences ≈ 1 short paragraph in CJK. Sized to cover
 * the typical "high-signal" zone around an image:
 *
 *   - Figure captions ("Figure 3: Quarterly revenue 2024") sit
 *     immediately after the image and almost always fit in the
 *     first sentence — well under 150 chars.
 *   - Referring sentences ("as shown above", "the chart below
 *     illustrates ...") sit at the END of the preceding paragraph,
 *     also typically the last 1-2 sentences.
 *
 * We initially shipped 500 chars/side. Empirically that included
 * too much unrelated body text on either side of the high-signal
 * zone, which (a) bloated the LLM prompt with noise the model had
 * to actively filter out, and (b) tripled the input-token cost
 * for tiny upside. 150 keeps the figure-caption sweet spot while
 * staying cheap.
 *
 * Tunable here, not in user settings — adding another knob hurts
 * UX more than it helps the rare user with unusual document shape.
 */
const CONTEXT_CHARS = 150

function findImageReferences(markdown: string): ImageRef[] {
  const out: ImageRef[] = []
  // Use exec() in a loop instead of matchAll() so we capture
  // `m.index` (the position in the source) — needed for the
  // context slicer below.
  const re = new RegExp(MD_IMAGE_RE.source, MD_IMAGE_RE.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) {
    out.push({
      full: m[0],
      alt: m[2],
      url: m[4],
      index: m.index,
      length: m[0].length,
    })
  }
  return out
}

/**
 * Slice the chars BEFORE and AFTER an image match in the source
 * markdown. Bounds-safe (window clamps to document edges) and
 * leaves the slices verbatim — no markdown stripping. Other
 * `![](url)` references that fall inside the window remain in the
 * raw text; the model handles them fine and removing them risks
 * hiding "Figure 3 (above) shows ..." style cross-references.
 */
function sliceContext(
  markdown: string,
  ref: ImageRef,
  windowChars: number,
): { before: string; after: string } {
  const beforeStart = Math.max(0, ref.index - windowChars)
  const before = markdown.slice(beforeStart, ref.index)
  const afterStart = ref.index + ref.length
  const after = markdown.slice(afterStart, afterStart + windowChars)
  return { before, after }
}

/**
 * Caption every distinct image referenced in `markdown`, using the
 * cache to skip ones we've already described, then rewrite the
 * markdown to embed each caption as alt text.
 *
 * - Distinct = same SHA-256. Two different paths to the same
 *   image content (e.g. mirrored copies of a logo) caption ONCE
 *   and both refs get the same alt text.
 *
 * - Failures during a single caption call do NOT abort the batch.
 *   That image keeps its original (usually empty) alt text and
 *   the rest of the document still gets enriched. The error is
 *   logged so the activity feed surfaces "captioned 28/30 images
 *   — 2 failed" type info.
 *
 * Returns the rewritten markdown. The caption cache file at
 * `<project>/.llm-wiki/image-caption-cache.json` is updated as a
 * side-effect (atomically at the end, NOT per image — partial
 * writes don't persist if the user cancels mid-batch).
 *
 * `urlToAbsPath` is a hook for path resolution: every image URL
 * we see in the markdown needs to map to an absolute filesystem
 * path so the Rust read_file_as_base64 command can pick up the
 * bytes. The default treats `raw/assets/...` as project-rooted,
 * legacy `media/...` as wiki-rooted, and other relative paths as
 * wiki-rooted.
 */
export interface CaptionPipelineOptions {
  /** Override the default URL→path resolution. */
  urlToAbsPath?: (url: string) => string | null
  /** AbortSignal forwarded to each captionImage call. */
  signal?: AbortSignal
  /**
   * Skip URLs that don't pass this filter — used by autoIngest to
   * caption ONLY the images extracted from the current source
   * (not random user-typed `![](https://example.com/foo.png)`
   * references that would otherwise fail with a bogus path).
   */
  shouldCaption?: (url: string) => boolean
  /**
   * Max parallel caption requests. 1 = strictly sequential.
   * Defaults to 1 to keep the wire-format change non-breaking;
   * the ingest pipeline reads this from `multimodalConfig` and
   * passes the user's chosen value.
   */
  concurrency?: number
  /**
   * Progress hook fired after each image finishes (ok or failed),
   * with running counts. Used by ingest to update the activity
   * feed with "captioning N/M" messages — without it a long
   * captioning run looks like the pipeline is stuck.
   */
  onProgress?: (done: number, total: number) => void
}

export interface CaptionPipelineResult {
  /** Rewritten markdown with captions in alt text. */
  enrichedMarkdown: string
  /** Number of images we captioned via a fresh LLM call. */
  freshCaptions: number
  /** Number of images served from cache. */
  cachedCaptions: number
  /** Number of images we tried to caption but failed (logged). */
  failed: number
}

export async function captionMarkdownImages(
  projectPath: string,
  markdown: string,
  llmConfig: LlmConfig,
  options?: CaptionPipelineOptions,
): Promise<CaptionPipelineResult> {
  const refs = findImageReferences(markdown)
  if (refs.length === 0) {
    return {
      enrichedMarkdown: markdown,
      freshCaptions: 0,
      cachedCaptions: 0,
      failed: 0,
    }
  }

  const filter = options?.shouldCaption ?? (() => true)
  const targetRefs = refs.filter((r) => filter(r.url))
  if (targetRefs.length === 0) {
    return {
      enrichedMarkdown: markdown,
      freshCaptions: 0,
      cachedCaptions: 0,
      failed: 0,
    }
  }

  const cache = await readCache(projectPath)
  let freshCaptions = 0
  let cachedCaptions = 0
  let failed = 0
  const captionByUrl = new Map<string, string>()

  // De-dupe target refs by URL up front. Two refs to the same URL
  // (inline + safety-net section) should share one caption call —
  // and we keep the FIRST occurrence so the context slice anchors
  // to the inline reference (typically richer surrounding text)
  // rather than the safety-net section (where every image is
  // followed by another `![](path)` and very little prose).
  const uniqueRefs: ImageRef[] = []
  const seenUrls = new Set<string>()
  for (const ref of targetRefs) {
    if (seenUrls.has(ref.url)) continue
    seenUrls.add(ref.url)
    uniqueRefs.push(ref)
  }

  const concurrency = Math.max(1, options?.concurrency ?? 1)
  const total = uniqueRefs.length
  let completed = 0

  /**
   * Process one image: read bytes → check hash cache → call LLM
   * if miss → record caption. Returns void; mutates the shared
   * `cache` / `captionByUrl` / counters by closure. Errors are
   * swallowed (per-image fault tolerance) — captioning ONE image
   * shouldn't tank a 30-image batch.
   *
   * IMPORTANT: this function reads from and writes to `cache`
   * concurrently when `concurrency > 1`. JS is single-threaded
   * within a microtask boundary, so the reads/writes themselves
   * don't race, but two concurrent tasks computing the SAME hash
   * may both see "no entry" and both call the LLM. That's fine —
   * we just spend an extra call. The LATER write wins; both
   * captions are valid anyway.
   */
  async function processOne(ref: ImageRef): Promise<void> {
    const cleanedUrl = ref.url.replace(/^\.\//, "")
    const isAbsoluteUrl =
      ref.url.startsWith("/") || /^[a-zA-Z]:/.test(ref.url) || ref.url.startsWith("\\\\")
    const absPath = options?.urlToAbsPath
      ? options.urlToAbsPath(ref.url)
      : isAbsoluteUrl
        ? ref.url
        : cleanedUrl.startsWith("raw/assets/")
          ? `${normalizePath(projectPath)}/${cleanedUrl}`
          : `${normalizePath(projectPath)}/wiki/${cleanedUrl}`
    if (!absPath) {
      failed++
      return
    }

    let bytes: { base64: string; mimeType: string }
    try {
      bytes = await readFileAsBase64(absPath)
    } catch (err) {
      console.warn(
        `[caption-pipeline] failed to read ${absPath}:`,
        err instanceof Error ? err.message : err,
      )
      failed++
      return
    }

    const hash = await sha256OfBase64(bytes.base64)
    const hit = cache[hash]
    if (hit) {
      captionByUrl.set(ref.url, hit.caption)
      cachedCaptions++
      return
    }

    // Slice surrounding text for context-aware captioning. We
    // recompute here (rather than precompute alongside the ref)
    // so the worker pool reads the up-to-date `markdown`
    // closure; cheap (string slice + indexOf is microseconds).
    const { before, after } = sliceContext(markdown, ref, CONTEXT_CHARS)

    try {
      const caption = await captionImage(
        bytes.base64,
        bytes.mimeType,
        llmConfig,
        options?.signal,
        { contextBefore: before, contextAfter: after },
      )
      cache[hash] = {
        caption,
        mimeType: bytes.mimeType,
        model: llmConfig.model,
        capturedAt: new Date().toISOString(),
      }
      captionByUrl.set(ref.url, caption)
      freshCaptions++
    } catch (err) {
      console.warn(
        `[caption-pipeline] caption failed for ${absPath}:`,
        err instanceof Error ? err.message : err,
      )
      failed++
    }
  }

  // Concurrent worker pool. Each worker pulls from a shared index
  // pointer — first worker free grabs the next ref, no fancy queue.
  let nextIdx = 0
  async function worker(): Promise<void> {
    while (true) {
      if (options?.signal?.aborted) return
      const i = nextIdx++
      if (i >= uniqueRefs.length) return
      await processOne(uniqueRefs[i])
      completed++
      options?.onProgress?.(completed, total)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueRefs.length) }, () => worker()),
  )

  // Persist the (possibly grown) cache. Per-image atomic writes
  // would survive crashes mid-batch but every-image-disk-write
  // adds N file syncs to a captioning loop that's already slow;
  // one write at the end is the right trade.
  if (freshCaptions > 0) {
    try {
      await writeCache(projectPath, cache)
    } catch (err) {
      console.warn(
        `[caption-pipeline] failed to persist cache:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // Rewrite the markdown — replace every captured image ref's alt
  // text with its caption. We use a callback-style replace rather
  // than running findImageReferences twice so we can sanitize the
  // alt text inline (no `]` characters or newlines, both of which
  // would break the markdown).
  const enrichedMarkdown = markdown.replace(
    MD_IMAGE_RE,
    (whole, openBang, _alt, closeBracket, url, closeParen) => {
      const caption = captionByUrl.get(url)
      if (!caption) return whole
      const safe = caption
        .replace(/[\r\n]+/g, " ") // collapse newlines
        .replace(/]/g, ")") // ] would close the alt early
        .trim()
      return `${openBang}${safe}${closeBracket}${url}${closeParen}`
    },
  )

  return { enrichedMarkdown, freshCaptions, cachedCaptions, failed }
}

// Exported for direct unit testing — keeps the module surface small
// while letting the test file pin behavior on the helpers.
export const __test = { findImageReferences, sha256OfBase64, MD_IMAGE_RE }
