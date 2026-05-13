import type { EdgeLabelDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering"

import { getGraphNodeTypeColor } from "@/lib/graph-node-types"
import type { GraphEdgeType } from "@/lib/graph-relations"

export const COMMUNITY_COLORS = [
  "#60a5fa",  // blue-400
  "#4ade80",  // green-400
  "#fb923c",  // orange-400
  "#c084fc",  // purple-400
  "#f87171",  // red-400
  "#2dd4bf",  // teal-400
  "#facc15",  // yellow-400
  "#f472b6",  // pink-400
  "#a78bfa",  // violet-400
  "#38bdf8",  // sky-400
  "#34d399",  // emerald-400
  "#fbbf24",  // amber-400
]

export type ColorMode = "type" | "community"

// Kevin-approved local graph baseline. Keep this visual contract pinned unless
// the graph-view visual contract test is deliberately updated with approval.
export const BASE_NODE_SIZE = 8
export const MAX_NODE_SIZE = 28
export const LIGHT_GRAPH_THEME = {
  label: "#1e293b",
  labelHalo: "rgba(248,250,252,0.92)",
  edgeLabel: "#334155",
  defaultEdge: "#cbd5e1",
  dimmedNodeMix: "#e2e8f0",
  dimmedEdge: "#f1f5f9",
  highlightedEdge: "#1e293b",
}
export const DARK_GRAPH_THEME = {
  label: "#dcddde",
  labelHalo: "rgba(30,30,30,0.92)",
  edgeLabel: "#c7c7c7",
  defaultEdge: "#4a4a4a",
  dimmedNodeMix: "#2b2b2b",
  dimmedEdge: "#3a3a3a",
  highlightedEdge: "#b3b3b3",
}

export function nodeColor(type: string): string {
  return getGraphNodeTypeColor(type)
}

export function edgeTypeLabel(types: readonly GraphEdgeType[]): string {
  return types.map((type) => {
    if (type === "wikilink") return "wikilink"
    if (type === "related") return "related"
    return "source"
  }).join(" + ")
}

export function edgeVisual(types: readonly GraphEdgeType[], normalizedWeight: number): { color: string; size: number } {
  const hasSource = types.includes("source")
  const hasRelated = types.includes("related")
  const color = hasSource
    ? `rgba(249,115,22,${0.45 + normalizedWeight * 0.45})`
    : hasRelated
      ? `rgba(37,99,235,${0.4 + normalizedWeight * 0.45})`
      : `rgba(100,116,139,${0.25 + normalizedWeight * 0.55})`
  const relationBonus = hasSource ? 1.2 : hasRelated ? 0.7 : 0
  return {
    color,
    size: 0.5 + normalizedWeight * 2.4 + relationBonus,
  }
}

export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export function mixColor(color1: string, color2: string, ratio: number): string {
  const hex = (c: string) => parseInt(c, 16)
  const r1 = hex(color1.slice(1, 3)), g1 = hex(color1.slice(3, 5)), b1 = hex(color1.slice(5, 7))
  const r2 = hex(color2.slice(1, 3)), g2 = hex(color2.slice(3, 5)), b2 = hex(color2.slice(5, 7))
  const r = Math.round(r1 + (r2 - r1) * ratio)
  const g = Math.round(g1 + (g2 - g1) * ratio)
  const b = Math.round(b1 + (b2 - b1) * ratio)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

export function nodeSize(linkCount: number, maxLinks: number): number {
  if (maxLinks === 0) return BASE_NODE_SIZE
  const ratio = linkCount / maxLinks
  return BASE_NODE_SIZE + Math.sqrt(ratio) * (MAX_NODE_SIZE - BASE_NODE_SIZE)
}

export const drawReadableNodeLabel: NodeLabelDrawingFunction = (context, data, settings) => {
  if (!data.label) return
  const color = settings.labelColor.attribute
    ? data[settings.labelColor.attribute] ?? settings.labelColor.color ?? "#000"
    : settings.labelColor.color
  const x = data.x + data.size + 3
  const y = data.y + settings.labelSize / 3

  context.save()
  context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`
  context.lineJoin = "round"
  context.miterLimit = 2
  context.lineWidth = Math.max(3, settings.labelSize * 0.32)
  context.strokeStyle = String((settings as typeof settings & { labelHaloColor?: string }).labelHaloColor ?? "rgba(255,255,255,0.9)")
  context.strokeText(data.label, x, y)
  context.fillStyle = String(color)
  context.fillText(data.label, x, y)
  context.restore()
}

export const drawReadableEdgeLabel: EdgeLabelDrawingFunction = (context, edgeData, sourceData, targetData, settings) => {
  if (!edgeData.label) return
  const color = settings.edgeLabelColor.attribute
    ? edgeData[settings.edgeLabelColor.attribute] ?? settings.edgeLabelColor.color ?? "#000"
    : settings.edgeLabelColor.color

  const sx = sourceData.x
  const sy = sourceData.y
  const tx = targetData.x
  const ty = targetData.y
  const dx = tx - sx
  const dy = ty - sy
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance <= sourceData.size + targetData.size) return

  const text = String(edgeData.label)
  const angle = Math.atan2(dy, dx)
  const midpointX = (sx + tx) / 2
  const midpointY = (sy + ty) / 2

  context.save()
  context.translate(midpointX, midpointY)
  context.rotate(angle)
  context.font = `${settings.edgeLabelWeight} ${settings.edgeLabelSize}px ${settings.edgeLabelFont}`
  const width = context.measureText(text).width
  const y = edgeData.size / 2 + settings.edgeLabelSize
  context.lineJoin = "round"
  context.miterLimit = 2
  context.lineWidth = Math.max(3, settings.edgeLabelSize * 0.32)
  context.strokeStyle = String((settings as typeof settings & { labelHaloColor?: string }).labelHaloColor ?? "rgba(255,255,255,0.9)")
  context.strokeText(text, -width / 2, y)
  context.fillStyle = String(color)
  context.fillText(text, -width / 2, y)
  context.restore()
}
