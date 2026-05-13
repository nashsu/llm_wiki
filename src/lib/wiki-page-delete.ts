/**
 * Cascade delete for wiki pages.
 *
 * Whenever a wiki page is removed from disk we ALSO need to drop its
 * vector chunks from LanceDB; otherwise the chunks become "phantom"
 * search hits — `searchByEmbedding` returns the orphaned `page_id`
 * but `search.ts` then can't find a matching .md file and silently
 * discards the result, wasting topK slots.
 *
 * This helper consolidates that two-step cleanup so every wiki-page
 * delete path (source-delete cascade in sources-view, orphan-page
 * delete in lint-view, cancelled-ingest cleanup in ingest-queue)
 * uses the SAME slug derivation and order of operations. Without
 * this, each call site reinvented the slug regex slightly
 * differently (`getFileName().replace(/\.md$/, "")` vs
 * `getFileStem()`), which would drift over time.
 *
 * Errors are propagated, NOT swallowed — callers wrap in try/catch
 * to apply their own fault-tolerance policy (e.g. continue with the
 * next file in a batch, or surface to the user via toast).
 */
import { deleteFile, listDirectory, readFile, writeFile } from "@/commands/fs"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { removePageEmbedding } from "@/lib/embedding"
import {
  buildDeletedKeys,
  cleanIndexListing,
  extractFrontmatterTitle,
  normalizeWikiRefKey,
  stripDeletedWikilinks,
  type DeletedPageInfo,
} from "@/lib/wiki-cleanup"
import {
  parseFrontmatterArray,
  writeFrontmatterArray,
} from "@/lib/sources-merge"
import type { FileNode } from "@/types/wiki"

/**
 * Detect whether a wiki page lives under `wiki/sources/`. We treat
 * those as source-summary pages — each owns its source's extracted
 * images at `raw/assets/<slug>/`. Other wiki paths (concepts,
 * entities, queries, …) don't own image directories of their own,
 * so the media cascade is scoped to source pages only.
 *
 * Tolerates both `/` and `\` separators for Windows.
 */
function isSourcePage(pagePath: string): boolean {
  const normalized = normalizePath(pagePath)
  return normalized.includes("/wiki/sources/")
}

/**
 * Delete a wiki page from disk and drop its embedding chunks. If the
 * page is a source-summary (`wiki/sources/<slug>.md`), ALSO removes
 * the corresponding `raw/assets/<slug>/` directory containing the
 * source's extracted images. It also removes the legacy
 * `wiki/media/<slug>/` directory if present.
 *
 * `projectPath` is the project root (used to scope the embedding
 * cascade to the right LanceDB instance, and to locate owned image
 * directories).
 *
 * `pagePath` may be absolute or relative; only its basename is used
 * for the page-id lookup, so callers don't need to normalize before
 * calling. The disk delete uses the path verbatim — pass an
 * absolute path if your caller has one (most do).
 */
export async function cascadeDeleteWikiPage(
  projectPath: string,
  pagePath: string,
): Promise<void> {
  await deleteFile(pagePath)
  const slug = getFileStem(pagePath)
  if (slug.length > 0) {
    await removePageEmbedding(projectPath, slug)
  }

  // Asset cascade: source-summary deletion → drop the source's
  // image directories. Done AFTER the file delete (and after the
  // embedding cascade) so a failure in either of those — already
  // best-effort tolerated by callers — leaves us in a consistent
  // state. Failures here are logged + swallowed because the source
  // page is already gone; an orphaned asset directory is a leak,
  // not a correctness problem.
  //
  // Defensive on the slug: must be non-empty AND not start with `.`
  // — a path like `wiki/sources/.md` (pure extension, no name) or
  // `.git`-style hidden entries should NEVER produce an asset path
  // that resolves to a hidden directory under `raw/assets/` or the
  // legacy `wiki/media/`. The worst case (slug == ".") would target
  // the asset root.
  if (isSourcePage(pagePath) && slug.length > 0 && !slug.startsWith(".")) {
    const pp = normalizePath(projectPath)
    const assetDirs = [
      `${pp}/raw/assets/${slug}`,
      `${pp}/wiki/media/${slug}`,
    ]
    for (const assetDir of assetDirs) {
      try {
        // delete_file in fs.rs auto-detects directories and uses
        // remove_dir_all under the hood — see fs.rs L989. So a single
        // deleteFile call handles "may or may not be present" + "may
        // or may not be a directory" gracefully.
        await deleteFile(assetDir)
      } catch {
        // Most common cause: the directory never existed because no
        // images were extracted from this source. Not an error.
      }
    }
  }
}

function flattenMd(nodes: readonly FileNode[]): FileNode[] {
  const out: FileNode[] = []
  function walk(ns: readonly FileNode[]): void {
    for (const n of ns) {
      if (n.is_dir) {
        if (n.children) walk(n.children)
        continue
      }
      if (n.name.endsWith(".md")) out.push(n)
    }
  }
  walk(nodes)
  return out
}

export interface CascadeDeleteResult {
  /** Wiki-page paths that were actually removed from disk. */
  deletedPaths: string[]
  /** How many surviving wiki files we rewrote to drop stale refs. */
  rewrittenFiles: number
}

/**
 * Delete one or more wiki pages and clean up every reference to them
 * in the rest of the wiki: file delete, embedding drop, media-dir
 * cascade for source pages, plus
 *
 *   - `wiki/index.md` listing entries whose primary `[[target]]`
 *     points at a deleted page → entry line dropped
 *   - any other wiki .md body containing `[[deleted]]` /
 *     `[[deleted|alias]]` → wikilink replaced with plain text
 *     (alias preserved when present)
 *   - any wiki .md whose frontmatter `related:` array lists a
 *     deleted slug (or its title-form variant) → that entry
 *     filtered out, array rewritten
 *
 * Compared to the existing source-delete cascade in `sources-view`,
 * this also strips the `related:` frontmatter entries — that path
 * historically only touched body wikilinks + index.md and left
 * `related:` slugs pointing into the void. For a direct user-driven
 * "delete this entity" action we want zero leftover dangling refs.
 *
 * Order of operations:
 *   1. Read each target's content first to extract the title (need
 *      it for index-listing match) and snapshot the slug.
 *   2. Cascade-delete each target (file + embeddings + owned image dirs).
 *   3. Sweep all surviving wiki .md files and rewrite them.
 *
 * Best-effort on the sweep — a single un-readable file does not abort
 * the rest of the cleanup. Returns a summary so the caller can show
 * the user what happened.
 */
export async function cascadeDeleteWikiPagesWithRefs(
  projectPath: string,
  pagePaths: readonly string[],
): Promise<CascadeDeleteResult> {
  const pp = normalizePath(projectPath)
  const result: CascadeDeleteResult = {
    deletedPaths: [],
    rewrittenFiles: 0,
  }

  // 1. Read each target's title so the cleanup keyset includes both
  //    slug-form and title-form. Capture before delete.
  const infos: DeletedPageInfo[] = []
  for (const pagePath of pagePaths) {
    let title = ""
    try {
      const content = await readFile(pagePath)
      title = extractFrontmatterTitle(content)
    } catch {
      // file may have been deleted between selection + action; the
      // slug-form key alone will still work.
    }
    const slug = getFileStem(pagePath)
    if (slug.length > 0) infos.push({ slug, title })
  }

  // 2. Delete the target files themselves.
  for (const pagePath of pagePaths) {
    try {
      await cascadeDeleteWikiPage(pp, pagePath)
      result.deletedPaths.push(pagePath)
    } catch (err) {
      console.warn(`[wiki-delete] failed to delete ${pagePath}:`, err)
    }
  }

  if (infos.length === 0) return result

  // 3. Sweep surviving wiki/*.md.
  const deletedKeys = buildDeletedKeys(infos)
  const wikiTree = await listDirectory(`${pp}/wiki`)
  const allMd = flattenMd(wikiTree)
  const indexAbs = `${pp}/wiki/index.md`

  for (const file of allMd) {
    if (result.deletedPaths.includes(file.path)) continue // already gone
    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    let updated = content
    if (file.path === indexAbs || file.name === "index.md") {
      updated = cleanIndexListing(updated, deletedKeys)
    }
    updated = stripDeletedWikilinks(updated, deletedKeys)

    // `related:` frontmatter — drop entries that point at a deleted
    // page. parseFrontmatterArray returns the parsed string list;
    // writeFrontmatterArray rewrites only that field, preserving
    // every other line.
    const related = parseFrontmatterArray(updated, "related")
    if (related.length > 0) {
      const filtered = related.filter(
        (s) => !deletedKeys.has(normalizeWikiRefKey(s)),
      )
      if (filtered.length !== related.length) {
        updated = writeFrontmatterArray(updated, "related", filtered)
      }
    }

    if (updated !== content) {
      try {
        await writeFile(file.path, updated)
        result.rewrittenFiles++
      } catch (err) {
        console.warn(`[wiki-delete] failed to rewrite ${file.path}:`, err)
      }
    }
  }

  return result
}
