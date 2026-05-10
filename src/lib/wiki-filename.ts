/**
 * Filename generation for user-initiated wiki writes ("Save to Wiki").
 *
 * Why this exists as its own module:
 *   The previous inline logic stripped all non-ASCII chars from the
 *   file stem — which made every CJK-titled conversation collapse to
 *   an empty stem and collide into a single file for the day. This
 *   pure module makes the filename policy trivially testable.
 *
 * Filename shape:
 *   {readable title} ({YYYYMMDD} {HHMMSS}).md
 *
 * File stem rules:
 *   - Unicode-aware: keeps letters & digits across all scripts
 *     (Latin, CJK, Cyrillic, Arabic …).
 *   - NFKC-normalized so full-width characters don't drift from
 *     half-width equivalents.
 *   - Keeps readable spaces for Obsidian sidebars and graph labels.
 *   - Hyphens are not inserted as separators. Existing hyphens are
 *     treated as spacing unless the caller deliberately keeps an
 *     official name in the title before calling this helper.
 *   - Truncated to 80 characters.
 *   - Falls back to `"저장된 질의"` when nothing usable remains.
 *
 * The trailing timestamp guarantees same-day saves stay distinct
 * even when the title yields an identical slug (e.g. several Chinese
 * conversations with the same topic, or repeated "Untitled" saves).
 */

/** Produce the readable file stem. The historical name is kept because
 *  several callers still use `slug` as their variable name. */
export function makeQuerySlug(title: string): string {
  const stem = title
    .normalize("NFKC")
    .trim()
    .replace(/[‐‑‒–—―_-]+/gu, " ")
    .replace(/[\\/:*?"<>|#[\]`]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s().,&+]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 80)
    .trim()
  return stem.length > 0 ? stem : "저장된 질의"
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
  const compactDate = date.replace(/-/g, "")
  const time = iso.slice(11, 19).replace(/:/g, "") // 143052
  return {
    slug,
    date,
    time,
    fileName: `${slug} (${compactDate} ${time}).md`,
  }
}
