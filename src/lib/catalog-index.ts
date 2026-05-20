/**
 * Single seam for mutating `wiki/index.md` (the catalog index).
 *
 * Invariants:
 * - reconcile: add missing lines only (never remove or reorder)
 * - remove: drop list lines whose primary wikilink targets deleted pages
 * - replace: wholesale content (LLM Global generation / Manual save); callers
 *   should run reconcile afterward to backfill any missing catalog lines
 * - append: insert one line under a section (UI saves, deterministic writers)
 */

import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { reconcileWikiIndexContent } from "@/lib/index-reconcile"
import {
  indexSectionForWikiRel,
  listWikiCatalogPages,
  type WikiCatalogPage,
} from "@/lib/wiki-catalog"
import { cleanIndexListing } from "@/lib/wiki-cleanup"
import {
  WIKI_INDEX_PATH,
  appendIndexEntry,
  formatIndexEntry,
  indexSectionForPageType,
  type IndexSection,
} from "@/lib/wiki-structural"

export type { WikiCatalogPage }

export type CatalogIndexOp =
  | {
      kind: "append"
      section: IndexSection | string
      linkTarget: string
      description: string
      displayTitle?: string
    }
  | { kind: "reconcile" }
  | { kind: "remove"; deletedKeys: Set<string> }
  | { kind: "replace"; content: string }

export type CatalogIndexResult =
  | { kind: "append" }
  | { kind: "reconcile"; added: number; paths: string[] }
  | { kind: "remove"; changed: boolean }
  | { kind: "replace" }

/** Unified section mapping for catalog lines (frontmatter type or folder). */
export function sectionForCatalogPage(
  relPath: string,
  pageType?: string,
): IndexSection | string {
  if (pageType) return indexSectionForPageType(pageType)
  return indexSectionForWikiRel(relPath, pageType)
}

/** Pure: append one catalog line without I/O. */
export function appendCatalogEntryContent(
  indexContent: string,
  section: IndexSection | string,
  linkTarget: string,
  description: string,
  options: { displayTitle?: string } = {},
): string {
  const line = formatIndexEntry(linkTarget, description, options)
  return appendIndexEntry(indexContent, section, line)
}

/** Pure: remove lines for deleted pages without I/O. */
export function removeCatalogEntriesContent(
  indexContent: string,
  deletedKeys: Set<string>,
): string {
  return cleanIndexListing(indexContent, deletedKeys)
}

async function readCatalogIndex(projectPath: string): Promise<string> {
  const indexPath = `${normalizePath(projectPath)}/${WIKI_INDEX_PATH}`
  try {
    return await readFile(indexPath)
  } catch {
    return "# Wiki Index\n"
  }
}

async function writeCatalogIndex(projectPath: string, content: string): Promise<void> {
  const indexPath = `${normalizePath(projectPath)}/${WIKI_INDEX_PATH}`
  await writeFile(indexPath, content)
}

/**
 * Project-level catalog index mutation. Prefer this over ad-hoc read/append/write.
 */
export async function updateCatalogIndex(
  projectPath: string,
  op: CatalogIndexOp,
): Promise<CatalogIndexResult> {
  const pp = normalizePath(projectPath)

  switch (op.kind) {
    case "append": {
      const existing = await readCatalogIndex(pp)
      const content = appendCatalogEntryContent(
        existing,
        op.section,
        op.linkTarget,
        op.description,
        { displayTitle: op.displayTitle },
      )
      await writeCatalogIndex(pp, content)
      return { kind: "append" }
    }
    case "replace": {
      await writeCatalogIndex(pp, op.content)
      return { kind: "replace" }
    }
    case "remove": {
      const existing = await readCatalogIndex(pp)
      const content = removeCatalogEntriesContent(existing, op.deletedKeys)
      const changed = content !== existing
      if (changed) await writeCatalogIndex(pp, content)
      return { kind: "remove", changed }
    }
    case "reconcile":
      return reconcileCatalogIndexProject(pp)
  }
}

/**
 * Scan wiki pages and add any missing catalog lines. Idempotent.
 */
export async function reconcileCatalogIndexProject(
  projectPath: string,
): Promise<{ kind: "reconcile"; added: number; paths: string[] }> {
  const pp = normalizePath(projectPath)
  const indexContent = await readCatalogIndex(pp)
  const catalog = await listWikiCatalogPages(pp)
  const { content, added, changed } = reconcileWikiIndexContent(indexContent, catalog)

  if (!changed) {
    return { kind: "reconcile", added: 0, paths: [] }
  }

  await writeCatalogIndex(pp, content)
  const paths = added.map((p) => p.linkTarget)
  console.log(
    `[catalog-index] Added ${added.length} missing index entr${added.length === 1 ? "y" : "ies"}:`,
    paths.join(", "),
  )
  return { kind: "reconcile", added: added.length, paths }
}

/** @deprecated Use `reconcileCatalogIndexProject` — kept for existing import sites. */
export async function reconcileWikiIndexProject(
  projectPath: string,
): Promise<{ added: number; paths: string[] }> {
  const result = await reconcileCatalogIndexProject(projectPath)
  return { added: result.added, paths: result.paths }
}
