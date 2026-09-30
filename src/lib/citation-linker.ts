/**
 * Linkify source-path mentions the model writes as plain text (e.g.
 * "来源：entities/usb") so they become clickable wiki links even when the
 * model did not wrap them in [[wikilinks]]. Only tokens that exactly match a
 * known cited page path are linked, which keeps the transform safe: a bare
 * slug, an unrelated path, or an already-linked [display](...) is left
 * untouched.
 */
export function linkifyCitedPaths(text: string, citedPaths: readonly string[]): string {
  if (citedPaths.length === 0) return text
  const known = new Set(citedPaths.map(normalizeRefPath))
  return text.replace(
    // Path-like token: at least two slash-separated segments (so a bare slug
    // like `usb` is never linked). Lookbehind/ahead require it not to be
    // adjacent to bracket/link syntax, so an existing [x](...) or [[x]] is
    // not re-wrapped.
    /(?<!\[)(?<![A-Za-z0-9_/.\-:])[A-Za-z0-9_一-鿿.\-]+(?:\/[A-Za-z0-9_一-鿿.\-]+)+(?!\])(?![A-Za-z0-9_/.\-:])/g,
    (match) => {
      const norm = normalizeRefPath(match)
      return known.has(norm) ? `[${norm}](wikilink:${norm})` : match
    },
  )
}

function normalizeRefPath(path: string): string {
  return path.replace(/\.md$/i, "").replace(/^wiki\//, "")
}
