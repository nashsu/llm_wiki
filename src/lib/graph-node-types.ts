export const DEFAULT_HIDDEN_GRAPH_NODE_TYPES = new Set(["query"])

const GRAPH_NODE_TYPE_FOLDERS: Record<string, string> = {
  entities: "entity",
  concepts: "concept",
  sources: "source",
  queries: "query",
  comparisons: "comparison",
  synthesis: "synthesis",
}

const GRAPH_NODE_TYPE_COLORS: Record<string, string> = {
  entity: "#60a5fa",
  concept: "#c084fc",
  source: "#fb923c",
  query: "#4ade80",
  comparison: "#2dd4bf",
  synthesis: "#f87171",
  overview: "#facc15",
  index: "#94a3b8",
  log: "#94a3b8",
  other: "#94a3b8",
}

const GRAPH_NODE_TYPE_LABELS: Record<string, string> = {
  entity: "Entity",
  concept: "Concept",
  source: "Source",
  query: "Query",
  comparison: "Comparison",
  synthesis: "Synthesis",
  overview: "Overview",
  index: "Index",
  log: "Log",
  other: "Other",
}

const GRAPH_NODE_TYPE_ORDER = [
  "entity",
  "concept",
  "source",
  "query",
  "comparison",
  "synthesis",
  "overview",
  "index",
  "log",
  "other",
]

const GRAPH_NODE_TYPE_RANK = new Map(
  GRAPH_NODE_TYPE_ORDER.map((type, index) => [type, index]),
)

function titleCaseType(type: string): string {
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function isDefaultHiddenGraphNodeType(type: string): boolean {
  return DEFAULT_HIDDEN_GRAPH_NODE_TYPES.has(type.trim().toLowerCase())
}

export function getGraphNodeTypeFromPath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean)
  const wikiIndex = parts.lastIndexOf("wiki")
  const folder = wikiIndex >= 0 ? parts[wikiIndex + 1] : parts[parts.length - 2]
  if (!folder) return null
  return GRAPH_NODE_TYPE_FOLDERS[folder.toLowerCase()] ?? null
}

export function getGraphNodeTypeColor(type: string): string {
  return GRAPH_NODE_TYPE_COLORS[type] ?? GRAPH_NODE_TYPE_COLORS.other
}

export function getGraphNodeTypeLabel(type: string): string {
  return GRAPH_NODE_TYPE_LABELS[type] ?? titleCaseType(type)
}

export function getGraphNodeTypeEntries(
  counts: Record<string, number>,
): Array<[string, string, number]> {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => {
      const rankA = GRAPH_NODE_TYPE_RANK.get(a) ?? Number.MAX_SAFE_INTEGER
      const rankB = GRAPH_NODE_TYPE_RANK.get(b) ?? Number.MAX_SAFE_INTEGER
      if (rankA !== rankB) return rankA - rankB
      return a.localeCompare(b)
    })
    .map(([type, count]) => [type, getGraphNodeTypeLabel(type), count])
}
