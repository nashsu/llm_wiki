import { useEffect, useCallback, useMemo, useState, useRef, type ChangeEvent } from "react"
import Graph from "graphology"
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from "@react-sigma/core"
import "@react-sigma/core/lib/style.css"
import type { MouseCoords, SigmaNodeEventPayload } from "sigma/types"
import type { EdgeLabelDrawingFunction, NodeHoverDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering"
import type { Settings } from "sigma/settings"
import forceAtlas2 from "graphology-layout-forceatlas2"
import { Network, RefreshCw, ZoomIn, ZoomOut, Maximize, Layers, Tag, Lightbulb, AlertTriangle, Link2, X, Search, Loader2, Filter, RotateCcw, EyeOff } from "lucide-react"
import { ErrorBoundary } from "@/components/error-boundary"
import { useResearchStore } from "@/stores/research-store"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile } from "@/commands/fs"
import { buildWikiGraph, type GraphNode, type GraphEdge, type CommunityInfo } from "@/lib/wiki-graph"
import { findSurprisingConnections, detectKnowledgeGaps, type SurprisingConnection, type KnowledgeGap } from "@/lib/graph-insights"
import { queueResearch } from "@/lib/deep-research"
import { optimizeResearchTopic } from "@/lib/optimize-research-topic"
import { normalizePath } from "@/lib/path-utils"
import { applyGraphFilters, createGraphFiltersForMode, GRAPH_MODE_OPTIONS, hasActiveGraphFilters, isStructuralGraphNode, type GraphFilterState, type GraphMode } from "@/lib/graph-filters"
import { getGraphNodeTypeColor, getGraphNodeTypeEntries } from "@/lib/graph-node-types"
import type { GraphEdgeType } from "@/lib/graph-relations"

const COMMUNITY_COLORS = [
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

type ColorMode = "type" | "community"
type GraphSigmaSettings = Partial<Settings> & {
  labelHaloColor: string
  nodeHoverBackgroundColor: string
  nodeHoverLabelColor: string
  nodeHoverBorderColor: string
  nodeHoverShadowColor: string
}
type NodeDragState = {
  node: string
  draggedNodes: Set<string>
  startGraph: { x: number; y: number }
  startViewport: { x: number; y: number }
  positions: Map<string, { x: number; y: number; pull: number; settle: number }>
  moved: boolean
  previousCameraPanning: boolean
}

const BASE_NODE_SIZE = 4.5
const MAX_NODE_SIZE = 16
const MIN_NODE_SIZE = 2.2
const GRAPH_SCALE_REFERENCE_NODES = 80
const DRAG_NEIGHBOR_PULL = 0.32
const DRAG_SELECTED_SETTLE = 0.22
const DRAG_NEIGHBOR_SETTLE = 0.06
const DRAG_SPRING_STIFFNESS = 0.18
const DRAG_SPRING_DAMPING = 0.72
const DRAG_SPRING_MAX_FRAMES = 90
const DRAG_SPRING_EPSILON = 0.018
const LIGHT_GRAPH_THEME = {
  label: "#1e293b",
  labelHalo: "rgba(248,250,252,0.92)",
  edgeLabel: "#334155",
  defaultEdge: "#cbd5e1",
  edgeRgb: "104,108,112",
  dimmedNodeMix: "#e2e8f0",
  dimmedEdge: "rgba(104,108,112,0.12)",
  highlightedEdge: "rgba(88,92,96,0.58)",
  hoverLabel: "#0f172a",
  hoverLabelBackground: "rgba(248,250,252,0.96)",
  hoverLabelBorder: "rgba(15,23,42,0.24)",
  hoverShadow: "rgba(15,23,42,0.18)",
}
const DARK_GRAPH_THEME = {
  label: "#dcddde",
  labelHalo: "rgba(30,30,30,0.92)",
  edgeLabel: "#c7c7c7",
  defaultEdge: "#4a4a4a",
  edgeRgb: "96,101,106",
  dimmedNodeMix: "#2b2b2b",
  dimmedEdge: "rgba(96,101,106,0.10)",
  highlightedEdge: "rgba(184,188,192,0.62)",
  hoverLabel: "#f8fafc",
  hoverLabelBackground: "rgba(15,23,42,0.94)",
  hoverLabelBorder: "rgba(226,232,240,0.28)",
  hoverShadow: "rgba(0,0,0,0.45)",
}

function nodeColor(type: string): string {
  return getGraphNodeTypeColor(type)
}

function edgeTypeLabel(types: readonly GraphEdgeType[]): string {
  return types.map((type) => {
    if (type === "wikilink") return "wikilink"
    if (type === "related") return "related"
    return "source"
  }).join(" + ")
}

function edgeVisual(
  types: readonly GraphEdgeType[],
  normalizedWeight: number,
  mode: GraphMode,
  visualScale: number,
  edgeRgb: string,
): { color: string; size: number } {
  const hasSource = types.includes("source")
  const hasRelated = types.includes("related")
  const evidenceBoost = mode === "evidence" && hasSource ? 0.08 : 0
  const semanticBoost = hasRelated ? 0.03 : 0
  const alpha = Math.min(0.36, 0.16 + normalizedWeight * 0.12 + semanticBoost + evidenceBoost)
  const weightBoost = mode === "evidence" && hasSource ? 0.08 : hasRelated ? 0.04 : 0
  return {
    color: `rgba(${edgeRgb},${alpha})`,
    size: Math.max(0.1, (0.12 + normalizedWeight * 0.34 + weightBoost) * visualScale),
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function mixColor(color1: string, color2: string, ratio: number): string {
  const hex = (c: string) => parseInt(c, 16)
  const r1 = hex(color1.slice(1, 3)), g1 = hex(color1.slice(3, 5)), b1 = hex(color1.slice(5, 7))
  const r2 = hex(color2.slice(1, 3)), g2 = hex(color2.slice(3, 5)), b2 = hex(color2.slice(5, 7))
  const r = Math.round(r1 + (r2 - r1) * ratio)
  const g = Math.round(g1 + (g2 - g1) * ratio)
  const b = Math.round(b1 + (b2 - b1) * ratio)
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
}

function graphVisualScale(nodeCount: number): number {
  const scale = Math.sqrt(GRAPH_SCALE_REFERENCE_NODES / Math.max(nodeCount, GRAPH_SCALE_REFERENCE_NODES))
  return Math.max(0.38, Math.min(0.72, scale))
}

function nodeSize(linkCount: number, maxLinks: number, nodeCount: number): number {
  if (maxLinks === 0) return BASE_NODE_SIZE * graphVisualScale(nodeCount)
  const ratio = linkCount / maxLinks
  const scaledSize = (BASE_NODE_SIZE + Math.sqrt(ratio) * (MAX_NODE_SIZE - BASE_NODE_SIZE)) * graphVisualScale(nodeCount)
  return Math.max(MIN_NODE_SIZE, scaledSize)
}

function graphLabelSettings(nodeCount: number): { labelSize: number; labelDensity: number; labelRenderedSizeThreshold: number } {
  if (nodeCount >= 700) return { labelSize: 9, labelDensity: 0.05, labelRenderedSizeThreshold: 11 }
  if (nodeCount >= 300) return { labelSize: 10, labelDensity: 0.08, labelRenderedSizeThreshold: 10 }
  if (nodeCount >= 120) return { labelSize: 10, labelDensity: 0.12, labelRenderedSizeThreshold: 9 }
  return { labelSize: 11, labelDensity: 0.16, labelRenderedSizeThreshold: 8 }
}

function graphLayoutSettings(nodeCount: number): { iterations: number; gravity: number; scalingRatio: number } {
  if (nodeCount >= 700) return { iterations: 260, gravity: 0.65, scalingRatio: 6 }
  if (nodeCount >= 300) return { iterations: 230, gravity: 0.75, scalingRatio: 5 }
  if (nodeCount >= 120) return { iterations: 200, gravity: 0.85, scalingRatio: 4 }
  return { iterations: 170, gravity: 0.9, scalingRatio: 3 }
}

function getDocumentDarkMode(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
}

function useDocumentDarkMode(): boolean {
  const [isDark, setIsDark] = useState(getDocumentDarkMode)

  useEffect(() => {
    const root = document.documentElement
    const update = () => setIsDark(root.classList.contains("dark"))
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return isDark
}

const drawReadableNodeLabel: NodeLabelDrawingFunction = (context, data, settings) => {
  if (!data.label) return
  const color = settings.labelColor.attribute
    ? data[settings.labelColor.attribute] ?? settings.labelColor.color ?? "#000"
    : settings.labelColor.color
  const x = data.x + data.size + 4
  const y = data.y + settings.labelSize / 3

  context.save()
  context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`
  context.lineJoin = "round"
  context.miterLimit = 2
  context.lineWidth = Math.max(2.4, settings.labelSize * 0.24)
  context.strokeStyle = String((settings as typeof settings & { labelHaloColor?: string }).labelHaloColor ?? "rgba(255,255,255,0.9)")
  context.strokeText(data.label, x, y)
  context.fillStyle = String(color)
  context.fillText(data.label, x, y)
  context.restore()
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.lineTo(x + width - r, y)
  context.quadraticCurveTo(x + width, y, x + width, y + r)
  context.lineTo(x + width, y + height - r)
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  context.lineTo(x + r, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - r)
  context.lineTo(x, y + r)
  context.quadraticCurveTo(x, y, x + r, y)
  context.closePath()
}

const drawReadableNodeHover: NodeHoverDrawingFunction = (context, data, settings) => {
  const label = typeof data.label === "string" ? data.label : ""
  const hoverSettings = settings as typeof settings & {
    nodeHoverBackgroundColor?: string
    nodeHoverLabelColor?: string
    nodeHoverBorderColor?: string
    nodeHoverShadowColor?: string
  }
  const background = hoverSettings.nodeHoverBackgroundColor ?? "rgba(15,23,42,0.94)"
  const labelColor = hoverSettings.nodeHoverLabelColor ?? "#f8fafc"
  const border = hoverSettings.nodeHoverBorderColor ?? "rgba(226,232,240,0.28)"
  const shadow = hoverSettings.nodeHoverShadowColor ?? "rgba(0,0,0,0.35)"

  context.save()
  context.shadowOffsetX = 0
  context.shadowOffsetY = 2
  context.shadowBlur = 10
  context.shadowColor = shadow

  context.beginPath()
  context.arc(data.x, data.y, data.size + 3.5, 0, Math.PI * 2)
  context.fillStyle = background
  context.fill()
  context.lineWidth = 1.5
  context.strokeStyle = border
  context.stroke()

  if (label) {
    const size = Math.max(settings.labelSize, 11)
    context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`
    const paddingX = 7
    const paddingY = 4
    const textWidth = context.measureText(label).width
    const labelX = data.x + data.size + 7
    const labelY = data.y - size / 2 - paddingY
    const boxWidth = textWidth + paddingX * 2
    const boxHeight = size + paddingY * 2

    drawRoundedRect(context, labelX, labelY, boxWidth, boxHeight, 4)
    context.fillStyle = background
    context.fill()
    context.lineWidth = 1
    context.strokeStyle = border
    context.stroke()

    context.shadowBlur = 0
    context.fillStyle = labelColor
    context.fillText(label, labelX + paddingX, data.y + size / 3)
  }

  context.restore()
}

const drawReadableEdgeLabel: EdgeLabelDrawingFunction = (context, edgeData, sourceData, targetData, settings) => {
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

// --- Inner components ---

// Cache computed node positions so re-renders don't re-layout
const positionCache = new Map<string, { x: number; y: number }>()
let lastLayoutDataKey = ""

function GraphLoader({
  nodes,
  edges,
  colorMode,
  mode,
  edgeRgb,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  colorMode: ColorMode
  mode: GraphMode
  edgeRgb: string
}) {
  const loadGraph = useLoadGraph()

  useEffect(() => {
    const edgeKey = edges
      .map((e) => `${e.source}->${e.target}:${e.types.join(",")}`)
      .sort()
      .join(",")
    const dataKey = nodes.map((n) => n.id).sort().join(",") + "|" + edgeKey
    const needsLayout = dataKey !== lastLayoutDataKey

    const graph = new Graph()
    const maxLinks = Math.max(...nodes.map((n) => n.linkCount), 1)
    const nodeCount = nodes.length
    const visualScale = graphVisualScale(nodeCount)
    const layoutSettings = graphLayoutSettings(nodeCount)

    for (const node of nodes) {
      const cached = positionCache.get(node.id)
      const color = colorMode === "community"
        ? COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length]
        : nodeColor(node.type)
      graph.addNode(node.id, {
        x: cached?.x ?? Math.random() * 100,
        y: cached?.y ?? Math.random() * 100,
        size: nodeSize(node.linkCount, maxLinks, nodeCount),
        color,
        label: node.label,
        nodeType: node.type,
        nodePath: node.path,
        community: node.community,
      })
    }

    // Calculate max weight for normalization
    const maxWeight = Math.max(...edges.map((e) => e.weight), 1)

    for (const edge of edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        const edgeKey = `${edge.source}->${edge.target}`
        if (!graph.hasEdge(edgeKey) && !graph.hasEdge(`${edge.target}->${edge.source}`)) {
          const normalizedWeight = edge.weight / maxWeight // 0..1
          const visual = edgeVisual(edge.types, normalizedWeight, mode, visualScale, edgeRgb)
          graph.addEdgeWithKey(edgeKey, edge.source, edge.target, {
            color: visual.color,
            size: visual.size,
            weight: edge.weight,
            relationLabel: edgeTypeLabel(edge.types),
          })
        }
      }
    }

    // Only run expensive ForceAtlas2 layout when data actually changed
    if (needsLayout && nodes.length > 1) {
      const settings = forceAtlas2.inferSettings(graph)
      forceAtlas2.assign(graph, {
        iterations: layoutSettings.iterations,
        settings: {
          ...settings,
          gravity: layoutSettings.gravity,
          scalingRatio: layoutSettings.scalingRatio,
          strongGravityMode: true,
          barnesHutOptimize: nodes.length > 50,
        },
      })
      lastLayoutDataKey = dataKey

      // Cache computed positions
      graph.forEachNode((nodeId, attrs) => {
        positionCache.set(nodeId, { x: attrs.x, y: attrs.y })
      })
    }

    loadGraph(graph)
  }, [loadGraph, nodes, edges, colorMode, mode, edgeRgb])

  return null
}

function HighlightManager({ highlightedNodes }: { highlightedNodes: Set<string> }) {
  const sigma = useSigma()

  useEffect(() => {
    const graph = sigma.getGraph()
    if (highlightedNodes.size === 0) {
      graph.forEachNode((n) => {
        graph.removeNodeAttribute(n, "insightHighlight")
        graph.removeNodeAttribute(n, "dimmed")
      })
      graph.forEachEdge((e) => {
        graph.removeEdgeAttribute(e, "dimmed")
        graph.removeEdgeAttribute(e, "highlighted")
      })
    } else {
      graph.forEachNode((n) => {
        if (highlightedNodes.has(n)) {
          graph.setNodeAttribute(n, "insightHighlight", true)
          graph.removeNodeAttribute(n, "dimmed")
        } else {
          graph.setNodeAttribute(n, "dimmed", true)
          graph.removeNodeAttribute(n, "insightHighlight")
        }
      })
      graph.forEachEdge((e, _attrs, source, target) => {
        if (highlightedNodes.has(source) && highlightedNodes.has(target)) {
          graph.setEdgeAttribute(e, "highlighted", true)
          graph.removeEdgeAttribute(e, "dimmed")
        } else {
          graph.setEdgeAttribute(e, "dimmed", true)
          graph.removeEdgeAttribute(e, "highlighted")
        }
      })
    }
    sigma.refresh()
  }, [sigma, highlightedNodes])

  return null
}

function EventHandler({
  onNodeClick,
  onNodeContextMenu,
}: {
  onNodeClick: (nodeId: string) => void
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void
}) {
  const registerEvents = useRegisterEvents()
  const sigma = useSigma()
  const dragStateRef = useRef<NodeDragState | null>(null)
  const suppressClickRef = useRef(false)
  const settleAnimationRef = useRef<number | null>(null)

  useEffect(() => {
    const graph = sigma.getGraph()
    const container = sigma.getContainer()

    const cancelSettleAnimation = () => {
      if (settleAnimationRef.current === null) return
      window.cancelAnimationFrame(settleAnimationRef.current)
      settleAnimationRef.current = null
    }

    const cacheNodePositions = (nodeIds: Iterable<string>) => {
      Array.from(nodeIds).forEach((nodeId) => {
        if (!graph.hasNode(nodeId)) return
        const x = graph.getNodeAttribute(nodeId, "x")
        const y = graph.getNodeAttribute(nodeId, "y")
        if (typeof x === "number" && typeof y === "number") {
          positionCache.set(nodeId, { x, y })
        }
      })
    }

    const focusNode = (node: string) => {
      container.style.cursor = "pointer"
      graph.setNodeAttribute(node, "hovering", true)
      const neighbors = new Set(graph.neighbors(node))
      neighbors.add(node)
      graph.forEachNode((n) => {
        if (!neighbors.has(n)) graph.setNodeAttribute(n, "dimmed", true)
        else graph.removeNodeAttribute(n, "dimmed")
      })
      graph.forEachEdge((e, _attrs, source, target) => {
        if (source !== node && target !== node) {
          graph.setEdgeAttribute(e, "dimmed", true)
          graph.removeEdgeAttribute(e, "highlighted")
        } else {
          graph.setEdgeAttribute(e, "highlighted", true)
          graph.removeEdgeAttribute(e, "dimmed")
        }
      })
      sigma.refresh()
    }

    const clearNodeFocus = () => {
      container.style.cursor = "default"
      graph.forEachNode((n) => {
        graph.removeNodeAttribute(n, "hovering")
        graph.removeNodeAttribute(n, "dimmed")
      })
      graph.forEachEdge((e) => {
        graph.removeEdgeAttribute(e, "dimmed")
        graph.removeEdgeAttribute(e, "highlighted")
      })
      sigma.refresh()
    }

    const settleDraggedNodes = (drag: NodeDragState) => {
      const nodeIds = [...drag.draggedNodes].filter((nodeId) => graph.hasNode(nodeId))
      if (nodeIds.length === 0) return

      const velocities = new Map<string, { x: number; y: number }>()
      const targets = new Map<string, { x: number; y: number }>()

      nodeIds.forEach((nodeId) => {
        const origin = drag.positions.get(nodeId)
        if (!origin) return
        const x = graph.getNodeAttribute(nodeId, "x")
        const y = graph.getNodeAttribute(nodeId, "y")
        if (typeof x !== "number" || typeof y !== "number") return
        targets.set(nodeId, {
          x: origin.x + (x - origin.x) * origin.settle,
          y: origin.y + (y - origin.y) * origin.settle,
        })
        velocities.set(nodeId, { x: 0, y: 0 })
      })

      if (targets.size === 0) return

      let frameCount = 0
      const settleStep = () => {
        let active = false
        frameCount += 1

        targets.forEach((target, nodeId) => {
          if (!graph.hasNode(nodeId)) return
          const x = graph.getNodeAttribute(nodeId, "x")
          const y = graph.getNodeAttribute(nodeId, "y")
          if (typeof x !== "number" || typeof y !== "number") return

          const previousVelocity = velocities.get(nodeId) ?? { x: 0, y: 0 }
          const vx = (previousVelocity.x + (target.x - x) * DRAG_SPRING_STIFFNESS) * DRAG_SPRING_DAMPING
          const vy = (previousVelocity.y + (target.y - y) * DRAG_SPRING_STIFFNESS) * DRAG_SPRING_DAMPING
          const nextX = x + vx
          const nextY = y + vy

          graph.setNodeAttribute(nodeId, "x", nextX)
          graph.setNodeAttribute(nodeId, "y", nextY)
          velocities.set(nodeId, { x: vx, y: vy })

          const distance = Math.hypot(target.x - nextX, target.y - nextY)
          const speed = Math.hypot(vx, vy)
          if (distance > DRAG_SPRING_EPSILON || speed > DRAG_SPRING_EPSILON) active = true
        })

        sigma.refresh({ partialGraph: { nodes: nodeIds }, skipIndexation: true })

        if (active && frameCount < DRAG_SPRING_MAX_FRAMES) {
          settleAnimationRef.current = window.requestAnimationFrame(settleStep)
          return
        }

        targets.forEach((target, nodeId) => {
          if (!graph.hasNode(nodeId)) return
          graph.setNodeAttribute(nodeId, "x", target.x)
          graph.setNodeAttribute(nodeId, "y", target.y)
          positionCache.set(nodeId, target)
        })
        settleAnimationRef.current = null
        sigma.refresh({ partialGraph: { nodes: nodeIds }, skipIndexation: true })
      }

      settleAnimationRef.current = window.requestAnimationFrame(settleStep)
    }

    const stopDragging = () => {
      const drag = dragStateRef.current
      if (!drag) return
      suppressClickRef.current = drag.moved
      dragStateRef.current = null
      sigma.setSetting("enableCameraPanning", drag.previousCameraPanning)
      clearNodeFocus()
      if (drag.moved) {
        cancelSettleAnimation()
        settleDraggedNodes(drag)
      } else {
        cacheNodePositions(drag.draggedNodes)
      }
    }

    registerEvents({
      clickNode: ({ node }) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        onNodeClick(node)
      },
      downNode: (payload: SigmaNodeEventPayload) => {
        cancelSettleAnimation()
        payload.preventSigmaDefault()
        payload.event.preventSigmaDefault()
        payload.event.original.preventDefault()
        const node = payload.node
        const neighbors = new Set(graph.neighbors(node))
        const draggedNodes = new Set([node, ...neighbors])
        const startGraph = sigma.viewportToGraph({ x: payload.event.x, y: payload.event.y })
        const positions = new Map<string, { x: number; y: number; pull: number; settle: number }>()

        draggedNodes.forEach((nodeId) => {
          positions.set(nodeId, {
            x: graph.getNodeAttribute(nodeId, "x"),
            y: graph.getNodeAttribute(nodeId, "y"),
            pull: nodeId === node ? 1 : DRAG_NEIGHBOR_PULL,
            settle: nodeId === node ? DRAG_SELECTED_SETTLE : DRAG_NEIGHBOR_SETTLE,
          })
        })

        dragStateRef.current = {
          node,
          draggedNodes,
          startGraph,
          startViewport: { x: payload.event.x, y: payload.event.y },
          positions,
          moved: false,
          previousCameraPanning: sigma.getSetting("enableCameraPanning"),
        }
        container.style.cursor = "grabbing"
        sigma.setSetting("enableCameraPanning", false)
        focusNode(node)
      },
      rightClickNode: (payload: SigmaNodeEventPayload) => {
        payload.preventSigmaDefault()
        payload.event.original.preventDefault()
        const point = clientPointFromEvent(payload.event.original)
        onNodeContextMenu(nodeIdFromPayload(payload), point.x, point.y)
      },
      rightClickStage: () => onNodeContextMenu("", 0, 0),
      mousemovebody: (event: MouseCoords) => {
        const drag = dragStateRef.current
        if (!drag) return
        event.preventSigmaDefault()
        event.original.preventDefault()
        const currentGraph = sigma.viewportToGraph({ x: event.x, y: event.y })
        const dx = currentGraph.x - drag.startGraph.x
        const dy = currentGraph.y - drag.startGraph.y
        const viewportDistance = Math.hypot(event.x - drag.startViewport.x, event.y - drag.startViewport.y)
        if (viewportDistance > 3) drag.moved = true

        drag.positions.forEach((position, nodeId) => {
          graph.setNodeAttribute(nodeId, "x", position.x + dx * position.pull)
          graph.setNodeAttribute(nodeId, "y", position.y + dy * position.pull)
        })
        sigma.refresh({ partialGraph: { nodes: [...drag.draggedNodes] }, skipIndexation: true })
      },
      mouseup: stopDragging,
      mouseleave: stopDragging,
      enterNode: ({ node }) => {
        if (dragStateRef.current) return
        focusNode(node)
      },
      leaveNode: () => {
        if (dragStateRef.current) return
        clearNodeFocus()
      },
    })

    return () => {
      cancelSettleAnimation()
      const drag = dragStateRef.current
      if (!drag) return
      sigma.setSetting("enableCameraPanning", drag.previousCameraPanning)
      dragStateRef.current = null
    }
  }, [registerEvents, sigma, onNodeClick, onNodeContextMenu])

  return null
}

function nodeIdFromPayload(payload: SigmaNodeEventPayload): string {
  return payload.node
}

function clientPointFromEvent(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY }
  const touch = event.touches[0] ?? event.changedTouches[0]
  return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 }
}

function ZoomControls() {
  const sigma = useSigma()

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1">
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedZoom({ duration: 200 })
        }}
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedUnzoom({ duration: 200 })
        }}
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedReset({ duration: 300 })
        }}
      >
        <Maximize className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

// --- Main component ---

export function GraphView() {
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)

  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [communities, setCommunities] = useState<CommunityInfo[]>([])
  const [surprisingConns, setSurprisingConns] = useState<SurprisingConnection[]>([])
  const [knowledgeGaps, setKnowledgeGaps] = useState<KnowledgeGap[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hoveredType, setHoveredType] = useState<string | null>(null)
  const [colorMode, setColorMode] = useState<ColorMode>("type")
  const [showInsights, setShowInsights] = useState(false)
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set())
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set())
  const [sigmaKey, setSigmaKey] = useState(0)
  const [isResizing, setIsResizing] = useState(false)
  const [legendCollapsed, setLegendCollapsed] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState<GraphFilterState>(() => createGraphFiltersForMode("knowledge"))
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const graphContainerRef = useRef<HTMLDivElement>(null)
  const isDarkGraph = useDocumentDarkMode()
  const graphTheme = isDarkGraph ? DARK_GRAPH_THEME : LIGHT_GRAPH_THEME
  // Research confirmation dialog
  const [researchDialog, setResearchDialog] = useState<{
    loading: boolean
    topic: string
    queries: string[]
  } | null>(null)
  const lastLoadedVersion = useRef(-1)

  const loadGraph = useCallback(async () => {
    if (!project) return
    setLoading(true)
    setError(null)
    try {
      const result = await buildWikiGraph(normalizePath(project.path))
      setNodes(result.nodes)
      setEdges(result.edges)
      setCommunities(result.communities)
      setSurprisingConns(findSurprisingConnections(result.nodes, result.edges, result.communities))
      setKnowledgeGaps(detectKnowledgeGaps(result.nodes, result.edges, result.communities))
      lastLoadedVersion.current = useWikiStore.getState().dataVersion
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to build graph"
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [project])

  useEffect(() => {
    if (dataVersion !== lastLoadedVersion.current) {
      loadGraph()
    }
  }, [loadGraph, dataVersion])

  const handleNodeClick = useCallback(
    async (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return
      try {
        const content = await readFile(node.path)
        setSelectedFile(node.path)
        setFileContent(content)
      } catch (err) {
        console.error("Failed to open wiki page:", err)
      }
    },
    [nodes, setSelectedFile, setFileContent],
  )

  const handleNodeContextMenu = useCallback((nodeId: string, x: number, y: number) => {
    if (!nodeId) {
      setNodeMenu(null)
      return
    }
    const rect = graphContainerRef.current?.getBoundingClientRect()
    setNodeMenu({
      nodeId,
      x: rect ? x - rect.left : x,
      y: rect ? y - rect.top : y,
    })
  }, [])

  const resetFilters = useCallback(() => {
    setFilters((prev) => createGraphFiltersForMode(prev.mode))
    setNodeMenu(null)
  }, [])

  const setGraphMode = useCallback((mode: GraphMode) => {
    setFilters(createGraphFiltersForMode(mode))
    setNodeMenu(null)
    setHighlightedNodes(new Set())
  }, [])

  const handleResearchClick = useCallback(async (gapTitle: string, gapDescription: string, gapType: string) => {
    const store = useWikiStore.getState()
    if (!store.project) return
    const pp = normalizePath(store.project.path)

    // Show loading state
    setResearchDialog({ loading: true, topic: "", queries: [] })

    try {
      // Read overview and purpose for context
      let overview = ""
      let purpose = ""
      try { overview = await readFile(`${pp}/wiki/overview.md`) } catch {}
      try { purpose = await readFile(`${pp}/purpose.md`) } catch {}

      const result = await optimizeResearchTopic(
        store.llmConfig,
        gapTitle,
        gapDescription,
        gapType,
        overview,
        purpose,
      )
      setResearchDialog({ loading: false, topic: result.topic, queries: result.searchQueries })
    } catch {
      // Fallback: use raw title
      setResearchDialog({ loading: false, topic: gapTitle, queries: [gapTitle] })
    }
  }, [])

  const handleResearchConfirm = useCallback(() => {
    if (!researchDialog) return
    const store = useWikiStore.getState()
    if (!store.project) return
    queueResearch(
      normalizePath(store.project.path),
      researchDialog.topic,
      store.llmConfig,
      store.searchApiConfig,
      researchDialog.queries,
    )
    setResearchDialog(null)
  }, [researchDialog])

  // Unmount sigma when panels resize or toggle to prevent WebGL crash.
  // Sigma crashes with "could not find suitable program for node type circle"
  // when its canvas is resized by external layout changes.

  // 1. Detect panel open/close (selectedFile, researchPanel, insights)
  const selectedFileForLayout = useWikiStore((s) => s.selectedFile)
  const researchPanelForLayout = useResearchStore((s) => s.panelOpen)
  const layoutKey = `${!!selectedFileForLayout}-${researchPanelForLayout}-${showInsights}`
  const prevLayoutKey = useRef(layoutKey)

  useEffect(() => {
    if (prevLayoutKey.current !== layoutKey) {
      prevLayoutKey.current = layoutKey
      setIsResizing(true)
      const timer = setTimeout(() => {
        setSigmaKey((k) => k + 1)
        setIsResizing(false)
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [layoutKey])

  // 2. Detect panel drag resize via data-panel-resizing attribute on body
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const dragging = document.body.dataset.panelResizing === "true"
      if (dragging && !isResizing) {
        setIsResizing(true)
      }
      if (!dragging && isResizing) {
        // Drag ended — remount sigma after a tick
        setTimeout(() => {
          setSigmaKey((k) => k + 1)
          setIsResizing(false)
        }, 50)
      }
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-panel-resizing"] })
    return () => observer.disconnect()
  }, [isResizing])

  const filteredGraph = useMemo(
    () => applyGraphFilters(nodes, edges, filters),
    [nodes, edges, filters],
  )
  const visibleTypeCounts = filteredGraph.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1
    return acc
  }, {})
  const filterableTypeCounts = nodes.reduce<Record<string, number>>((acc, n) => {
    if (!isStructuralGraphNode(n)) {
      acc[n.type] = (acc[n.type] ?? 0) + 1
    }
    return acc
  }, {})
  const visibleTypeEntries = getGraphNodeTypeEntries(visibleTypeCounts)
  const filterableTypeEntries = getGraphNodeTypeEntries(filterableTypeCounts)
  const hiddenCount = nodes.length - filteredGraph.nodes.length
  const filtersActive = hasActiveGraphFilters(filters)
  const contextNode = nodeMenu ? nodes.find((node) => node.id === nodeMenu.nodeId) : null
  const labelSettings = useMemo(
    () => graphLabelSettings(filteredGraph.nodes.length),
    [filteredGraph.nodes.length],
  )
  const sigmaSettings = useMemo<GraphSigmaSettings>(() => ({
    renderEdgeLabels: false,
    defaultEdgeColor: graphTheme.defaultEdge,
    defaultNodeColor: "#94a3b8",
    labelSize: labelSettings.labelSize,
    labelWeight: "bold",
    labelColor: { color: graphTheme.label },
    edgeLabelSize: 10,
    edgeLabelWeight: "600",
    edgeLabelColor: { color: graphTheme.edgeLabel },
    labelDensity: labelSettings.labelDensity,
    labelRenderedSizeThreshold: labelSettings.labelRenderedSizeThreshold,
    stagePadding: 30,
    defaultDrawNodeLabel: drawReadableNodeLabel,
    defaultDrawNodeHover: drawReadableNodeHover,
    defaultDrawEdgeLabel: drawReadableEdgeLabel,
    labelHaloColor: graphTheme.labelHalo,
    nodeHoverBackgroundColor: graphTheme.hoverLabelBackground,
    nodeHoverLabelColor: graphTheme.hoverLabel,
    nodeHoverBorderColor: graphTheme.hoverLabelBorder,
    nodeHoverShadowColor: graphTheme.hoverShadow,
    nodeReducer: (_node, attrs) => {
      const result = { ...attrs }
      if (attrs.insightHighlight) {
        result.size = (attrs.size ?? BASE_NODE_SIZE) * 1.25
        result.zIndex = 10
        result.forceLabel = true
      }
      if (attrs.hovering) {
        result.size = (attrs.size ?? BASE_NODE_SIZE) * 1.18
        result.zIndex = 10
        result.forceLabel = true
      }
      if (attrs.dimmed) {
        result.color = mixColor(attrs.color ?? "#94a3b8", graphTheme.dimmedNodeMix, 0.75)
        result.label = ""
        result.size = (attrs.size ?? BASE_NODE_SIZE) * 0.6
      }
      return result
    },
    edgeReducer: (_edge, attrs) => {
      const result = { ...attrs }
      if (attrs.dimmed) {
        result.color = graphTheme.dimmedEdge
        result.size = 0.3
      }
      if (attrs.highlighted) {
        result.color = graphTheme.highlightedEdge
        result.size = Math.max(0.45, (attrs.size ?? 1) * 1.05)
        result.label = ""
        result.forceLabel = false
      }
      return result
    },
  }), [graphTheme, labelSettings])

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm">Open a project to view the graph</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <RefreshCw className="h-8 w-8 animate-spin opacity-50" />
        <p className="text-sm">Building graph...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={loadGraph}>Retry</Button>
      </div>
    )
  }

  if (!loading && nodes.length === 0 && !error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm">No pages yet</p>
        <p className="text-xs">Import sources to start building the knowledge graph</p>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Knowledge Graph</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">{filteredGraph.nodes.length}/{nodes.length} pages</span>
            <span className="rounded bg-muted px-1.5 py-0.5">{filteredGraph.edges.length}/{edges.length} relations</span>
            {hiddenCount > 0 && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                {hiddenCount} hidden
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="mr-1 flex items-center rounded-md border bg-muted/30 p-0.5">
            {GRAPH_MODE_OPTIONS.map((option) => (
              <Button
                key={option.id}
                variant={filters.mode === option.id ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setGraphMode(option.id)}
                className="h-6 px-2 text-xs"
              >
                {option.label}
              </Button>
            ))}
          </div>
          <Button
            variant={showFilters ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowFilters((v) => !v)}
            className="text-xs gap-1 h-7"
          >
            <Filter className="h-3 w-3" />
            Filter
          </Button>
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="text-xs gap-1 h-7"
              title="Reset graph filters"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          )}
          <Button
            variant={colorMode === "type" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setColorMode("type")}
            className="text-xs gap-1 h-7"
          >
            <Tag className="h-3 w-3" />
            Type
          </Button>
          <Button
            variant={colorMode === "community" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setColorMode("community")}
            className="text-xs gap-1 h-7"
          >
            <Layers className="h-3 w-3" />
            Community
          </Button>
          {(surprisingConns.filter((c) => !dismissedInsights.has(c.key)).length > 0 || knowledgeGaps.length > 0) && (
            <Button
              variant={showInsights ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setShowInsights((v) => {
                  if (v) setHighlightedNodes(new Set())
                  return !v
                })
              }}
              className="text-xs gap-1 h-7"
            >
              <Lightbulb className="h-3 w-3" />
              Insights
              <span className="rounded bg-muted px-1 text-[10px]">
                {surprisingConns.filter((c) => !dismissedInsights.has(c.key)).length + knowledgeGaps.length}
              </span>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={loadGraph} className="text-xs gap-1 h-7">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Graph canvas + Insights side panel */}
      <div className="flex flex-1 min-h-0">
        {/* Graph canvas */}
        <div
          ref={graphContainerRef}
          className="relative flex-1 min-w-0 overflow-hidden bg-slate-50 dark:bg-background"
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => setNodeMenu(null)}
        >
          {isResizing ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Resizing...
            </div>
          ) : (
            <ErrorBoundary>
              <SigmaContainer
                key={sigmaKey}
                style={{ width: "100%", height: "100%", background: "transparent" }}
                settings={sigmaSettings}
              >
                <GraphLoader
                  nodes={filteredGraph.nodes}
                  edges={filteredGraph.edges}
                  colorMode={colorMode}
                  mode={filters.mode}
                  edgeRgb={graphTheme.edgeRgb}
                />
                <EventHandler onNodeClick={handleNodeClick} onNodeContextMenu={handleNodeContextMenu} />
                <HighlightManager highlightedNodes={highlightedNodes} />
                <ZoomControls />
              </SigmaContainer>
            </ErrorBoundary>
          )}

          {showFilters && (
            <div className="absolute top-3 left-3 w-72 rounded-lg border bg-background/95 p-3 text-xs shadow-lg backdrop-blur-sm">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Filter className="h-3.5 w-3.5" />
                  Graph Filters
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={resetFilters}
                >
                  Reset
                </Button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">Quick filters</div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={filters.hideStructural}
                      onChange={(e) => setFilters((prev) => ({ ...prev, hideStructural: e.target.checked }))}
                    />
                    <span>Hide structural maps / indexes</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={filters.hideIsolated}
                      onChange={(e) => setFilters((prev) => ({ ...prev, hideIsolated: e.target.checked }))}
                    />
                    <span>Hide isolated nodes</span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">Max links</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      className="h-7 w-20 rounded border bg-background px-2 text-xs"
                      value={filters.maxLinks ?? ""}
                      onChange={(e) => {
                        const raw = e.target.value.trim()
                        const value = Number(raw)
                        setFilters((prev) => ({
                          ...prev,
                          maxLinks: raw === "" || !Number.isFinite(value) ? undefined : Math.max(0, value),
                        }))
                      }}
                      placeholder="Any"
                    />
                    <span className="text-muted-foreground">Hide nodes above this link count</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">Node types</div>
                  <div className="grid grid-cols-2 gap-1">
                    {filterableTypeEntries.map(([type, label, count]) => (
                        <label key={type} className="flex min-w-0 items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={!filters.hiddenTypes.has(type)}
                            onChange={(e) => {
                              setFilters((prev) => {
                                const next = new Set(prev.hiddenTypes)
                                if (e.target.checked) next.delete(type)
                                else next.add(type)
                                return { ...prev, hiddenTypes: next }
                              })
                            }}
                          />
                          <span className="truncate">{label}</span>
                          <span className="text-muted-foreground/60">{count}</span>
                        </label>
                      ))}
                  </div>
                </div>

                {filters.hiddenNodeIds.size > 0 && (
                  <div className="space-y-1.5">
                    <div className="font-medium text-muted-foreground">Hidden nodes</div>
                    <div className="max-h-24 space-y-1 overflow-y-auto">
                      {[...filters.hiddenNodeIds].map((nodeId) => {
                        const node = nodes.find((n) => n.id === nodeId)
                        return (
                          <div key={nodeId} className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1">
                            <span className="truncate">{node?.label ?? nodeId}</span>
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => setFilters((prev) => {
                                const next = new Set(prev.hiddenNodeIds)
                                next.delete(nodeId)
                                return { ...prev, hiddenNodeIds: next }
                              })}
                            >
                              Show
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="rounded bg-muted/50 px-2 py-1.5 text-muted-foreground">
                  Showing {filteredGraph.nodes.length} of {nodes.length} pages and {filteredGraph.edges.length} of {edges.length} links.
                </div>
              </div>
            </div>
          )}

          {nodeMenu && contextNode && (
            <div
              className="absolute z-20 w-48 rounded-md border bg-background py-1 text-xs shadow-lg"
              style={{ left: nodeMenu.x, top: nodeMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="border-b px-3 py-2">
                <div className="truncate font-medium text-foreground">{contextNode.label}</div>
                <div className="text-muted-foreground">{contextNode.linkCount} links</div>
              </div>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
                onClick={() => {
                  setFilters((prev) => ({
                    ...prev,
                    hiddenNodeIds: new Set([...prev.hiddenNodeIds, contextNode.id]),
                  }))
                  setNodeMenu(null)
                }}
              >
                <EyeOff className="h-3.5 w-3.5" />
                Hide this node
              </button>
            </div>
          )}

          {/* Legend */}
          <div className="absolute bottom-3 left-3 rounded-lg border bg-background/90 backdrop-blur-sm px-3 py-2 text-xs shadow-sm max-w-[260px]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-foreground">
                {colorMode === "type" ? "Node Types" : "Communities"}
              </span>
              <div className="flex items-center gap-1">
                {colorMode === "type" && filters.hiddenTypes.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] px-1"
                    onClick={() => setFilters((prev) => ({ ...prev, hiddenTypes: new Set() }))}
                    title="Show all types"
                  >
                    Show all
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setLegendCollapsed(!legendCollapsed)}
                  title={legendCollapsed ? "Expand legend" : "Collapse legend"}
                >
                  {legendCollapsed ? "▶" : "▼"}
                </Button>
              </div>
            </div>
            {!legendCollapsed && (
              colorMode === "type" ? (
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto legend-scroll" style={{ direction: "rtl" }}>
                  <div className="flex flex-col gap-0.5" style={{ direction: "ltr" }}>
                    {visibleTypeEntries.map(([type, label, count]) => {
                        const isHidden = filters.hiddenTypes.has(type)
                        return (
                          <div
                            key={type}
                            className={`flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent/50 ${isHidden ? "opacity-40" : ""}`}
                            onMouseEnter={() => setHoveredType(type)}
                            onMouseLeave={() => setHoveredType(null)}
                            onDoubleClick={() => {
                              setFilters((prev) => {
                                const next = new Set(prev.hiddenTypes)
                                if (next.has(type)) {
                                  next.delete(type)
                                } else {
                                  next.add(type)
                                }
                                return { ...prev, hiddenTypes: next }
                              })
                            }}
                            title="Double-click to toggle visibility"
                          >
                            <span
                              className="inline-block h-3 w-3 rounded-full shrink-0 shadow-sm"
                              style={{
                                backgroundColor: isHidden ? "#94a3b8" : getGraphNodeTypeColor(type),
                                boxShadow: `0 0 4px ${hexToRgba(isHidden ? "#94a3b8" : getGraphNodeTypeColor(type), 0.4)}`,
                              }}
                            />
                            <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                              {label}
                            </span>
                            <span className="text-muted-foreground/60 ml-auto">{count}</span>
                            {isHidden && <span className="text-muted-foreground/60 text-[10px]">hidden</span>}
                          </div>
                        )
                      })}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto legend-scroll" style={{ direction: "rtl" }}>
                  <div className="flex flex-col gap-0.5" style={{ direction: "ltr" }}>
                    {communities.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent/50"
                    >
                      <span
                        className="inline-block h-3 w-3 rounded-full shrink-0 shadow-sm"
                        style={{
                          backgroundColor: COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length],
                          boxShadow: `0 0 4px ${hexToRgba(COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length], 0.4)}`,
                        }}
                      />
                      <span className="text-muted-foreground truncate" title={c.topNodes.join(", ")}>
                        {c.topNodes[0] ?? `Cluster ${c.id}`}
                      </span>
                      <span className="text-muted-foreground/60 ml-auto shrink-0">{c.nodeCount}</span>
                      {c.cohesion < 0.15 && c.nodeCount >= 3 && (
                        <span className="text-amber-500 shrink-0" title={`Low cohesion: ${c.cohesion.toFixed(2)}`}>!</span>
                      )}
                    </div>
                  ))}
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        {/* Insights Side Panel */}
        {showInsights && (
          <div className="w-80 shrink-0 border-l bg-background overflow-y-auto">
            <div className="px-4 py-3 border-b">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-amber-500" />
                  <span className="text-sm font-medium">Insights</span>
                </div>
                <button
                  className="p-1 rounded hover:bg-muted text-muted-foreground"
                  onClick={() => {
                    setShowInsights(false)
                    setHighlightedNodes(new Set())
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="p-3 flex flex-col gap-4">
              {/* Surprising Connections */}
              {surprisingConns.filter((c) => !dismissedInsights.has(c.key)).length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-foreground">
                    <Link2 className="h-3.5 w-3.5 text-blue-500" />
                    Surprising Connections
                  </div>
                  <div className="flex flex-col gap-2">
                    {surprisingConns
                      .filter((conn) => !dismissedInsights.has(conn.key))
                      .map((conn, i) => {
                        const ids = new Set([conn.source.id, conn.target.id])
                        const isActive = highlightedNodes.size === ids.size &&
                          [...ids].every((id) => highlightedNodes.has(id))
                        return (
                          <div
                            key={i}
                            className={`rounded-lg border p-3 text-sm cursor-pointer transition-colors ${isActive ? "bg-blue-500/10 border-blue-500/40" : "hover:bg-muted/50"}`}
                            onClick={() => setHighlightedNodes(isActive ? new Set() : ids)}
                          >
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <span className="font-medium text-foreground text-xs">
                                {conn.source.label} ↔ {conn.target.label}
                              </span>
                              <button
                                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setDismissedInsights((prev) => new Set([...prev, conn.key]))
                                  if (isActive) setHighlightedNodes(new Set())
                                }}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {conn.reasons.join(", ")}
                            </p>
                          </div>
                        )
                      })}
                  </div>
                </div>
              )}

              {/* Knowledge Gaps */}
              {knowledgeGaps.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-foreground">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    Knowledge Gaps
                  </div>
                  <div className="flex flex-col gap-2">
                    {knowledgeGaps.map((gap, i) => {
                      const ids = new Set(gap.nodeIds)
                      const isActive = highlightedNodes.size > 0 &&
                        [...ids].every((id) => highlightedNodes.has(id)) &&
                        [...highlightedNodes].every((id) => ids.has(id))
                      return (
                        <div
                          key={i}
                          className={`rounded-lg border p-3 text-sm cursor-pointer transition-colors ${isActive ? "bg-amber-500/10 border-amber-500/40" : "hover:bg-muted/50"}`}
                          onClick={() => setHighlightedNodes(isActive ? new Set() : ids)}
                        >
                          <div className="font-medium text-xs text-foreground mb-1">{gap.title}</div>
                          <p className="text-xs text-muted-foreground mb-2">{gap.description}</p>
                          <p className="text-xs text-muted-foreground/80 italic mb-2">{gap.suggestion}</p>
                          <Button
                            variant="default"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleResearchClick(gap.title, gap.description, gap.type)
                            }}
                          >
                            <Search className="h-3.5 w-3.5" />
                            Deep Research
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Research Topic Confirmation Dialog */}
      {researchDialog && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[480px] rounded-lg border bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-primary" />
                <span className="font-medium text-sm">Deep Research</span>
              </div>
              {!researchDialog.loading && (
                <button
                  className="p-1 rounded hover:bg-muted text-muted-foreground"
                  onClick={() => setResearchDialog(null)}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {researchDialog.loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating research topic...
              </div>
            ) : (
              <div className="p-4">
                <div className="mb-3">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Research Topic</label>
                  <input
                    type="text"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    value={researchDialog.topic}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      setResearchDialog((prev) =>
                        prev ? { ...prev, topic: e.target.value } : prev
                      )
                    }
                  />
                </div>
                <div className="mb-4">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Search Queries</label>
                  <div className="flex flex-col gap-1.5">
                    {researchDialog.queries.map((q, idx) => (
                      <input
                        key={idx}
                        type="text"
                        className="w-full rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                        value={q}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          setResearchDialog((prev) => {
                            if (!prev) return prev
                            const newQueries = [...prev.queries]
                            newQueries[idx] = e.target.value
                            return { ...prev, queries: newQueries }
                          })
                        }
                      />
                    ))}
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setResearchDialog(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    className="gap-1"
                    onClick={handleResearchConfirm}
                  >
                    <Search className="h-3.5 w-3.5" />
                    Start Research
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  )
}
