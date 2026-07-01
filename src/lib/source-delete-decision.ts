/**
 * Decide what to do with a wiki page when the user deletes a source
 * document. This is a pure function so the branching is unit-testable
 * in isolation — the previous inline version in sources-view.tsx was
 * entangled with React and silently harboured a data-loss bug (pages
 * whose sole source was NOT the one being deleted got wiped anyway,
 * because findRelatedWikiPages had returned them via a loose
 * substring match).
 */

export type DeleteDecision =
  /** Keep the page on disk; rewrite its sources to the returned list. */
  | { action: "keep"; updatedSources: string[] }
  /** Delete the page — the deleting source was its sole contributor. */
  | { action: "delete" }
  /** Leave the page alone entirely — it ended up in findRelatedWikiPages'
   *  results by accident (loose frontmatter substring match) but its
   *  sources list doesn't actually include the deleting source. */
  | { action: "skip"; reason: string }

/**
 * Decide whether a page should be kept, deleted, or skipped in response
 * to the user removing `deletingSource`. Case-insensitive throughout so
 * "Test.md" and "test.md" are treated as the same source.
 *
 *   - If `deletingSource` is NOT in `frontmatterSources` → skip.
 *     Guards against findRelatedWikiPages' loose match taking out
 *     innocent pages.
 *   - If it IS and there are OTHER sources too → keep, return the
 *     filtered list so caller can rewrite the frontmatter.
 *   - If it IS and it's the ONLY source → delete.
 */
export function decidePageFate(
  frontmatterSources: readonly string[],
  deletingSource: string,
): DeleteDecision {
  const targetLower = deletingSource.toLowerCase()

  const inList = frontmatterSources.some(
    (s) => s.toLowerCase() === targetLower,
  )
  if (!inList) {
    return {
      action: "skip",
      reason: `page sources do not include "${deletingSource}"`,
    }
  }

  const survivors = frontmatterSources.filter(
    (s) => s.toLowerCase() !== targetLower,
  )

  if (survivors.length > 0) {
    return { action: "keep", updatedSources: survivors }
  }

  return { action: "delete" }
}
