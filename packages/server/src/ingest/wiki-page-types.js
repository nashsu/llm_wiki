// Wiki page type constants + helpers, ported verbatim from
// src/lib/wiki-page-types.ts for the server-driven ingest cutover (issue #14).
// Types are expressed as JSDoc comments; runtime values are byte-identical.

export const GENERATION_WIKI_TYPES = [
  "source",
  "entity",
  "concept",
  "comparison",
  "query",
  "synthesis",
  "thesis",
  "methodology",
  "finding",
]

const WIKI_TYPE_DIRS = [
  { dir: "entities", type: "entity" },
  { dir: "concepts", type: "concept" },
  { dir: "sources", type: "source" },
  { dir: "queries", type: "query" },
  { dir: "comparisons", type: "comparison" },
  { dir: "synthesis", type: "synthesis" },
  { dir: "findings", type: "finding" },
  { dir: "thesis", type: "thesis" },
  { dir: "methodology", type: "methodology" },
]

/**
 * @param {string} path
 * @param {string} [fileName]
 * @returns {string | null}
 */
export function inferWikiTypeFromPath(path, fileName) {
  const normalized = path.replace(/\\/g, "/").toLowerCase()
  for (const { dir, type } of WIKI_TYPE_DIRS) {
    if (normalized.includes(`/wiki/${dir}/`) || normalized.includes(`/${dir}/`) || normalized.startsWith(`wiki/${dir}/`)) {
      return type
    }
  }
  const name = (fileName ?? normalized.split("/").pop() ?? "").toLowerCase()
  if (name === "overview.md" || normalized.includes("/overview.md")) return "overview"
  const customDir = normalized.match(/(?:^|\/)wiki\/([^/.][^/]*)\/[^/]+\.md$/)?.[1]
  if (customDir) return customDir
  return null
}

/**
 * @param {string} type
 * @returns {string}
 */
export function wikiTypeLabel(type) {
  if (type === "thesis") return "Thesis"
  if (type === "methodology") return "Methodology"
  if (type === "finding") return "Finding"
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
