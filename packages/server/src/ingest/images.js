// Image extraction + caption orchestration for the server-driven ingest
// pipeline (issue #14 P0).
//
// Verbatim port of src/lib/extract-source-images.ts plus the image regions
// of src/lib/ingest.ts (appendSavedImageRefsForCaption, the
// extractSourceImagesOnce* memoization, savedImagesFromMineruMarkdown,
// resolveCaptionConfig, the source-content caption gating, and
// injectImagesIntoSourceSummary).
//
// Browser→Node swaps (and only those):
//   • Tauri invoke of extract_and_save_pdf_images_cmd /
//     extract_and_save_office_images_cmd → direct calls into the server's
//     existing extractImageCommands handlers (../commands/extractImages.js),
//     which mirror the Rust wire shapes exactly.
//   • @/commands/fs (createDirectory / fileExists / copyFile /
//     readFileAsBase64 / readFile / writeFile / getFileSize /
//     getFileModifiedTime) → node:fs/promises helpers below.
//   • crypto.subtle SHA-256 → node:crypto (byte-identical hex digests).
//   • zustand store reads (useWikiStore.getState().multimodalConfig) →
//     explicit function parameters.
//   • activity.updateItem(...) progress UI → optional onStatus/onProgress
//     callback parameters (log strings preserved byte-identically).

import { createHash } from "node:crypto"
import { copyFile as fsCopyFile, mkdir, readFile as fsReadFile, stat, writeFile as fsWriteFile } from "node:fs/promises"
import { extractImageCommands } from "../commands/extractImages.js"
import { captionMarkdownImages, loadCaptionCache } from "./image-caption.js"

// ── Inlined from src/lib/path-utils.ts (tiny helpers) ──

/** Normalize a path to use forward slashes (works on both macOS and Windows). */
function normalizePath(p) {
  return p.replace(/\\/g, "/")
}

/** Get the filename from a path (handles both / and \). */
function getFileName(p) {
  const normalized = p.replace(/\\/g, "/")
  return normalized.split("/").pop() ?? p
}

// ── Browser→Node fs boundary (mirrors @/commands/fs semantics) ──

async function createDirectory(path) {
  await mkdir(path, { recursive: true })
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function copyFile(source, destination) {
  await fsCopyFile(source, destination)
}

async function readFile(path) {
  return fsReadFile(path, "utf8")
}

async function writeFile(path, contents) {
  // The Tauri write_file command creates missing parent dirs, so mirror
  // that here.
  await mkdir(path.split("/").slice(0, -1).join("/") || "/", { recursive: true })
  await fsWriteFile(path, contents ?? "", "utf8")
}

async function getFileSize(path) {
  return (await stat(path)).size
}

async function getFileModifiedTime(path) {
  return Math.floor((await stat(path)).mtimeMs)
}

/** Mirror of the Tauri read_file_as_base64 command: base64 bytes. */
async function readFileAsBase64(path) {
  const buf = await fsReadFile(path)
  return { base64: buf.toString("base64") }
}

/**
 * Image extraction orchestration for the ingest pipeline.
 *
 * Pure dispatch + path-shaping layer over the Rust commands
 * `extract_and_save_pdf_images_cmd` / `extract_and_save_office_images_cmd`
 * (on the server: the extractImageCommands handlers that mirror them).
 * Decides which command to call based on file extension, computes the
 * destination directory (`wiki/media/<source-slug>/`), and gives back
 * a small markdown snippet ready to paste into the LLM's source
 * context.
 *
 * NOTE: this layer does NOT call any LLM (no captions yet — that's
 * Phase 3a). The alt text on each image is a placeholder; once
 * captioning lands, the same helper grows a `caption` field per
 * image and the markdown line uses that instead.
 */

/** Mirrors `commands::extract_images::SavedImage` on the Rust side.
 *  @typedef {object} SavedImage
 *  @property {number} index
 *  @property {string} mimeType
 *  @property {number | null} page PDF page or PPTX slide number (1-based). DOCX always null.
 *  @property {number} width
 *  @property {number} height
 *  @property {string} relPath Path relative to the wiki/ root, e.g. `media/rope-paper/img-1.png`.
 *  @property {string} absPath Absolute filesystem path — used for preview.
 *  @property {string} sha256
 */

/** File extensions we currently extract images from. Excludes XLS/XLSX
 *  because spreadsheets generally don't have charts as images (charts
 *  are XML-rendered shapes, not embedded raster). Adding them later is
 *  a one-line change here. */
const SUPPORTED_PDF_EXTS = ["pdf"]
const SUPPORTED_OFFICE_EXTS = ["pptx", "docx"]
// Legacy binary .doc/.ppt text extraction is handled separately; image
// extraction here is ZIP-based and only supports OOXML files.
const MARKDOWN_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "svg",
])

function dirname(path) {
  const idx = normalizePath(path).lastIndexOf("/")
  return idx >= 0 ? normalizePath(path).slice(0, idx) : ""
}

function isRemoteOrDataImageRef(raw) {
  return /^(https?:|data:|blob:|file:|tauri:)/i.test(raw)
}

function cleanMarkdownImageRef(raw) {
  const stripped = raw.trim().replace(/^<(.+)>$/, "$1")
  try {
    return decodeURIComponent(stripped)
  } catch {
    return stripped
  }
}

function imageMimeType(path) {
  const ext = getFileName(path).split(".").pop()?.toLowerCase() ?? ""
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    case "bmp":
      return "image/bmp"
    case "svg":
      return "image/svg+xml"
    case "tif":
    case "tiff":
      return "image/tiff"
    default:
      return "application/octet-stream"
  }
}

function uniqueDestName(index, sourcePath) {
  const name = getFileName(sourcePath).replace(/[<>:"|?*\x00-\x1f]/g, "_")
  return `${String(index).padStart(3, "0")}-${name}`
}

async function sha256OfFile(path) {
  const buf = await fsReadFile(path)
  return createHash("sha256").update(buf).digest("hex")
}

export function findLocalMarkdownImageRefs(markdown) {
  const refs = []
  const seen = new Set()

  const add = (raw) => {
    const ref = cleanMarkdownImageRef(raw.split("#")[0].split("|")[0])
    if (!ref || isRemoteOrDataImageRef(ref)) return
    const ext = getFileName(ref).split(".").pop()?.toLowerCase() ?? ""
    if (!MARKDOWN_IMAGE_EXTS.has(ext)) return
    const key = normalizePath(ref)
    if (seen.has(key)) return
    seen.add(key)
    refs.push(ref)
  }

  for (const match of markdown.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    add(match[1] ?? "")
  }

  for (const match of markdown.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    add(match[1] ?? "")
  }

  return refs
}

/**
 * Extract every embedded image from `sourcePath` and save them to
 * `<projectPath>/wiki/media/<slug>/`. Returns metadata only — image
 * bytes never traverse JS (the extractor writes directly).
 *
 * Returns `[]` for unsupported file types or when the source has no
 * extractable images. Errors during extraction are logged and returned
 * as an empty array — image extraction failure must NEVER abort the
 * ingest pipeline (which is why this isn't `throws`).
 *
 * By default, `slug` is the basename of the source file without extension.
 * Callers can pass a slug that includes source-folder context so same-named
 * files from different `raw/sources` subdirectories do not collide.
 */
export async function extractAndSaveSourceImages(projectPath, sourcePath, slugOverride) {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const fileName = getFileName(sp)
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""

  const isPdf = SUPPORTED_PDF_EXTS.includes(ext)
  const isOffice = SUPPORTED_OFFICE_EXTS.includes(ext)
  if (!isPdf && !isOffice) return []

  const slug = slugOverride ?? fileName.replace(/\.[^.]+$/, "")
  const destDir = `${pp}/wiki/media/${slug}`
  const relTo = `${pp}/wiki`

  try {
    // Server parity: call the extractImageCommands handlers directly with
    // the exact argument shape the Tauri invoke used ({sourcePath, destDir,
    // relTo}).
    const images = await (isPdf
      ? extractImageCommands.extract_and_save_pdf_images_cmd({ sourcePath: sp, destDir, relTo })
      : extractImageCommands.extract_and_save_office_images_cmd({ sourcePath: sp, destDir, relTo }))
    // Rust's `SavedImage` is `#[serde(rename_all = "camelCase")]`,
    // so the wire format uses `relPath` / `absPath` / `mimeType`.
    // (Note: Tauri's IPC auto-camelCase applies only to command
    // PARAMETER names, never to return-value field names — without
    // the explicit serde attribute on the Rust struct, this filter
    // would drop every item and return `[]` even when extraction
    // wrote images to disk. We had that bug.)
    return images
      .filter((it) => {
        if (!it || typeof it !== "object") return false
        const obj = it
        return (
          typeof obj.index === "number" &&
          typeof obj.relPath === "string" &&
          typeof obj.absPath === "string"
        )
      })
  } catch (err) {
    console.warn(
      `[ingest:images] extraction failed for "${fileName}":`,
      err instanceof Error ? err.message : err,
    )
    return []
  }
}

export async function extractAndSaveMarkdownImages(projectPath, sourcePath, markdown, slugOverride) {
  const refs = findLocalMarkdownImageRefs(markdown)
  if (refs.length === 0) return []

  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const sourceDir = dirname(sp)
  const slug = slugOverride ?? getFileName(sp).replace(/\.[^.]+$/, "")
  const destDir = `${pp}/wiki/media/${slug}`
  const images = []

  try {
    await createDirectory(destDir)
  } catch (err) {
    console.warn("[ingest:images] failed to create markdown image directory:", err)
    return []
  }

  for (const ref of refs) {
    const abs = normalizePath(
      ref.startsWith("/") || /^[a-zA-Z]:/.test(ref) || ref.startsWith("\\\\")
        ? ref
        : `${sourceDir}/${ref}`,
    )
    try {
      if (!(await fileExists(abs))) continue
      const destName = uniqueDestName(images.length + 1, abs)
      const dest = `${destDir}/${destName}`
      await copyFile(abs, dest)
      const sha256 = await sha256OfFile(dest)
      images.push({
        index: images.length + 1,
        mimeType: imageMimeType(dest),
        page: null,
        width: 0,
        height: 0,
        relPath: `media/${slug}/${destName}`,
        absPath: dest,
        sha256,
      })
    } catch (err) {
      console.warn(
        `[ingest:images] markdown image import failed for "${ref}":`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return images
}

/**
 * Build the markdown section to splice into `sourceContent` so the
 * generation LLM sees the available images. Each image is referenced
 * once by its rel_path with a placeholder alt-text (Phase 3a will
 * replace this with VLM-generated captions).
 *
 * Returns an empty string when there are no images — no leading
 * separator gets inserted, which keeps the prompt size unchanged for
 * pure-text documents.
 *
 * Placement: caller appends this AFTER the source's text content so
 * the LLM still reads the document linearly, then sees images at the
 * end with their page numbers as positional anchors. A future
 * refinement (per the plan) is to insert per-page image listings
 * inline at page breaks; that requires the text extractor to emit
 * page boundaries, which it doesn't yet.
 */
export function buildImageMarkdownSection(images, captionsBySha) {
  if (images.length === 0) return ""

  const lines = ["", "", "## Embedded Images", ""]
  // Group by page so the LLM can correlate "Figure 3 mentioned on
  // page 5" with the right image. DOCX images have page=null; they
  // get grouped under "Document":
  const byPage = new Map()
  for (const img of images) {
    const key = img.page == null ? "Document" : `Page ${img.page}`
    const bucket = byPage.get(key)
    if (bucket) bucket.push(img)
    else byPage.set(key, [img])
  }

  // Page-keyed order, with "Document" (DOCX) last when present.
  const ordered = [...byPage.keys()].sort((a, b) => {
    if (a === "Document") return 1
    if (b === "Document") return -1
    const numA = parseInt(a.replace(/\D/g, ""), 10) || 0
    const numB = parseInt(b.replace(/\D/g, ""), 10) || 0
    return numA - numB
  })

  // Sanitize a caption for safe inclusion as alt text — the same
  // rules as the inline-rewrite path: no `]` (would close the alt
  // bracket early), no embedded newlines (would break the markdown
  // image syntax across lines).
  const sanitize = (s) =>
    s.replace(/[\r\n]+/g, " ").replace(/]/g, ")").trim()

  for (const key of ordered) {
    lines.push(`### ${key}`, "")
    for (const img of byPage.get(key) ?? []) {
      // Caption lookup by SHA-256 — same key the caption pipeline
      // uses to dedupe across documents. Falling back to empty alt
      // text if no caption is available for this image (caption
      // pipeline disabled / failed / didn't run yet on cache hit).
      // Empty alt is still better than no image reference at all
      // — the inline LLM-generated text might cite the image by
      // page number anyway.
      const caption = captionsBySha?.get(img.sha256)
      const alt = caption ? sanitize(caption) : ""
      lines.push(`![${alt}](${img.relPath})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

// ── Image regions of src/lib/ingest.ts ──

export function appendSavedImageRefsForCaption(content, images) {
  if (images.length === 0) return content
  const refs = images
    .map((img) => img.relPath)
    .filter(Boolean)
    .map((relPath) => `![](${relPath})`)
  if (refs.length === 0) return content
  return `${content}\n\n## Referenced Local Images\n\n${refs.join("\n")}\n`
}

const ingestImageExtractionPromises = new Map()

export async function imageExtractionKey(projectPath, sourcePath, sourceSummarySlug) {
  const normalizedSource = normalizePath(sourcePath)
  let fingerprint
  try {
    const [size, mtime] = await Promise.all([
      getFileSize(normalizedSource),
      getFileModifiedTime(normalizedSource),
    ])
    fingerprint = `${size}:${mtime}`
  } catch {
    // If the source disappeared or stat fails, avoid reusing a stale
    // promise from a previous ingest of the same path.
    fingerprint = `unstable:${Date.now()}`
  }
  return `${normalizePath(projectPath)}\n${normalizedSource}\n${sourceSummarySlug}\n${fingerprint}`
}

export function rememberImageExtractionByKey(key, promise) {
  ingestImageExtractionPromises.set(key, promise)
  if (ingestImageExtractionPromises.size > 32) {
    const oldest = ingestImageExtractionPromises.keys().next().value
    if (oldest) ingestImageExtractionPromises.delete(oldest)
  }
  promise.catch(() => {
    if (ingestImageExtractionPromises.get(key) === promise) {
      ingestImageExtractionPromises.delete(key)
    }
  })
  return promise
}

export function extractSourceImagesOnceByKey(key, projectPath, sourcePath, sourceSummarySlug) {
  const existing = ingestImageExtractionPromises.get(key)
  if (existing) return existing
  return rememberImageExtractionByKey(
    key,
    extractAndSaveSourceImages(projectPath, sourcePath, sourceSummarySlug),
  )
}

export async function extractSourceImagesOnce(projectPath, sourcePath, sourceSummarySlug) {
  const key = await imageExtractionKey(projectPath, sourcePath, sourceSummarySlug)
  return extractSourceImagesOnceByKey(key, projectPath, sourcePath, sourceSummarySlug)
}

export function isSavedImagePromptUrl(projectPath, sourceSummarySlug, url) {
  return (
    url.startsWith(`${projectPath}/wiki/media/${sourceSummarySlug}/`) ||
    url.startsWith(`media/${sourceSummarySlug}/`)
  )
}

export function promptImageUrlToAbs(projectPath, url) {
  return url.startsWith("media/") ? `${projectPath}/wiki/${url}` : url
}

function imageMimeTypeFromPath(path) {
  const ext = getFileName(path).split(".").pop()?.toLowerCase() ?? ""
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    case "bmp":
      return "image/bmp"
    case "svg":
      return "image/svg+xml"
    case "tif":
    case "tiff":
      return "image/tiff"
    default:
      return "application/octet-stream"
  }
}

async function sha256OfBase64(b64) {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex")
}

export async function savedImagesFromMineruMarkdown(projectPath, sourceSummarySlug, markdown) {
  const pp = normalizePath(projectPath)
  const prefix = `media/${sourceSummarySlug}/mineru/`
  const encodedPrefix = `media/${encodeMarkdownPathSegment(sourceSummarySlug)}/mineru/`
  const refs = []
  const seen = new Set()

  for (const match of markdown.matchAll(/!\[[^\]]*]\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const rawTarget = (match[1] ?? "").trim()
    const url = rawTarget.startsWith("<") && rawTarget.includes(">")
      ? rawTarget.slice(1, rawTarget.indexOf(">"))
      : rawTarget.split(/\s+["']/)[0]
    if (!url) continue
    let decoded = url
    try {
      decoded = decodeURIComponent(url)
    } catch {
      // Keep the raw URL if it is not valid percent-encoding.
    }
    const normalized = normalizePath(decoded.replace(/^\.\//, ""))
    if (!normalized.startsWith(prefix) && !normalized.startsWith(encodedPrefix)) continue
    const relPath = normalized.startsWith(encodedPrefix)
      ? `media/${sourceSummarySlug}/mineru/${normalized.slice(encodedPrefix.length)}`
      : normalized
    if (seen.has(relPath)) continue
    seen.add(relPath)
    refs.push(relPath)
  }

  const images = []
  for (const relPath of refs) {
    const absPath = `${pp}/wiki/${relPath}`
    try {
      const { base64 } = await readFileAsBase64(absPath)
      images.push({
        index: images.length + 1,
        mimeType: imageMimeTypeFromPath(relPath),
        page: null,
        width: 0,
        height: 0,
        relPath,
        absPath,
        sha256: await sha256OfBase64(base64),
      })
    } catch (err) {
      console.warn(
        `[ingest:mineru] failed to read cached MinerU image "${relPath}":`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return images
}

export function stripWikiMediaAbsPaths(projectPath, content) {
  return content.split(`${projectPath}/wiki/media/`).join("media/")
}

export function sourceSummaryMediaRefsForExternalMarkdown(content) {
  return content
    .replace(/(\]\()\.?\/?media\//g, "$1../media/")
    .replace(/(\bsrc=["'])\.?\/?media\//gi, "$1../media/")
}

export function toSourceSummaryImageRef(relPath) {
  const normalized = relPath.replace(/^\.\//, "")
  return normalized.startsWith("media/") ? `../${normalized}` : relPath
}

export function encodeMarkdownPathSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function hasMineruImageRefs(content, sourceSummarySlug) {
  return (
    content.includes(`media/${sourceSummarySlug}/mineru/`) ||
    content.includes(`media/${encodeMarkdownPathSegment(sourceSummarySlug)}/mineru/`)
  )
}

/**
 * Resolve the LLM config that the caption pipeline should use.
 * `null` = captioning is OFF, caller should skip the pipeline
 * entirely. Otherwise either the main `llmConfig` (when
 * `useMainLlm` is set) or the dedicated multimodal endpoint
 * fields, projected into the same `LlmConfig` shape so callers
 * pass it through to `streamChat` unchanged.
 *
 * PORT NOTE: the desktop reads `multimodalConfig` from the wiki store
 * at the call site; on the server it is an explicit parameter.
 */
export function resolveCaptionConfig(mm, mainLlm) {
  if (!mm.enabled) return null
  if (mm.useMainLlm) return mainLlm
  return {
    provider: mm.provider,
    apiKey: mm.apiKey,
    model: mm.model,
    ollamaUrl: mm.ollamaUrl,
    customEndpoint: mm.customEndpoint,
    azureApiVersion: mm.azureApiVersion,
    azureModelFamily: mm.azureModelFamily,
    apiMode: mm.apiMode,
    // The caption helper hits `streamChat` directly, which doesn't
    // care about `maxContextSize` (that field is for the analysis
    // / generation prompt-truncation logic). Keep it set so the
    // shape matches LlmConfig.
    maxContextSize: mainLlm.maxContextSize,
  }
}

/**
 * Step 0.6 caption gating over the source content (verbatim logic from
 * src/lib/ingest.ts's full-pipeline branch). Appends the extracted-image
 * refs, then either strips them again (multimodal disabled), captions them
 * (caption LLM resolved + empty-alt refs present), or passes them through.
 *
 * Master-toggle behavior: when `multimodalConfig.enabled` is
 * false, we don't just skip the caption LLM call — we ALSO
 * strip `![](url)` references from sourceContent before the LLM
 * sees it, AND the caller skips the post-write safety-net injection
 * further down. Net effect: the wiki-side pipeline never references
 * images at all. Without the strip + skip, image references
 * would leak via two paths:
 *   1. The LLM-generation prompt sees them in sourceContent and
 *      can preserve them in the generated wiki pages
 *   2. injectImagesIntoSourceSummary unconditionally appends a
 *      `## Embedded Images` section to wiki/sources/<slug>.md
 * Both paths land image refs into wiki pages, which then get
 * embedded → searchable → visible in the search image grid even
 * though the user disabled captioning. This was the user-
 * surprising behavior that prompted the fix.
 *
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] forwarded to the caption pipeline
 * @param {string} [opts.fileName] source file name for the failure log line
 * @param {(detail: string) => void} [opts.onStatus] activity-feed status hook
 *   (desktop: activity.updateItem(activityId, { detail }))
 * @param {(done: number, total: number) => void} [opts.onProgress]
 *   caption progress hook (desktop: activity.updateItem with
 *   `Captioning images... ${done}/${total}`)
 * @returns {Promise<string>} the (possibly enriched/stripped) source content
 */
export async function applyCaptionGatingToSourceContent(
  pp,
  sourceContent,
  savedImages,
  sourceSummarySlug,
  mmCfg,
  captionLlm,
  { signal, fileName, onStatus, onProgress } = {},
) {
  let enrichedSourceContent = stripWikiMediaAbsPaths(
    pp,
    appendSavedImageRefsForCaption(sourceContent, savedImages),
  )
  if (!mmCfg.enabled && savedImages.length > 0) {
    // Strip `![alt](url)` references — match the same regex shape
    // we use elsewhere for image refs. Preserve a single space
    // where the ref used to sit so adjacent words don't fuse.
    enrichedSourceContent = sourceContent.replace(
      /!\[[^\]]*\]\([^)\s]+\)/g,
      " ",
    )
    console.log(
      `[ingest:caption] disabled — stripped image refs from sourceContent (${savedImages.length} image(s) won't appear in wiki pages)`,
    )
  } else if (
    captionLlm &&
    savedImages.length > 0 &&
    /!\[\]\(/.test(enrichedSourceContent)
  ) {
    onStatus?.("Captioning images...")
    const ourMediaPrefix = `${pp}/wiki/media/${sourceSummarySlug}/`
    try {
      const result = await captionMarkdownImages(pp, enrichedSourceContent, captionLlm, {
        signal,
        // Strict filter: only caption images we know we just
        // extracted into this source's media directory. Skips any
        // pre-existing markdown image refs the user may have typed
        // into the source content (e.g. for hand-authored .md
        // sources).
        shouldCaption: (url) => url.startsWith(ourMediaPrefix) || isSavedImagePromptUrl(pp, sourceSummarySlug, url),
        urlToAbsPath: (url) => promptImageUrlToAbs(pp, url),
        concurrency: mmCfg.concurrency,
        onProgress: (done, total) => onProgress?.(done, total),
      })
      enrichedSourceContent = stripWikiMediaAbsPaths(pp, result.enrichedMarkdown)
      console.log(
        `[ingest:caption] images=${savedImages.length} fresh=${result.freshCaptions} cached=${result.cachedCaptions} failed=${result.failed}`,
      )
    } catch (err) {
      console.warn(
        `[ingest:caption] pipeline failed for "${fileName}":`,
        err instanceof Error ? err.message : err,
      )
      // Fall through with original (empty-alt) source content —
      // captioning failure must NEVER break ingest.
    }
  }
  return enrichedSourceContent
}

async function tryReadFile(path) {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

/**
 * Append (or replace) the embedded-images section on the source-
 * summary page. Idempotent — paired marker comments bracket our
 * injection, so re-running this for the same source either:
 *   - replaces an existing injection in-place (image set changed), or
 *   - leaves an existing injection untouched (image set unchanged).
 *
 * Falls back to creating a minimal source-summary stub if the
 * page doesn't exist yet (covers the cache-hit path where the
 * original LLM-written page may have been deleted by the user but
 * extracted images are still salvageable, and the rare case where
 * the LLM wrote the source page under a slightly-different slug
 * that didn't match `${sourceBaseName}.md`).
 */
export async function injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages) {
  if (savedImages.length === 0) return
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  console.log(`[ingest:diag] injectImagesIntoSourceSummary: target=${sourceSummaryFullPath}, images=${savedImages.length}`)
  try {
    const existing = await tryReadFile(sourceSummaryFullPath)
    console.log(`[ingest:diag] injectImagesIntoSourceSummary: existing file ${existing ? `read OK (${existing.length} chars)` : "MISSING (will write stub)"}`)
    // Load captions from the on-disk cache so the safety-net
    // section embeds caption text as alt — the embedding pipeline
    // indexes whatever's in the wiki page, so without this, search
    // by image content (e.g. "find the chart with revenue data")
    // never matches because alt text was empty.
    const captionsBySha = await loadCaptionCache(pp)
    const newSection = buildImageMarkdownSection(
      savedImages.map((img) => ({
        ...img,
        relPath: toSourceSummaryImageRef(img.relPath),
      })),
      captionsBySha,
    )
    const marker = "<!-- llm-wiki:embedded-images -->"
    const wrapped = `\n\n${marker}\n${newSection.trim()}\n${marker}\n`
    if (existing) {
      // Strip any prior injection (paired markers) so re-ingest
      // doesn't accumulate stale references when images change.
      const stripped = existing.replace(
        new RegExp(`\\n*${marker}[\\s\\S]*?${marker}\\n*`, "g"),
        "",
      )
      await writeFile(sourceSummaryFullPath, stripped.trimEnd() + wrapped)
    } else {
      // Page is missing — write a minimal stub so the user actually
      // sees the images in the file tree. Without this fallback, the
      // images sit in wiki/media/<slug>/ with no .md page referencing
      // them, which means the lint view's orphan-page sweep eventually
      // reaps the media directory (cascadeDeleteWikiPage triggered by
      // a missing source page) — silent loss of extracted images.
      const date = new Date().toISOString().slice(0, 10)
      const stubFrontmatter = [
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
      ].join("\n")
      await writeFile(sourceSummaryFullPath, stubFrontmatter + wrapped)
    }
    console.log(
      `[ingest:images] injected ${savedImages.length} image reference(s) into ${sourceSummaryPath}`,
    )
  } catch (err) {
    console.warn(
      `[ingest:images] failed to append images to ${sourceSummaryPath}:`,
      err instanceof Error ? err.message : err,
    )
  }
}
