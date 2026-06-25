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

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "")
}

function comparePath(path: string): string {
  return /^[a-zA-Z]:/.test(path) ? path.toLowerCase() : path
}

function isInsideProject(path: string, projectPath: string): boolean {
  const root = comparePath(trimTrailingSlash(normalizePath(projectPath)))
  const candidate = comparePath(trimTrailingSlash(normalizePath(path)))
  return candidate === root || candidate.startsWith(`${root}/`)
}

function decodePathSrc(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

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

  // Absolute paths are allowed only inside the current project. This resolver
  // is used for both generated/imported markdown and normal wiki reading, so
  // this intentionally trades off rendering arbitrary external local images
  // for a single safe rule: markdown cannot turn into a project-external local
  // file read through Tauri's asset server. External web URLs still pass
  // through via PASSTHROUGH_RE above.
  if (isAbsolute) {
    const absolute = collapsePath(normalizePath(decodePathSrc(rawSrc)))
    return isInsideProject(absolute, pp) ? convertFileSrc(absolute) : rawSrc
  }

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
  const cleaned = decodePathSrc(stripped)

  // Generated-wiki convention takes precedence: ingest normally emits
  // embedded images as `media/<source-slug>/img-N.png` — a path
  // relative to the project's `wiki/` ROOT. Source-summary pages are
  // written one level deeper (`wiki/sources/*.md`), so we persist those
  // refs as `../media/...` for external Markdown apps such as Obsidian.
  // Treat both forms as wiki-root media refs; otherwise call sites that
  // do not know the current file dir (chat/search snippets) would resolve
  // `../media/...` against `<project>/wiki/` and escape to `<project>/media`.
  const isGeneratedMediaRef =
    cleaned.startsWith("media/") || cleaned.startsWith("../media/")
  const wikiRootMediaPath = cleaned.startsWith("../media/")
    ? cleaned.slice("../".length)
    : cleaned

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
    return isInsideProject(absolute, pp) ? convertFileSrc(absolute) : rawSrc
  }

  // Fallback: resolve as wiki-root-relative. Image references in
  // generated wiki content use this convention (`media/<slug>/…`)
  // so the path is stable regardless of page depth, and callers
  // without a file context (chat replies) rely on it too.
  const absolute = collapsePath(`${pp}/wiki/${wikiRootMediaPath}`)
  return isInsideProject(absolute, pp) ? convertFileSrc(absolute) : rawSrc
}
