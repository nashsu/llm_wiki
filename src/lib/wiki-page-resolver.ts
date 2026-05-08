import type { FileNode } from "@/types/wiki"

/**
 * Strip Obsidian-style `[[target]]` or `[[target|alias]]` wrapping
 * from a value, returning `{ slug, label }`. Frontmatter authors
 * (humans and the LLM) sometimes write related entries as
 * wikilinks instead of bare slugs; we want to display the alias
 * (or target) without the bracket noise and look up by target.
 *
 * Non-wikilink input is returned with `slug === label === input`.
 */
export function unwrapWikilink(s: string): { slug: string; label: string } {
  const m = s.match(/^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/)
  if (!m) return { slug: s, label: s }
  const target = m[1].trim()
  const alias = m[2]?.trim()
  return { slug: target, label: alias && alias.length > 0 ? alias : target }
}

/**
 * Walk a FileNode tree and return the absolute path of the first
 * file whose name matches `targetName`, restricted to subtrees that
 * sit underneath any directory whose absolute path contains
 * `pathContains`. Returns null when nothing matches.
 *
 * Used by the frontmatter panel to resolve `related: [slug]` to a
 * concrete `wiki/.../<slug>.md` path so a chip can navigate, and
 * `sources: [name.pdf]` to a `raw/sources/.../name.pdf` path so a
 * card can open the raw file. We intentionally take the first
 * match — duplicate basenames across subfolders are a wiki-author
 * collision the user sees in the file tree anyway, and resolving
 * arbitrarily is no worse than the prior text-only display.
 */
export function findInTreeByName(
  tree: FileNode[],
  targetName: string,
  pathContains: string,
): string | null {
  const targetNameKey = normalizeLookupPath(targetName)
  const pathContainsKey = normalizeLookupPath(pathContains)

  function walk(nodes: FileNode[]): string | null {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          const r = walk(node.children)
          if (r) return r
        }
        continue
      }
      if (
        normalizeLookupPath(node.name) === targetNameKey &&
        normalizeLookupPath(node.path).includes(pathContainsKey)
      ) {
        return node.path
      }
    }
    return null
  }
  return walk(tree)
}

/**
 * Resolve a `related:` reference to an absolute wiki page path.
 * Accepts three shapes the wiki has historically written:
 *   1. project-relative path:  `wiki/entities/dpao.md`
 *   2. bare filename with .md: `dpao.md`
 *   3. bare slug:              `dpao`
 * Returns the absolute path of an existing file, or null if none
 * matches. Always restricts the lookup to `wiki/` to avoid pulling
 * in a same-named file from `raw/sources/`.
 */
export function resolveRelatedSlug(
  tree: FileNode[],
  ref: string,
  wikiRoot: string,
): string | null {
  // Path-like → resolve relative to project root (one segment up
  // from wikiRoot).
  if (ref.includes("/")) {
    const projectRoot = wikiRoot.replace(/\/wiki$/, "")
    const target = `${projectRoot}/${ref}`
    const found = findInTreeByPath(tree, target)
    return found && found.includes(`${wikiRoot}/`) ? found : null
  }

  const filename = ref.endsWith(".md") ? ref : `${ref}.md`
  return findInTreeByName(tree, filename, `${wikiRoot}/`)
}

/**
 * Resolve a `sources:` reference. Accepts:
 *   1. project-relative path:  `wiki/sources/foo.md` or
 *                              `raw/sources/year-2025/q1.pdf`
 *   2. bare filename with ext: `q1.pdf`
 *   3. wiki source-summary:    `foo.md` (in wiki/sources/)
 * Tries wiki/sources/ first when the ref is a bare .md filename
 * (the ingest pipeline writes summary pages there), then falls
 * back to raw/sources/. Returns null if nothing matches.
 */
export function resolveSourceName(
  tree: FileNode[],
  ref: string,
  sourcesRoot: string,
): string | null {
  // sourcesRoot is `<project>/raw/sources` — derive project root
  // and wiki/ root from it.
  const projectRoot = sourcesRoot.replace(/\/raw\/sources$/, "")
  const wikiSources = `${projectRoot}/wiki/sources`

  if (ref.includes("/")) {
    const target = `${projectRoot}/${ref}`
    return findInTreeByPath(tree, target)
  }

  // Bare .md filename → look in wiki/sources/ first (ingest's
  // canonical home for source-summary pages).
  if (ref.endsWith(".md")) {
    const inWiki = findInTreeByName(tree, ref, `${wikiSources}/`)
    if (inWiki) return inWiki
  }

  // Otherwise, search raw/sources/.
  return findInTreeByName(tree, ref, `${sourcesRoot}/`)
}

function findInTreeByPath(tree: FileNode[], targetPath: string): string | null {
  const targetPathKey = normalizeLookupPath(targetPath)

  function walk(nodes: FileNode[]): string | null {
    for (const node of nodes) {
      if (normalizeLookupPath(node.path) === targetPathKey) return node.path
      if (node.is_dir && node.children) {
        const r = walk(node.children)
        if (r) return r
      }
    }
    return null
  }
  return walk(tree)
}

function normalizeLookupPath(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFC")
}
