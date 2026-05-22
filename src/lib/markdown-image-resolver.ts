/**
 * Resolve markdown image `src` attributes so they actually load in
 * the Tauri webview.
 *
 * The problem: ingest writes images to `<project>/wiki/media/<slug>/`
 * and embeds them in generated wiki pages as
 * `![](media/<slug>/img-1.png)`. A markdown renderer interprets that
 * relative to the rendering page's URL — but in Tauri there IS no
 * URL context for arbitrary file paths, AND the wiki page may be
 * located deeper than `wiki/concepts/foo.md` so naive `../media/...`
 * fixups don't generalize.
 *
 * Convention we settle on:
 *
 *   - Any src starting with `http://`, `https://`, `data:`, `blob:`,
 *     `file:`, `tauri://` is passed through unchanged.
 *   - Any src starting with `/` (absolute) is wrapped with
 *     `convertFileSrc` directly — the path is the filesystem
 *     absolute path.
 *   - **Anything else is treated as relative to the project's
 *     `wiki/` root.** Generated content commonly uses this form
 *     (`media/foo/img-1.png`). Source-summary pages under
 *     `wiki/sources/` may also use `../media/foo/img-1.png`; that is
 *     normalized back to `media/foo/img-1.png` for webview loading.
 *
 * The resolver returns a string that React's <img src=...> can load:
 * the appropriate `convertFileSrc(...)` URL or the original src
 * verbatim.
 */
import { convertFileSrc } from "@tauri-apps/api/core"
import { normalizePath } from "@/lib/path-utils"

const PASSTHROUGH_RE = /^(https?:|data:|blob:|file:|tauri:)/i

/**
 * `projectPath` is the wiki project's root directory. When null
 * (no project loaded), the resolver passes srcs through unchanged
 * so it remains safe to call before a project is open.
 */
export function resolveMarkdownImageSrc(
  rawSrc: string,
  projectPath: string | null,
): string {
  if (!rawSrc) return rawSrc
  if (PASSTHROUGH_RE.test(rawSrc)) return rawSrc

  if (!projectPath) return rawSrc

  const pp = normalizePath(projectPath)
  const isAbsolute =
    rawSrc.startsWith("/") || /^[a-zA-Z]:/.test(rawSrc) || rawSrc.startsWith("\\\\")

  // Absolute paths get fed straight to convertFileSrc — the user (or
  // some plugin) explicitly chose that path; we don't second-guess.
  if (isAbsolute) return convertFileSrc(rawSrc)

  // Strip a leading `./` for cleanliness; treat `media/foo.png` and
  // `./media/foo.png` identically. Source-summary pages use
  // `../media/...` so external Markdown editors resolve images from
  // `wiki/sources/`; in the app we normalize that back to wiki-root
  // media because this resolver intentionally has no page-path context.
  const cleaned = rawSrc
    .replace(/^\.\//, "")
    .replace(/^(\.\.\/)+(?=media\/)/, "")

  // Resolve as wiki-root-relative. The markdown lives somewhere
  // under wiki/ but we ignore its location — image references in
  // generated content always use this convention so the path is
  // stable regardless of page depth.
  const absolute = `${pp}/wiki/${cleaned}`
  return convertFileSrc(absolute)
}
