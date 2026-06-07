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
 *   - **A relative src is resolved against the rendering markdown
 *     file's own directory** when that directory is known
 *     (`currentFileDir`). This is how Obsidian — and every other
 *     markdown tool — resolves images, and it's what lets
 *     skill-exported sources work: a `raw/sources/foo.md` that
 *     references `../assets/img.png` correctly lands on
 *     `raw/assets/img.png`.
 *   - When the file's directory is NOT known, a relative src is
 *     treated as relative to the project's `wiki/` root. Generated
 *     wiki content uses this form (`media/foo/img-1.png`) and the
 *     fallback keeps it working for callers that can't supply a
 *     file context (e.g. chat replies).
 *
 * The resolver returns a string that React's <img src=...> can load:
 * the appropriate `convertFileSrc(...)` URL or the original src
 * verbatim.
 */
import { convertFileSrc } from "@tauri-apps/api/core"
import { normalizePath } from "@/lib/path-utils"

const PASSTHROUGH_RE = /^(https?:|data:|blob:|file:|tauri:)/i

/**
 * Collapse `.` and `..` segments in a forward-slashed path without
 * touching the filesystem. A leading `..` that would escape the
 * root is dropped (clamped at root) rather than throwing — image
 * references should degrade gracefully, not crash the renderer.
 */
function collapsePath(p: string): string {
  const isAbsolute = p.startsWith("/")
  const out: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop()
      else if (!isAbsolute) out.push("..")
      // absolute path: `..` above root is simply ignored
    } else {
      out.push(seg)
    }
  }
  return (isAbsolute ? "/" : "") + out.join("/")
}

/**
 * `projectPath` is the wiki project's root directory. When null
 * (no project loaded), the resolver passes srcs through unchanged
 * so it remains safe to call before a project is open.
 *
 * `currentFileDir` is the directory of the markdown file being
 * rendered (absolute, or relative-to-project). When provided,
 * relative image srcs resolve against it — matching how Obsidian
 * and other markdown tools behave. When omitted, relative srcs
 * fall back to being resolved against `<project>/wiki/`.
 */
export function resolveMarkdownImageSrc(
  rawSrc: string,
  projectPath: string | null,
  currentFileDir?: string | null,
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
  // `./media/foo.png` identically.
  const stripped = rawSrc.replace(/^\.\//, "")

  // Decode percent-encoding BEFORE assembling the filesystem path.
  // ReactMarkdown / remark normalize image URLs and percent-encode
  // non-ASCII characters, so a CJK path like
  //   media/易配置平台2.0培训-1/001-x.jpg
  // arrives here as
  //   media/%E6%98%93%E9%85%8D.../001-x.jpg
  // We must turn that back into the literal UTF-8 path that exists on
  // disk — otherwise convertFileSrc() encodes the `%` again (→ %25E6),
  // the asset server looks for a file whose name literally contains
  // "%E6", finds nothing, and the image 404s (showing the alt text).
  // Decoding is wrapped because a malformed `%` sequence throws; in
  // that case we keep the raw value rather than crash the renderer.
  let cleaned: string
  try {
    cleaned = decodeURIComponent(stripped)
  } catch {
    cleaned = stripped
  }

  // Generated-wiki convention takes precedence: ingest always emits
  // embedded images as `media/<source-slug>/img-N.png` — a path
  // relative to the project's `wiki/` ROOT, regardless of which
  // wiki subdirectory the page lives in (`wiki/sources/foo.md`,
  // `wiki/concepts/bar.md`, …). If we let `currentFileDir` win for
  // these, a page in `wiki/sources/` would resolve `media/…` to
  // `wiki/sources/media/…` — one level too deep — and the image
  // 404s. So a `media/`-prefixed src is ALWAYS wiki-root-relative,
  // never file-relative. File-relative refs use `../assets/…` /
  // `./x.png` / bare names and never start with `media/`, so this
  // doesn't steal any of those cases.
  const isGeneratedMediaRef = cleaned.startsWith("media/")

  // Preferred path: resolve relative to the markdown file's own
  // directory, exactly like Obsidian. This is what makes
  // `../assets/img.png` from a file in `raw/sources/` land on the
  // right place. We normalize the dir to be project-absolute first
  // (it may arrive as absolute or as a project-relative path), then
  // collapse `..`/`.` segments.
  if (currentFileDir && !isGeneratedMediaRef) {
    const dir = normalizePath(currentFileDir)
    const dirIsAbsolute =
      dir.startsWith("/") || /^[a-zA-Z]:/.test(dir) || dir.startsWith("\\\\")
    const baseDir = dirIsAbsolute ? dir : `${pp}/${dir}`
    const absolute = collapsePath(`${baseDir.replace(/\/+$/, "")}/${cleaned}`)
    return convertFileSrc(absolute)
  }

  // Fallback: resolve as wiki-root-relative. Image references in
  // generated wiki content use this convention (`media/<slug>/…`)
  // so the path is stable regardless of page depth, and callers
  // without a file context (chat replies) rely on it too.
  const absolute = collapsePath(`${pp}/wiki/${cleaned}`)
  return convertFileSrc(absolute)
}
