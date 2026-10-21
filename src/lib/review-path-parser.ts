/**
 * Extract a clickable project-relative file path from a review item's
 * resolvedAction string.
 *
 * Handles the shapes produced by the review resolve flows:
 *   - "Created: wiki/queries/some-topic.md"
 *   - "Created: wiki/research/some-topic.md" (via createReviewPageDrafts)
 *   - "Created: raw/sources/...", "Saved to Wiki", "Deleted", "auto-resolved"…
 *
 * Returns null when the action carries no file reference worth linking.
 */
export function extractFilePathFromResolvedAction(action: string): string | null {
  if (!action) return null

  // Match a project-relative path under wiki/ or raw/. Prefer "wiki/" but
  // accept "raw/" for source files. Also tolerate a leading "./" and trailing
  // punctuation (commas, periods, closing parens).
  const match = action.match(/(?:wiki|raw)\/[^\s,)]+\.md/i)
  if (!match) return null
  return match[0]
}
