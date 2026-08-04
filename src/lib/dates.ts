// Shared wiki date helpers.
//
// Extracted from the deleted browser ingest pipeline (src/lib/ingest.ts,
// issue #14 P0 stage 9) — deep-research and any future consumer still need
// the wiki's local-time YYYY-MM-DD stamp.

/** Local-timezone YYYY-MM-DD (the wiki's date format, e.g. frontmatter `created`). */
export function currentWikiDate(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
