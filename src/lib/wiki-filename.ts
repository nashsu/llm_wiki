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

/**
 * Maximum display length for a saved-query title (the human-readable
 * `title:` frontmatter / index label — distinct from the 50-char slug).
 */
const TITLE_MAX_LEN = 60

/**
 * Derive a clean, human-readable title from a user's question.
 *
 * The question is the best title source (the answer's first line is often
 * boilerplate or — with reasoning models — polluted by <think> output). But
 * raw question text needs cleaning:
 *   - strip leading markdown heading markers
 *   - drop image markdown (`![alt](data:image/png;base64,…)` and bare
 *     `data:` URIs) so an image-only or image-heavy question doesn't leak a
 *     giant base64 blob into the title
 *   - collapse whitespace/newlines
 *
 * When the cleaned text is longer than `TITLE_MAX_LEN`, we *summarize* by
 * cutting at the nearest sentence/clause boundary before the limit (falling
 * back to a word boundary) and appending an ellipsis — rather than a hard
 * mid-word slice, which reads as garbled.
 *
 * Returns "" when nothing usable remains (e.g. an image-only question), so
 * callers can fall back to the answer content.
 */
export function deriveTitleFromQuestion(question: string | null | undefined): string {
  if (!question) return ""

  const cleaned = question
    .replace(/^#+\s*/, "")
    // Image markdown: ![alt](url) — including long base64 data URIs.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // Bare data: URIs that slipped in without markdown wrapping.
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!cleaned) return ""
  if (Array.from(cleaned).length <= TITLE_MAX_LEN) return cleaned

  // Too long — summarize at a natural boundary within the limit.
  const head = Array.from(cleaned).slice(0, TITLE_MAX_LEN).join("")
  // Prefer the last sentence/clause terminator, then the last space.
  const boundary = Math.max(
    head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"),
    head.lastIndexOf("，"), head.lastIndexOf("、"), head.lastIndexOf("；"),
    head.lastIndexOf("."), head.lastIndexOf("!"), head.lastIndexOf("?"),
    head.lastIndexOf(","), head.lastIndexOf(";"), head.lastIndexOf(" "),
  )
  // Only honor a boundary that isn't uselessly early (keep ≥ half the budget).
  const cut = boundary >= TITLE_MAX_LEN / 2 ? head.slice(0, boundary) : head
  return cut.replace(/[\s、，；,;.。!！?？]+$/, "").trim() + "…"
}

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
