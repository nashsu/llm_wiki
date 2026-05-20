/**
 * Deterministic repair for `wiki/index.md`: ensure every catalog page
 * under `wiki/` appears in the index (Karpathy catalog contract).
 */

import { normalizeWikiRefKey } from "@/lib/wiki-cleanup"
import {
  indexSectionForWikiRel,
  listWikiCatalogPages,
  type WikiCatalogPage,
} from "@/lib/wiki-catalog"
import { appendIndexEntry, formatIndexEntry } from "@/lib/wiki-structural"

export type { WikiCatalogPage }
export { indexSectionForWikiRel, listWikiCatalogPages }

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g

export interface IndexReconcileResult {
  content: string
  added: WikiCatalogPage[]
  /** True when `content` differs from the input index. */
  changed: boolean
}

/** Normalized keys of every wikilink target listed in the index. */
export function extractIndexLinkKeys(indexContent: string): Set<string> {
  const keys = new Set<string>()
  for (const match of indexContent.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim()
    if (!target) continue
    keys.add(normalizeWikiRefKey(target))
  }
  return keys
}

function pageKeysForIndex(relPath: string): string[] {
  const keys = [normalizeWikiRefKey(relPath)]
  const base = relPath.split("/").pop()
  if (base) keys.push(normalizeWikiRefKey(base))
  return keys
}

export function indexListsPage(indexKeys: Set<string>, relPath: string): boolean {
  return pageKeysForIndex(relPath).some((k) => indexKeys.has(k))
}

/**
 * Pure reconcile: add missing catalog lines; never remove or reorder
 * existing index content.
 */
export function reconcileWikiIndexContent(
  indexContent: string,
  pages: WikiCatalogPage[],
): IndexReconcileResult {
  const indexKeys = extractIndexLinkKeys(indexContent)
  const added: WikiCatalogPage[] = []
  let content = indexContent

  const sorted = [...pages].sort((a, b) => a.linkTarget.localeCompare(b.linkTarget))

  for (const page of sorted) {
    if (indexListsPage(indexKeys, page.linkTarget)) continue
    const line = formatIndexEntry(page.linkTarget, page.title, {
      displayTitle: page.title,
    })
    content = appendIndexEntry(content, page.section, line)
    for (const k of pageKeysForIndex(page.linkTarget)) {
      indexKeys.add(k)
    }
    added.push(page)
  }

  return {
    content,
    added,
    changed: added.length > 0,
  }
}

/** @deprecated Import from `@/lib/catalog-index` — kept for older import paths. */
export async function reconcileWikiIndexProject(
  projectPath: string,
): Promise<{ added: number; paths: string[] }> {
  const { reconcileWikiIndexProject: reconcile } = await import("@/lib/catalog-index")
  return reconcile(projectPath)
}
