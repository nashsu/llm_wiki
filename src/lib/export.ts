/**
 * Export utilities: static Markdown site and PDF export.
 *
 * The wiki lives at `<project>/wiki/` with subdirectories like
 * `concepts/`, `entities/`, `queries/`, plus top-level files
 * `index.md`, `log.md`, `overview.md`.  Images referenced from
 * wiki pages (both `![[image.png]]` and `![alt](path)` forms) are
 * collected and copied into the output.
 */

import {
  readFile,
  writeFile,
  listDirectory,
  createDirectory,
  copyFile,
} from "@/commands/fs"
import { normalizePath, joinPath, getFileName } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all file paths from a FileNode tree. */
function flattenTree(nodes: FileNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.is_dir) {
      if (n.children) out.push(...flattenTree(n.children))
    } else {
      out.push(n.path)
    }
  }
  return out
}

/** Recursively list all files under `dir`. */
async function listAllFiles(dir: string): Promise<string[]> {
  try {
    const tree = await listDirectory(dir)
    return flattenTree(tree)
  } catch {
    return []
  }
}

/**
 * Regex that matches Obsidian wikilinks:
 *   [[page-name]]          -> target="page-name", alias=""
 *   [[path/to/page|text]]  -> target="path/to/page", alias="text"
 *
 * Captures are tolerant of newlines inside brackets (the app writes
 * wikilinks on single lines, but defence-in-depth).
 */
const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g

/**
 * Image embed regexes:
 *   ![[image.png]]          — Obsidian-style embed
 *   ![alt](relative/path)   — standard markdown image
 */
const OBSIDIAN_IMAGE_RE = /!\[\[([^\]|\n]+?)\]\]/g
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

/** Known image extensions used for filtering. */
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico",
])

function isImagePath(p: string): boolean {
  const ext = p.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1")
  return IMAGE_EXTENSIONS.has(ext)
}

// ---------------------------------------------------------------------------
// Static Markdown Site Export
// ---------------------------------------------------------------------------

export interface ExportResult {
  outputDir: string
  pagesExported: number
  imagesExported: number
}

/**
 * Export the entire wiki as a static Markdown site.
 *
 * 1. Copy all `wiki/*.md` files to `<outputDir>/`
 * 2. Convert `[[wikilinks]]` to relative Markdown links
 * 3. Copy referenced images into `<outputDir>/media/`
 * 4. Generate `index.html` with a navigation sidebar
 */
export async function exportAsMarkdownSite(
  projectPath: string,
  outputDir: string,
): Promise<ExportResult> {
  const wikiDir = joinPath(projectPath, "wiki")

  // Create output directories
  await createDirectory(outputDir)
  await createDirectory(joinPath(outputDir, "media"))

  // Collect all markdown files from the wiki
  const allWikiFiles = await listAllFiles(wikiDir)
  const mdFiles = allWikiFiles.filter((f) => f.endsWith(".md"))

  if (mdFiles.length === 0) {
    return { outputDir, pagesExported: 0, imagesExported: 0 }
  }

  // Build a slug -> relative-path map for wikilink resolution.
  // A "slug" is the filename without extension, e.g. "my-page".
  // For files inside subdirectories (concepts/foo.md), the slug
  // can be referenced as "foo" or "concepts/foo".
  const slugToRelPath = new Map<string, string>()
  for (const absPath of mdFiles) {
    const rel = normalizePath(absPath).slice(normalizePath(wikiDir).length + 1)
    const fileName = getFileName(rel)
    const stem = fileName.replace(/\.md$/, "")
    // Map both the short slug and the full relative path (minus .md)
    slugToRelPath.set(stem, rel)
    if (rel.includes("/")) {
      slugToRelPath.set(rel.replace(/\.md$/, ""), rel)
    }
  }

  // Track images we need to copy
  const imagesToCopy = new Map<string, string>() // src abs -> dest rel

  // Process each markdown file
  const pagesForNav: { relPath: string; title: string }[] = []
  let pagesExported = 0

  for (const absPath of mdFiles) {
    const rel = normalizePath(absPath).slice(normalizePath(wikiDir).length + 1)
    const content = await readFile(absPath)

    // Collect images from this file
    collectImages(content, wikiDir, projectPath, imagesToCopy)

    // Convert wikilinks to relative md links
    const converted = convertWikilinksToRelative(content, rel, slugToRelPath)

    // Write to output
    const outPath = joinPath(outputDir, rel)
    // Ensure parent directories exist for nested files
    const parentDir = outPath.substring(0, outPath.lastIndexOf("/"))
    if (parentDir !== outputDir) {
      await createDirectory(parentDir)
    }
    await writeFile(outPath, converted)

    // Build nav entry — derive title from first heading or filename
    const title = extractTitle(content) || rel.replace(/\.md$/, "")
    pagesForNav.push({ relPath: rel, title })
    pagesExported++
  }

  // Copy images
  let imagesExported = 0
  for (const [srcAbs, destRel] of imagesToCopy) {
    try {
      const destAbs = joinPath(outputDir, destRel)
      await copyFile(srcAbs, destAbs)
      imagesExported++
    } catch {
      // Non-fatal: skip images that can't be copied
    }
  }

  // Generate index.html
  const html = generateIndexHtml(pagesForNav)
  await writeFile(joinPath(outputDir, "index.html"), html)

  return { outputDir, pagesExported, imagesExported }
}

/**
 * Extract referenced images from markdown content.
 * Handles both `![[image.png]]` and `![alt](path)` syntax.
 */
function collectImages(
  content: string,
  wikiDir: string,
  projectPath: string,
  imagesToCopy: Map<string, string>,
): void {
  // Obsidian-style ![[image.png]]
  let m: RegExpExecArray | null
  OBSIDIAN_IMAGE_RE.lastIndex = 0
  while ((m = OBSIDIAN_IMAGE_RE.exec(content)) !== null) {
    const ref = m[1].trim()
    if (!isImagePath(ref)) continue
    // Try to resolve: first relative to wikiDir, then projectPath
    const candidates = [
      joinPath(wikiDir, ref),
      joinPath(wikiDir, "media", ref),
      joinPath(projectPath, ref),
    ]
    for (const src of candidates) {
      // Use the filename as the key to avoid duplicates
      const destRel = joinPath("media", getFileName(ref))
      if (!imagesToCopy.has(src)) {
        imagesToCopy.set(src, destRel)
      }
    }
  }

  // Standard markdown ![alt](path)
  MD_IMAGE_RE.lastIndex = 0
  while ((m = MD_IMAGE_RE.exec(content)) !== null) {
    const ref = m[2].trim()
    if (!ref || ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("data:")) continue
    if (!isImagePath(ref)) continue
    const candidates = [
      joinPath(wikiDir, ref),
      joinPath(projectPath, ref),
    ]
    for (const src of candidates) {
      const destRel = joinPath("media", getFileName(ref))
      if (!imagesToCopy.has(src)) {
        imagesToCopy.set(src, destRel)
      }
    }
  }
}

/**
 * Convert `[[wikilinks]]` in `content` to relative Markdown links
 * like `[text](../concepts/page.md)`.
 *
 * `sourceRel` is the relative path of the current file from the wiki
 * root (e.g. "entities/foo.md").
 */
function convertWikilinksToRelative(
  content: string,
  sourceRel: string,
  slugToRelPath: Map<string, string>,
): string {
  if (!content.includes("[[")) return content

  // Preserve fenced code blocks
  const parts = content.split(/(```[\s\S]*?```)/g)
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part // inside code fence
      if (!part.includes("[[")) return part
      return part.replace(
        WIKILINK_RE,
        (_match: string, rawTarget: string, rawAlias?: string) => {
          const target = rawTarget.trim()
          const alias = rawAlias?.trim() ?? ""
          const label = alias.length > 0 ? alias : target

          // Resolve target to a relative path
          const resolved = slugToRelPath.get(target) || slugToRelPath.get(target.toLowerCase())
          if (!resolved) {
            // Unresolved link: leave as plain text
            return label
          }

          // Compute relative path from source to target
          const href = relativeMarkdownPath(sourceRel, resolved)

          // Escape brackets in label
          const escapedLabel = label.replace(/\[/g, "\\[").replace(/\]/g, "\\]")
          return `[${escapedLabel}](${href})`
        },
      )
    })
    .join("")
}

/**
 * Compute a relative path from `fromRel` to `toRel` (both relative
 * to the wiki root).  E.g. from "entities/foo.md" to
 * "concepts/bar.md" => "../concepts/bar.md".
 */
function relativeMarkdownPath(fromRel: string, toRel: string): string {
  const fromParts = fromRel.split("/").slice(0, -1) // drop filename
  const toParts = toRel.split("/")

  // Skip common prefix
  let i = 0
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++
  }

  const upCount = fromParts.length - i
  const upParts = Array(upCount).fill("..")
  const downParts = toParts.slice(i)
  const result = [...upParts, ...downParts].join("/")

  return result || toRel
}

/**
 * Extract the first `# heading` from markdown content.
 */
function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : null
}

/**
 * Generate a simple index.html with a navigation sidebar.
 */
function generateIndexHtml(
  pages: { relPath: string; title: string }[],
): string {
  // Group pages by directory
  const groups = new Map<string, { relPath: string; title: string }[]>()
  const rootPages: { relPath: string; title: string }[] = []

  for (const p of pages) {
    const slashIdx = p.relPath.indexOf("/")
    if (slashIdx === -1) {
      rootPages.push(p)
    } else {
      const dir = p.relPath.substring(0, slashIdx)
      if (!groups.has(dir)) groups.set(dir, [])
      groups.get(dir)!.push(p)
    }
  }

  // Sort each group
  rootPages.sort((a, b) => a.title.localeCompare(b.title))
  for (const list of groups.values()) {
    list.sort((a, b) => a.title.localeCompare(b.title))
  }

  const navItems: string[] = []

  for (const p of rootPages) {
    navItems.push(
      `        <li><a href="${escapeHtml(p.relPath)}">${escapeHtml(p.title)}</a></li>`,
    )
  }

  const sortedDirs = [...groups.keys()].sort()
  for (const dir of sortedDirs) {
    const pages_ = groups.get(dir)!
    const dirLabel = dir.charAt(0).toUpperCase() + dir.slice(1)
    navItems.push(`        <li class="nav-group">${escapeHtml(dirLabel)}</li>`)
    for (const p of pages_) {
      navItems.push(
        `        <li><a href="${escapeHtml(p.relPath)}">${escapeHtml(p.title)}</a></li>`,
      )
    }
  }

  const defaultPage = rootPages[0]?.relPath || ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Wiki Export</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; min-height: 100vh; color: #1a1a1a; background: #fafafa; }
    aside { width: 260px; background: #fff; border-right: 1px solid #e5e5e5; padding: 20px 0; overflow-y: auto; position: fixed; top: 0; bottom: 0; }
    main { margin-left: 260px; flex: 1; padding: 0; }
    h1 { font-size: 18px; font-weight: 600; padding: 0 20px 12px; color: #555; border-bottom: 1px solid #eee; margin-bottom: 8px; }
    ul { list-style: none; }
    li a { display: block; padding: 6px 20px; color: #444; text-decoration: none; font-size: 14px; }
    li a:hover { background: #f0f0f0; color: #111; }
    .nav-group { padding: 12px 20px 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #999; }
    iframe { width: 100%; height: 100vh; border: none; }
  </style>
</head>
<body>
  <aside>
    <h1>Wiki</h1>
    <ul>
${navItems.join("\n")}
    </ul>
  </aside>
  <main>
    <iframe id="content-frame" src="${escapeHtml(defaultPage)}"></iframe>
  </main>
  <script>
    document.querySelectorAll("aside a").forEach(function(a) {
      a.addEventListener("click", function(e) {
        e.preventDefault();
        document.getElementById("content-frame").src = a.getAttribute("href");
      });
    });
  </script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ---------------------------------------------------------------------------
// PDF Export
// ---------------------------------------------------------------------------

/**
 * Export one or more wiki pages as a PDF by rendering them as HTML in a
 * hidden iframe and triggering `window.print()`.
 *
 * This runs entirely in the browser / Tauri webview -- no server-side
 * rendering or external PDF library is needed. The user gets the
 * native print dialog which includes "Save as PDF".
 */
export async function exportAsPdf(
  projectPath: string,
  pagePaths: string[],
): Promise<void> {
  const wikiDir = joinPath(projectPath, "wiki")

  // Read and concatenate all pages
  const contents: string[] = []
  for (const pagePath of pagePaths) {
    const absPath = pagePath.startsWith("/")
      ? pagePath
      : joinPath(wikiDir, pagePath)
    try {
      const content = await readFile(absPath)
      contents.push(content)
    } catch {
      // Skip unreadable pages
    }
  }

  if (contents.length === 0) return

  // Simple markdown-to-HTML conversion for printing.
  // We use a minimal renderer rather than pulling in a heavy dep.
  const htmlBodies = contents.map((md) => markdownToHtml(md))
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Wiki PDF Export</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 700px; margin: 40px auto; color: #1a1a1a; line-height: 1.6; font-size: 14px; }
    h1 { font-size: 22px; margin: 24px 0 12px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
    h2 { font-size: 18px; margin: 20px 0 10px; }
    h3 { font-size: 16px; margin: 16px 0 8px; }
    p { margin: 8px 0; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
    pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; margin: 12px 0; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 3px solid #ddd; padding-left: 12px; color: #666; margin: 12px 0; }
    ul, ol { margin: 8px 0; padding-left: 24px; }
    li { margin: 4px 0; }
    a { color: #2563eb; text-decoration: none; }
    img { max-width: 100%; }
    hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
    table { border-collapse: collapse; margin: 12px 0; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
    th { background: #f9f9f9; }
    .page-break { page-break-after: always; }
  </style>
</head>
<body>
${htmlBodies.join('\n<div class="page-break"></div>\n')}
</body>
</html>`

  // Render in a hidden iframe and print
  printHtml(fullHtml)
}

/**
 * Minimal markdown-to-HTML conversion.
 * Handles headings, bold, italic, code, lists, blockquotes, links,
 * images, and horizontal rules. Not a full CommonMark parser but
 * sufficient for wiki content export.
 */
function markdownToHtml(md: string): string {
  // Strip frontmatter
  let body = md.replace(/^---[\s\S]*?---\n*/, "")

  // Escape HTML entities (except in code blocks)
  const codeBlocks: string[] = []
  body = body.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  const inlineCodes: string[] = []
  body = body.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`
  })

  // Process line by line
  const lines = body.split("\n")
  const result: string[] = []
  let inList = false
  let listType = ""

  for (const line of lines) {
    const trimmed = line.trim()

    // Headings
    if (trimmed.startsWith("### ")) {
      closeList()
      result.push(`<h3>${inlineFormat(trimmed.slice(4))}</h3>`)
      continue
    }
    if (trimmed.startsWith("## ")) {
      closeList()
      result.push(`<h2>${inlineFormat(trimmed.slice(3))}</h2>`)
      continue
    }
    if (trimmed.startsWith("# ")) {
      closeList()
      result.push(`<h1>${inlineFormat(trimmed.slice(2))}</h1>`)
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList()
      result.push("<hr />")
      continue
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      closeList()
      result.push(`<blockquote><p>${inlineFormat(trimmed.slice(2))}</p></blockquote>`)
      continue
    }

    // Unordered list
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList || listType !== "ul") {
        closeList()
        result.push("<ul>")
        inList = true
        listType = "ul"
      }
      result.push(`<li>${inlineFormat(trimmed.replace(/^[-*]\s+/, ""))}</li>`)
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      if (!inList || listType !== "ol") {
        closeList()
        result.push("<ol>")
        inList = true
        listType = "ol"
      }
      result.push(`<li>${inlineFormat(trimmed.replace(/^\d+\.\s+/, ""))}</li>`)
      continue
    }

    // Paragraph / empty line
    closeList()
    if (trimmed === "") {
      continue
    }
    result.push(`<p>${inlineFormat(trimmed)}</p>`)
  }

  closeList()

  // Restore code blocks
  let html = result.join("\n")
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx: string) => codeBlocks[Number(idx)])
  html = html.replace(/\x00INLINECODE(\d+)\x00/g, (_m, idx: string) => inlineCodes[Number(idx)])

  return html

  function closeList() {
    if (inList) {
      result.push(listType === "ul" ? "</ul>" : "</ol>")
      inList = false
    }
  }

  function inlineFormat(text: string): string {
    // Bold
    let t = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    t = t.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<em>$1</em>")
    // Images ![alt](src)
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />')
    // Links [text](href)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    return t
  }
}

/**
 * Render HTML in a hidden iframe and trigger the print dialog.
 */
function printHtml(html: string): void {
  const iframe = document.createElement("iframe")
  iframe.style.position = "fixed"
  iframe.style.right = "0"
  iframe.style.bottom = "0"
  iframe.style.width = "0"
  iframe.style.height = "0"
  iframe.style.border = "none"
  document.body.appendChild(iframe)

  const doc = iframe.contentDocument || iframe.contentWindow?.document
  if (!doc) return

  doc.open()
  doc.write(html)
  doc.close()

  // Wait for content to render, then print
  iframe.onload = () => {
    try {
      iframe.contentWindow?.focus()
      iframe.contentWindow?.print()
    } catch {
      // Fallback: open in new window
      const w = window.open("", "_blank")
      if (w) {
        w.document.open()
        w.document.write(html)
        w.document.close()
      }
    }
    // Clean up after a short delay
    setTimeout(() => {
      document.body.removeChild(iframe)
    }, 1000)
  }
}
