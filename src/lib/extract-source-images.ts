/**
 * Image extraction orchestration for the ingest pipeline.
 *
 * Pure dispatch + path-shaping layer over the Rust commands
 * `extract_and_save_pdf_images_cmd` / `extract_and_save_office_images_cmd`.
 * Decides which command to call based on file extension, computes the
 * destination directory (`raw/assets/<source-slug>/`), and gives back
 * a small markdown snippet ready to paste into the LLM's source
 * context.
 *
 * NOTE: this layer does NOT call any LLM. Captioning is handled by
 * `image-caption-pipeline` after extraction, keyed by the image hash.
 */
import { invoke } from "@tauri-apps/api/core"
import { getFileName, normalizePath } from "@/lib/path-utils"

/** Mirrors `commands::extract_images::SavedImage` on the Rust side. */
export interface SavedImage {
  index: number
  mimeType: string
  /** PDF page or PPTX slide number (1-based). DOCX always null. */
  page: number | null
  width: number
  height: number
  /** Path relative to the project root, e.g. `raw/assets/rope-paper/img-1.png`. */
  relPath: string
  /** Absolute filesystem path — used by `convertFileSrc` for preview. */
  absPath: string
  sha256: string
}

/** File extensions we currently extract images from. Excludes XLS/XLSX
 *  because spreadsheets generally don't have charts as images (charts
 *  are XML-rendered shapes, not embedded raster). Adding them later is
 *  a one-line change here. */
const SUPPORTED_PDF_EXTS = ["pdf"] as const
const SUPPORTED_OFFICE_EXTS = ["pptx", "docx", "ppt", "doc"] as const
// Note: ppt / doc (legacy binary formats) won't actually work — they
// aren't ZIP. Listed for completeness; Rust side will return Err which
// the caller treats as "no images" gracefully.

/**
 * Extract every embedded image from `sourcePath` and save them to
 * `<projectPath>/raw/assets/<slug>/`. Returns metadata only — image
 * bytes never traverse JS (the Rust command writes directly).
 *
 * Returns `[]` for unsupported file types or when the source has no
 * extractable images. Errors during extraction are logged and returned
 * as an empty array — image extraction failure must NEVER abort the
 * ingest pipeline (which is why this isn't `throws`).
 *
 * `slug` is the basename of the source file without extension. Same
 * convention the rest of ingest uses (see `wiki/sources/<slug>.md`).
 */
export async function extractAndSaveSourceImages(
  projectPath: string,
  sourcePath: string,
): Promise<SavedImage[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const fileName = getFileName(sp)
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""

  const isPdf = (SUPPORTED_PDF_EXTS as readonly string[]).includes(ext)
  const isOffice = (SUPPORTED_OFFICE_EXTS as readonly string[]).includes(ext)
  if (!isPdf && !isOffice) return []

  const slug = fileName.replace(/\.[^.]+$/, "")
  const destDir = `${pp}/raw/assets/${slug}`
  const relTo = pp

  try {
    const images = await invoke<unknown[]>(
      isPdf ? "extract_and_save_pdf_images_cmd" : "extract_and_save_office_images_cmd",
      { sourcePath: sp, destDir, relTo },
    )
    // Rust's `SavedImage` is `#[serde(rename_all = "camelCase")]`,
    // so the wire format uses `relPath` / `absPath` / `mimeType`.
    // (Note: Tauri's IPC auto-camelCase applies only to command
    // PARAMETER names, never to return-value field names — without
    // the explicit serde attribute on the Rust struct, this filter
    // would drop every item and return `[]` even when extraction
    // wrote images to disk. We had that bug.)
    return images
      .filter((it): it is SavedImage => {
        if (!it || typeof it !== "object") return false
        const obj = it as Record<string, unknown>
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

/**
 * Build the markdown section to splice into `sourceContent` so the
 * generation LLM sees the available images. When captions are
 * available, each image uses the cached factual caption as alt text.
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
export function buildImageMarkdownSection(
  images: SavedImage[],
  captionsBySha?: Map<string, string>,
): string {
  if (images.length === 0) return ""

  const lines: string[] = ["", "", "## Embedded Images", ""]
  // Group by page so the LLM can correlate "Figure 3 mentioned on
  // page 5" with the right image. DOCX images have page=null; they
  // get grouped under "Document":
  const byPage = new Map<string, SavedImage[]>()
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
  const sanitize = (s: string): string =>
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
