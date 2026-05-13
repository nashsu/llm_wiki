/**
 * Resolve markdown image `src` attributes so they actually load in
 * the Tauri webview.
 *
 * The problem: ingest writes images to `<project>/raw/assets/<slug>/`
 * and embeds them in generated wiki pages as
 * `![](raw/assets/<slug>/img-1.png)`. A markdown renderer interprets that
 * relative to the rendering page's URL — but in Tauri there IS no
 * URL context for arbitrary file paths, AND the wiki page may be
 * located deeper than `wiki/concepts/foo.md` so naive `../raw/...`
 * fixups don't generalize.
 *
 * Convention we settle on:
 *
 *   - Any src starting with `http://`, `https://`, `data:`, `blob:`,
 *     `file:`, `tauri://` is passed through unchanged.
 *   - Any src starting with `/` (absolute) is wrapped with
 *     `convertFileSrc` directly — the path is the filesystem
 *     absolute path.
 *   - `raw/assets/...` is treated as relative to the project root.
 *   - Legacy `media/...` is treated as `wiki/media/...` so older
 *     projects keep rendering until they are migrated.
 *   - Anything else is treated as relative to the project's `wiki/`
 *     root for user-authored wiki-local images.
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

  // Strip a leading `./` for cleanliness; treat `raw/assets/foo.png`
  // and `./raw/assets/foo.png` identically.
  const cleaned = rawSrc.replace(/^\.\//, "")

  const absolute = cleaned.startsWith("raw/assets/")
    ? `${pp}/${cleaned}`
    : `${pp}/wiki/${cleaned}`
  return convertFileSrc(absolute)
}
