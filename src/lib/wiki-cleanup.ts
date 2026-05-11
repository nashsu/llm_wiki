/**
 * Pure string-level helpers for cleaning up wiki files when a source
 * document (and its derived pages) gets deleted. Separated from the
 * React component so every edge case can be unit-tested.
 *
 * Fixes two classes of real bugs the previous inline logic had:
 *
 *   Bug A (silent false NEGATIVE — stale refs left behind):
 *     The index cleanup matched page slugs against `index.md` lines via
 *     `line.toLowerCase().includes(slug)`, so a wikilink written with
 *     the human title form — `[[KV Cache]]` — never matched the
 *     underlying file slug `kv-cache`. Every title-form index entry
 *     survived even when the page was deleted, and the next ingest
 *     believed those pages still existed.
 *
 *   Bug B (silent false POSITIVE — innocent siblings wiped):
 *     Substring `includes` matching meant a deleted slug that happened
 *     to appear as a fragment of any other wikilink took that wikilink
 *     down with it. Deleting `ai.md` would wipe `[[OpenAI]]`,
 *     `[[Constitutional AI]]`, `[[AI Safety]]` — catastrophic.
 *
 * The fix: structural wikilink parsing + normalized-string comparison,
 * with title AND slug collected for every deleted page.
 */

/** Info about a page that was actually deleted (not just source-pruned). */
export interface DeletedPageInfo {
  /** File-path slug, e.g. "kv-cache" from "wiki/concepts/kv-cache.md". */
  slug: string
  /** Frontmatter title, e.g. "KV Cache". Empty when unknown. */
  title: string
}

/**
 * Canonicalise a label so lookups are insensitive to the two axes LLMs
 * vary on: case, and the space/hyphen/underscore boundary between
 * "display title" and "file slug". E.g. all three of these collapse to
 * the same key:
 *   "KV Cache"   → "kvcache"
 *   "kv-cache"   → "kvcache"
 *   "kv_cache"   → "kvcache"
 *
 * It strips path prefixes and a trailing `.md` because wiki refs may
 * be written as bare slugs, filenames, or paths. It does NOT strip
 * other punctuation — `[[Hello, World]]` and `[[Hello World]]` stay
 * distinct on purpose.
 */
export function normalizeWikiRefKey(s: string): string {
  const normalized = s.trim().replace(/\\/g, "/")
  const leaf = normalized.split("/").pop() ?? normalized
  const withoutMd = leaf.toLowerCase().endsWith(".md") ? leaf.slice(0, -3) : leaf
  return withoutMd.toLowerCase().replace(/[\s\-_]+/g, "")
}

/**
 * Build the lookup set of normalized keys for a batch of deletions. The
 * set contains BOTH the slug-form and title-form of each page, so a
 * wikilink written either way will match.
 */
export function buildDeletedKeys(infos: DeletedPageInfo[]): Set<string> {
  const keys = new Set<string>()
  for (const info of infos) {
    if (info.slug) keys.add(normalizeWikiRefKey(info.slug))
    if (info.title) keys.add(normalizeWikiRefKey(info.title))
  }
  return keys
}

/**
 * Extract the `title:` value from YAML-ish markdown frontmatter.
 * Returns empty string when no title line is found.
 *
 * Tolerates:
 *   title: KV Cache
 *   title: "KV Cache"
 *   title: 'KV Cache'
 *   title:   KV Cache
 */
export function extractFrontmatterTitle(content: string): string {
  const m = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)
  return m ? m[1].trim() : ""
}

// Matches a markdown list item whose first wikilink is the logical
// "subject" of the line. `- [[Target]] description` / `* [[T|D]]`.
const INDEX_ENTRY_RE = /^\s*[-*]\s*\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/

/**
 * Drop list-item lines from an index-style file when their primary
 * wikilink targets a deleted page. Every other line (headers, prose,
 * frontmatter, blank lines, list items with non-deleted primaries) is
 * preserved verbatim.
 *
 * This is anchored to the wikilink structure, not fuzzy substring
 * matching, so `[[OpenAI]]` is untouched when "ai" is a deleted slug.
 */
export function cleanIndexListing(text: string, deletedKeys: Set<string>): string {
  if (deletedKeys.size === 0) return text
  return text
    .split("\n")
    .filter((line) => {
      const m = line.match(INDEX_ENTRY_RE)
      if (!m) return true
      return !deletedKeys.has(normalizeWikiRefKey(m[1].trim()))
    })
    .join("\n")
}

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g

/**
 * Replace wikilinks pointing to deleted pages with plain text, leaving
 * wikilinks to surviving pages alone.
 *
 *   [[deleted]]         → deleted
 *   [[deleted|display]] → display
 *   [[kept]]            → [[kept]]   (unchanged)
 *
 * Designed for overview.md and any other prose page that might
 * cross-reference the deleted pages.
 */
export function stripDeletedWikilinks(text: string, deletedKeys: Set<string>): string {
  if (deletedKeys.size === 0) return text
  return text.replace(WIKILINK_RE, (match, target: string, display: string | undefined) => {
    const key = normalizeWikiRefKey(target.trim())
    if (!deletedKeys.has(key)) return match
    return display ?? target
  })
}
