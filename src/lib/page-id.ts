/**
 * Page-id and dedup-key normalization — ADR 0003 Tier A.
 *
 * Two functions, two jobs. Keeping them separate is the point:
 *
 *   pageId(name)   — the canonical, human-readable page id used to
 *                    NAME files. Hyphenated, lower-cased, with a
 *                    heuristic camelCase split (`MapReduce` →
 *                    `map-reduce`). Idempotent.
 *
 *   dedupKey(id)   — the bucket key the Dedup pass uses to find
 *                    orthographic duplicates. ALL non-alphanumeric
 *                    characters stripped, lower-cased (`map-reduce`
 *                    and `mapreduce` → `mapreduce`). No heuristics.
 *
 * Why two: a pageId heuristic misfire only yields an ugly id
 * (`DynamoDB` → `dynamo-db` instead of `dynamodb`); a dedupKey
 * misfire builds a duplicate page. So pageId may guess, dedupKey
 * never does — and dedupKey catches whatever pageId got wrong,
 * because both `dynamo-db` and `dynamodb` collapse to `dynamodb`.
 *
 * Both keep letters & digits of every script (Latin, CJK, …) so
 * non-English manifest names don't collapse to empty ids.
 */

/** Longest a page id may be. Truncation happens on a hyphen
 *  boundary so it stays deterministic and idempotent — the
 *  inconsistent mid-word cuts of the old slug logic produced
 *  twin pages (WIKI-DUP-SLUG-TRUNCATION). */
const MAX_PAGE_ID_LENGTH = 80

/**
 * Canonical page id for an entity/concept display name.
 *
 * Idempotent: `pageId(pageId(x)) === pageId(x)` — an already-formed
 * id has no camelCase to split, no punctuation to fold, and is at
 * or below the length cap, so a second pass is a no-op.
 *
 * Returns "" when nothing usable remains; the write chokepoint is
 * responsible for rejecting an empty id rather than naming a file.
 */
export function pageId(name: string): string {
  const id = name
    .normalize("NFKC")
    // Heuristic word split: lowercase-or-digit followed by an
    // uppercase letter. `MapReduce` → `Map-Reduce`. Acronym runs
    // like `OLAP` have no such boundary and stay intact.
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1-$2")
    .toLowerCase()
    // Any run of non-(letter|digit) becomes a single hyphen.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

  if (id.length <= MAX_PAGE_ID_LENGTH) return id

  const cut = id.slice(0, MAX_PAGE_ID_LENGTH)
  const lastHyphen = cut.lastIndexOf("-")
  // Cut on a word boundary when there is one; otherwise the input
  // is a single oversized token and a hard cut is unavoidable.
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut
}

/**
 * Dedup bucket key — strips every non-alphanumeric character and
 * lower-cases. Trivially idempotent. Never used to name a file.
 *
 * Accepts a page id or a raw name; both collapse to the same key.
 */
export function dedupKey(idOrName: string): string {
  return idOrName
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase()
}
