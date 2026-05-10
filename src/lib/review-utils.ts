/**
 * Shared helpers for reasoning about review items.
 * Kept dependency-free so both the Zustand store and sweep logic can import
 * it without creating cycles or pulling heavy LLM modules into the store.
 */

// Common prefixes LLM may prepend in English or Chinese review titles.
// Kept in one place so dedupe and sweep agree on what "the same concept" means.
const REVIEW_TITLE_PREFIX_RE =
  /^(missing\s+wiki\s+page[:：]\s*|missing[\s-]?page[:：]\s*|duplicate[\s-]?page[:：]\s*|possible[\s-]?duplicate[:：]\s*|缺失页面[:：]\s*|缺少页面[:：]\s*|重复页面[:：]\s*|疑似重复[:：]\s*)/i

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
