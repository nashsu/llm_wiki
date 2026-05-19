import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
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
  function walk(nodes: FileNode[]): string | null {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          const r = walk(node.children)
          if (r) return r
        }
        continue
      }
      if (node.name === targetName && node.path.includes(pathContains)) {
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
/**
 * Match a wikilink / related slug against known page ids (filename
 * without `.md`). Handles case, spaces-vs-hyphens, and a single
 * unambiguous suffix match (`spark` → `apache-spark`).
 */
export function resolveWikiSlugId(
  raw: string,
  knownIds: Iterable<string>,
): string | null {
  const ref = raw.trim().replace(/\.md$/i, "")
  if (!ref) return null

  const ids = [...knownIds]
  if (ids.includes(ref)) return ref

  const normalized = ref.toLowerCase().replace(/\s+/g, "-")
  const exactCi = ids.filter((id) => id.toLowerCase() === normalized)
  if (exactCi.length === 1) return exactCi[0]

  const hyphenNorm = ids.filter(
    (id) => id.toLowerCase().replace(/\s+/g, "-") === normalized,
  )
  if (hyphenNorm.length === 1) return hyphenNorm[0]

  const suffixMatches = ids.filter((id) => {
    const lower = id.toLowerCase()
    return lower === normalized || lower.endsWith(`-${normalized}`)
  })
  if (suffixMatches.length === 1) return suffixMatches[0]

  return null
}

/** Case-insensitive dedupe; first-seen casing wins. */
export function dedupePageIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

/** Resolve shorthand refs to canonical page ids and dedupe (for `related:` writes). */
export function canonicalizePageIds(
  rawRefs: readonly string[],
  knownIds: Iterable<string>,
): string[] {
  const resolved = rawRefs.map((raw) => {
    const { slug } = unwrapWikilink(raw)
    return resolveWikiSlugId(slug, knownIds) ?? slug
  })
  return dedupePageIds(resolved)
}

/** All wiki page ids (filename without `.md`) under `wiki/`. */
export function listWikiPageIdsFromTree(tree: FileNode[], wikiRoot: string): string[] {
  const ids: string[] = []
  const walk = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.is_dir && node.children) {
        walk(node.children)
        continue
      }
      if (node.is_dir || !node.name.endsWith(".md")) continue
      if (!node.path.includes(`${wikiRoot}/`)) continue
      ids.push(node.name.replace(/\.md$/i, ""))
    }
  }
  walk(tree)
  return ids
}

export async function listWikiPageIds(projectPath: string): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`
  try {
    const tree = await listDirectory(wikiRoot)
    return listWikiPageIdsFromTree(tree, wikiRoot)
  } catch {
    return []
  }
}

export function resolveRelatedSlug(
  tree: FileNode[],
  ref: string,
  wikiRoot: string,
): string | null {
  const { slug } = unwrapWikilink(ref)

  // Path-like → resolve relative to project root (one segment up
  // from wikiRoot).
  if (slug.includes("/")) {
    const projectRoot = wikiRoot.replace(/\/wiki$/, "")
    const target = `${projectRoot}/${slug}`
    const found = findInTreeByPath(tree, target)
    return found && found.includes(`${wikiRoot}/`) ? found : null
  }

  const filename = slug.endsWith(".md") ? slug : `${slug}.md`
  const exact = findInTreeByName(tree, filename, `${wikiRoot}/`)
  if (exact) return exact

  const resolved = resolveWikiSlugId(slug, listWikiPageIdsFromTree(tree, wikiRoot))
  if (!resolved) return null
  return findInTreeByName(tree, `${resolved}.md`, `${wikiRoot}/`)
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
  function walk(nodes: FileNode[]): string | null {
    for (const node of nodes) {
      if (node.path === targetPath) return node.path
      if (node.is_dir && node.children) {
        const r = walk(node.children)
        if (r) return r
      }
    }
    return null
  }
  return walk(tree)
}
