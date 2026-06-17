/**
 * Shared helpers for reasoning about review items.
 * Kept dependency-free so both the Zustand store and sweep logic can import
 * it without creating cycles or pulling heavy LLM modules into the store.
 */

// Common prefixes LLM may prepend in English or Chinese review titles.
// Kept in one place so dedupe and sweep agree on what "the same concept" means.
const REVIEW_TITLE_PREFIX_RE =
  /^(missing[\s-]?page[:：]\s*|duplicate[\s-]?page[:：]\s*|possible[\s-]?duplicate[:：]\s*|缺失页面[:：]\s*|缺少页面[:：]\s*|重复页面[:：]\s*|疑似重复[:：]\s*)/i

/**
 * Normalize a review title for equality comparison:
 *   - strip leading "Missing page:" / "缺失页面:" / etc.
 *   - collapse whitespace
 *   - lowercase
 *
 * Two review items with the same (type, normalized title) are considered
 * the same concept and should be merged rather than duplicated.
 */
export function normalizeReviewTitle(title: string): string {
  return title
    .replace(REVIEW_TITLE_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

// Separators a model may use to list several missing entities in one title,
// e.g. "缺失页面: CallMethod、StartFunc、Print" or "A, B / C | D".
// ASCII hyphen is handled separately below because it also appears *inside*
// kebab-case identifiers we must NOT split.
const ENTITY_LIST_SEPARATOR_RE = /[、，,;；/|]+/

// A run of CJK followed by "实体页缺失" / "页面缺失" / "缺失" that some models
// emit as a descriptive prefix before hyphen-joined entity names, e.g.
// "核心测试项实体页缺失-CallMethod-StartFunc-Print".
const CJK_MISSING_PREFIX_RE = /^[\p{Script=Han}]+(?:实体页|页面)?缺失[-:：]?\s*/u

/**
 * Extract the concrete entity/concept names a `missing-page` review is asking
 * to create. The name(s) live in the review TITLE — `affectedPages` lists the
 * EXISTING pages that reference the gap, not the pages to create.
 *
 * Handles the common shapes models produce:
 *   - "Missing page: attention"                  → ["attention"]
 *   - "缺失页面: CallMethod、StartFunc、Print"      → ["CallMethod","StartFunc","Print"]
 *   - "核心测试项实体页缺失-CallMethod-StartFunc-Print"
 *                                                → ["CallMethod","StartFunc","Print"]
 *
 * Casing is preserved (entity identifiers are case-sensitive). Returns [] when
 * nothing usable can be parsed.
 */
export function extractMissingEntityNames(title: string): string[] {
  let base = title
    .replace(REVIEW_TITLE_PREFIX_RE, "")
    .replace(CJK_MISSING_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!base) return []

  // First split on explicit list separators.
  let parts = base.split(ENTITY_LIST_SEPARATOR_RE)

  // If that produced a single chunk that is itself a hyphen-joined run of
  // identifier-like tokens (CamelCase / ALLCAPS / leading-capital words),
  // treat the hyphens as separators too. This recovers the
  // "Foo-Bar-Baz" listing shape without shredding genuine kebab-case names
  // like "self-attention" (whose segments are lowercase).
  if (parts.length === 1 && /-/.test(base)) {
    const tokens = base.split("-")
    const looksLikeIdentifierList = tokens.length > 1 && tokens.every((t) => /^[A-Z][A-Za-z0-9]*$/.test(t.trim()))
    if (looksLikeIdentifierList) parts = tokens
  }

  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}
