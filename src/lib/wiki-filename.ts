/**
 * Filename generation for user-initiated wiki writes ("Save to Wiki").
 *
 * Why this exists as its own module:
 *   The previous inline logic stripped all non-ASCII chars from the
 *   slug — which made every CJK-titled conversation collapse to an
 *   empty slug and collide into `-YYYY-MM-DD.md` for the day, so the
 *   user could only keep ONE save per day. This pure module makes
 *   the filename policy trivially testable.
 *
 * Filename shape:
 *   {slug}-{YYYY-MM-DD}-{HHMMSS}.md
 *
 * Slug rules:
 *   - Unicode-aware: keeps letters & digits across all scripts
 *     (Latin, CJK, Cyrillic, Arabic …) plus ASCII hyphens.
 *   - NFKC-normalized so full-width characters don't drift from
 *     half-width equivalents.
 *   - Lowercased (no-op for scripts without case).
 *   - Whitespace → hyphen.
 *   - Collapses runs of hyphens, trims leading/trailing hyphens.
 *   - Truncated to 50 characters.
 *   - Falls back to `"query"` when nothing usable remains.
 *
 * The trailing timestamp guarantees same-day saves stay distinct
 * even when the title yields an identical slug (e.g. several Chinese
 * conversations with the same topic, or repeated "Untitled" saves).
 */

/** Produce just the slug — exported for tests / callers that want
 *  to reuse it in places like the index.md wikilink target. */
export function makeQuerySlug(title: string): string {
  const slug = title
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "-")
    // Keep Unicode letters, Unicode digits, and the ASCII hyphen.
    // Stripping emoji / punctuation keeps the filename
    // filesystem-safe across Windows / macOS / Linux.
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  const truncated = Array.from(slug).slice(0, 50).join("")
  return truncated.length > 0 ? truncated : "query"
}

/** Produce the full wiki filename. Accepts an injected `now` for
 *  deterministic tests — production callers should omit it. */
export function makeQueryFileName(
  title: string,
  now: Date = new Date(),
): { slug: string; fileName: string; date: string; time: string } {
  const slug = makeQuerySlug(title)
  // UTC timestamp — avoids DST / timezone-flipping surprises when
  // the same save produces different filenames on different machines.
  const iso = now.toISOString() // e.g. 2026-04-23T14:30:52.123Z
  const date = iso.slice(0, 10) // 2026-04-23
  const time = iso.slice(11, 19).replace(/:/g, "") // 143052
  return {
    slug,
    date,
    time,
    fileName: `${slug}-${date}-${time}.md`,
  }
}
