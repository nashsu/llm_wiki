/**
 * Map a wiki-side image reference back to its raw source file.
 *
 * Image URLs we generate always live under
 *   `<project>/raw/assets/<slug>/img-N.<ext>`
 * — emitted either ABSOLUTE (from the unified Rust extractor that
 * runs at `read_file` time) or PROJECT-RELATIVE
 * (`raw/assets/<slug>/img-N.png`, from the post-write safety-net section
 * in `wiki/sources/<slug>.md`). The slug equals the basename of
 * the original raw source file (we wrote it that way at extraction
 * time in `extract_pdf_markdown` / fs.rs's raw-sources-layout
 * heuristic), so finding the raw file is a stem match against
 * `<project>/raw/sources/`.
 *
 * Used in two places that want to "open the original document
 * around this image" rather than its LLM summary:
 *   - search-view's lightbox "Jump to source document" button
 *   - chat references panel's image badge (Phase 4 multimodal UI)
 *
 * Returns null when:
 *   - the URL doesn't match the expected assets-directory shape, OR
 *   - no file with that stem exists under raw/sources/ (e.g. the
 *     user moved / deleted the original after ingest, leaving only
 *     the wiki summary). Callers fall back gracefully.
 */
import { listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"

export async function findRawSourceForImage(
  imageUrl: string,
  projectPath: string,
): Promise<string | null> {
  // Image URLs reach us in TWO shapes:
  //   1. ABSOLUTE: `/Users/.../raw/assets/<slug>/img-N.png`
  //   2. PROJECT-RELATIVE: `raw/assets/<slug>/img-N.png`
  //   3. LEGACY: `/Users/.../wiki/media/<slug>/img-N.png` or
  //      `media/<slug>/img-N.png`
  const m = imageUrl.replace(/\\/g, "/").match(/(?:^|\/)(?:raw\/assets|media)\/([^/]+)\//)
  if (!m) return null
  const slug = m[1]

  let tree: FileNode[]
  try {
    tree = await listDirectory(`${projectPath}/raw/sources`)
  } catch {
    return null
  }

  const findByStem = (nodes: FileNode[]): string | null => {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          const found = findByStem(node.children)
          if (found) return found
        }
        continue
      }
      const stem = node.name.replace(/\.[^.]+$/, "")
      if (stem === slug) return node.path
    }
    return null
  }

  return findByStem(tree)
}

/**
 * Normalize a markdown image URL to the absolute-path form that
 * the unified Rust extractor emits in raw-source previews. Used
 * by jump-to-source code paths that want to set a `<img data-mdsrc>`
 * scroll target on the raw-source preview — the raw side renders
 * absolute URLs, so a wiki-relative URL we got from a wiki page's
 * safety-net section needs to be promoted to absolute first.
 *
 * Idempotent: passing an already-absolute URL returns it unchanged.
 */
export function imageUrlToAbsolute(
  imageUrl: string,
  projectPath: string,
): string {
  const isAbsolute =
    imageUrl.startsWith("/") ||
    /^[a-zA-Z]:/.test(imageUrl) ||
    imageUrl.startsWith("\\\\")
  if (isAbsolute) return imageUrl
  const cleaned = imageUrl.replace(/^\.\//, "")
  const pp = projectPath.replace(/\/+$/, "")
  if (cleaned.startsWith("raw/assets/")) return `${pp}/${cleaned}`
  return `${pp}/wiki/${cleaned}`
}
