import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { shouldHideNodeType } from "@/lib/graph-visibility"
import { DEFAULT_HIDDEN_GRAPH_NODE_TYPES } from "@/lib/graph-node-types"
import { isGraphExcludedNode } from "@/lib/graph-exclusions"

export type GraphMode = "knowledge" | "evidence" | "maintenance"

export interface GraphModeOption {
  id: GraphMode
  label: string
}

export interface GraphFilterState {
  mode: GraphMode
  hiddenTypes: ReadonlySet<string>
  hiddenNodeIds: ReadonlySet<string>
  hideStructural: boolean
  hideIsolated: boolean
  maxLinks?: number
}

export interface FilteredGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  hiddenNodeIds: Set<string>
}

export const GRAPH_MODE_OPTIONS: GraphModeOption[] = [
  { id: "knowledge", label: "Knowledge" },
  { id: "evidence", label: "Evidence" },
  { id: "maintenance", label: "Maintenance" },
]

export function getDefaultHiddenTypesForMode(mode: GraphMode): ReadonlySet<string> {
  if (mode === "evidence") return DEFAULT_HIDDEN_GRAPH_NODE_TYPES
  if (mode === "maintenance") return DEFAULT_HIDDEN_GRAPH_NODE_TYPES
  return new Set([...DEFAULT_HIDDEN_GRAPH_NODE_TYPES, "source"])
}

export function createGraphFiltersForMode(mode: GraphMode): GraphFilterState {
  return {
    mode,
    hiddenTypes: new Set(getDefaultHiddenTypesForMode(mode)),
    hiddenNodeIds: new Set(),
    hideStructural: true,
    hideIsolated: false,
    maxLinks: undefined,
  }
}

export const DEFAULT_GRAPH_FILTERS: GraphFilterState = {
  mode: "knowledge",
  hiddenTypes: new Set(getDefaultHiddenTypesForMode("knowledge")),
  hiddenNodeIds: new Set(),
  hideStructural: true,
  hideIsolated: false,
  maxLinks: undefined,
}

export function isStructuralGraphNode(node: Pick<GraphNode, "id" | "path" | "type">): boolean {
  return isGraphExcludedNode(node)
}

export function applyGraphFilters(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  filters: GraphFilterState,
): FilteredGraph {
  const hiddenNodeIds = new Set<string>()

  for (const node of nodes) {
    if (filters.hiddenNodeIds.has(node.id)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (shouldHideNodeType(node.type, filters.hiddenTypes)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.hideStructural && isStructuralGraphNode(node)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.hideIsolated && node.linkCount <= 0) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.mode === "maintenance" && !isMaintenanceGraphNode(node)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.maxLinks !== undefined && node.linkCount > filters.maxLinks) {
      hiddenNodeIds.add(node.id)
    }
  }

  const visibleNodes = nodes.filter((node) => !hiddenNodeIds.has(node.id))
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id))
  const visibleEdges = edges.filter(
    (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  )

  return { nodes: visibleNodes, edges: visibleEdges, hiddenNodeIds }
}

export function hasActiveGraphFilters(filters: GraphFilterState): boolean {
  const defaultHidden = getDefaultHiddenTypesForMode(filters.mode)
  const hiddenTypesMatchDefault =
    filters.hiddenTypes.size === defaultHidden.size &&
    [...defaultHidden].every((type) => filters.hiddenTypes.has(type))

  return (
    filters.mode !== "knowledge" ||
    filters.hideStructural ||
    filters.hideIsolated ||
    !hiddenTypesMatchDefault ||
    filters.hiddenNodeIds.size > 0 ||
    filters.maxLinks !== undefined
  )
}

export function isMaintenanceGraphNode(node: GraphNode): boolean {
  const unresolvedCount =
    (node.unresolvedRelated?.length ?? 0) + (node.unresolvedSources?.length ?? 0)
  if (unresolvedCount > 0) return true
  if (node.linkCount <= 0) return true
  if (isLowQualityGraphNode(node)) return true
  if (isKnowledgeNodeType(node.type) && (node.sources?.length ?? 0) === 0) return true
  return false
}

function isLowQualityGraphNode(node: GraphNode): boolean {
  if (node.needsUpgrade === true) return true
  if (node.state === "seed" || node.state === "draft") return true
  if (node.quality === "seed" || node.quality === "draft") return true
  if (node.coverage === "low") return true
  if (node.evidenceStrength === "weak") return true
  if (node.type === "source" && node.sourceCount === undefined) return true
  if (isKnowledgeNodeType(node.type) && (
    node.quality === undefined ||
    node.coverage === undefined ||
    node.needsUpgrade === undefined
  )) return true
  return false
}

function isKnowledgeNodeType(type: string): boolean {
  return type === "entity" || type === "concept" || type === "comparison" || type === "synthesis"
}
