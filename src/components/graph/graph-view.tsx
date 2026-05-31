import { useEffect, useCallback, useMemo, useState, useRef, type ChangeEvent } from "react"
import Graph from "graphology"
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSetSettings, useSigma } from "@react-sigma/core"
import "@react-sigma/core/lib/style.css"
import type { SigmaNodeEventPayload } from "sigma/types"
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
import { applyGraphFilters, DEFAULT_GRAPH_FILTERS, hasActiveGraphFilters, type GraphFilterState } from "@/lib/graph-filters"
import { applyGraphSearch } from "@/lib/graph-search"
import { wikiTypeLabel } from "@/lib/wiki-page-types"
import { useTranslation } from "react-i18next"

const NODE_TYPE_COLORS: Record<string, string> = {
  entity: "#60a5fa",    // blue-400
  concept: "#c084fc",   // purple-400
  source: "#fb923c",    // orange-400
  query: "#4ade80",     // green-400
  synthesis: "#f87171", // red-400
  overview: "#facc15",  // yellow-400
  comparison: "#2dd4bf", // teal-400
  finding: "#a855f7",    // purple-500
  thesis: "#f43f5e",     // rose-500
  methodology: "#14b8a6", // teal-500
  other: "#94a3b8",     // slate-400
}

const CUSTOM_NODE_COLORS = [
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#a78bfa",
  "#22d3ee",
  "#f97316",
  "#84cc16",
]

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

const BASE_NODE_SIZE = 8
const MAX_NODE_SIZE = 28
const DEFAULT_NODE_SCALE = 1
const DEFAULT_GRAPH_SPACING = 1
const GRAPH_SPACING_DEBOUNCE_MS = 180
const WORKER_LAYOUT_NODE_THRESHOLD = 220

type HoverState = { node: string; neighbors: Set<string> } | null

function nodeColor(type: string): string {
  if (NODE_TYPE_COLORS[type]) return NODE_TYPE_COLORS[type]
  let hash = 0
  for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return CUSTOM_NODE_COLORS[hash % CUSTOM_NODE_COLORS.length] ?? NODE_TYPE_COLORS.other
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

function graphDensityScale(nodeCount: number): number {
  if (nodeCount <= 150) return 1
  return Math.max(0.35, Math.sqrt(150 / nodeCount))
}

function nodeSize(linkCount: number, maxLinks: number, nodeCount: number, userScale: number): number {
  if (maxLinks === 0) return BASE_NODE_SIZE
  const ratio = linkCount / maxLinks
  const size = BASE_NODE_SIZE + Math.sqrt(ratio) * (MAX_NODE_SIZE - BASE_NODE_SIZE)
  return size * graphDensityScale(nodeCount) * userScale
}

function layoutIterations(nodeCount: number): number {
  if (nodeCount > 2500) return 28
  if (nodeCount > 1200) return 40
  if (nodeCount > 600) return 65
  if (nodeCount > 250) return 90
  return 140
}

function edgeVisibilityThreshold(nodeCount: number): number {
  if (nodeCount > 2500) return 0.16
  if (nodeCount > 1200) return 0.1
  if (nodeCount > 700) return 0.05
  return 0
}

function labelSizeThreshold(nodeCount: number): number {
  if (nodeCount > 2500) return 18
  if (nodeCount > 1200) return 14
  if (nodeCount > 600) return 10
  return 6
}

function labelDensity(nodeCount: number): number {
  if (nodeCount > 2500) return 0.08
  if (nodeCount > 1200) return 0.14
  if (nodeCount > 600) return 0.24
  return 0.4
}

function graphDataKey(nodes: readonly GraphNode[], edges: readonly GraphEdge[], graphSpacing: number): string {
  const nodeIds = nodes.map((n) => n.id).sort()
  const edgeIds = edges
    .map((e) => `${e.source}->${e.target}:${Math.round(e.weight * 1000)}`)
    .sort()
  return `${hashParts(nodeIds)}:${hashParts(edgeIds)}:${nodes.length}:${edges.length}:${graphSpacing.toFixed(2)}`
}

function hashParts(parts: readonly string[]): string {
  let hash = 2166136261
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 0xff
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function makeLayoutWorker(): Worker | null {
  try {
    return new Worker(new URL("./graph-layout-worker.ts", import.meta.url), { type: "module" })
  } catch (err) {
    console.warn("[Graph] failed to start layout worker; falling back to main-thread layout:", err)
    return null
  }
}

// --- Inner components ---

// Cache computed node positions so re-renders don't re-layout
const positionCache = new Map<string, { x: number; y: number }>()
let lastLayoutDataKey = ""
let pendingLayoutDataKey = ""

function GraphLoader({
  nodes,
  edges,
  colorMode,
  nodeScale,
  graphSpacing,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  colorMode: ColorMode
  nodeScale: number
  graphSpacing: number
}) {
  const loadGraph = useLoadGraph()
  const sigma = useSigma()

  useEffect(() => {
    const dataKey = graphDataKey(nodes, edges, graphSpacing)
    const needsLayout = dataKey !== lastLayoutDataKey && dataKey !== pendingLayoutDataKey
    let cancelled = false
    let worker: Worker | null = null

    const graph = new Graph()
    const maxLinks = Math.max(...nodes.map((n) => n.linkCount), 1)
    const weakEdgeThreshold = edgeVisibilityThreshold(nodes.length)

    for (const node of nodes) {
      const cached = positionCache.get(node.id)
      const color = colorMode === "community"
        ? COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length]
        : nodeColor(node.type)
      graph.addNode(node.id, {
        type: "circle",
        x: cached?.x ?? Math.random() * 100,
        y: cached?.y ?? Math.random() * 100,
        size: nodeSize(node.linkCount, maxLinks, nodes.length, nodeScale),
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
          const size = 0.5 + normalizedWeight * 3.5 // 0.5..4
          // Stronger relationships → darker color
          const alpha = Math.round(40 + normalizedWeight * 180) // 40..220
          const color = `rgba(100,116,139,${alpha / 255})` // slate-500 with variable opacity
          graph.addEdgeWithKey(edgeKey, edge.source, edge.target, {
            color,
            size,
            weight: edge.weight,
            normalizedWeight,
            sourceNode: edge.source,
            targetNode: edge.target,
            lowPriority: weakEdgeThreshold > 0 && normalizedWeight < weakEdgeThreshold,
          })
        }
      }
    }

    const runMainThreadLayout = () => {
      const settings = forceAtlas2.inferSettings(graph)
      forceAtlas2.assign(graph, {
        iterations: layoutIterations(nodes.length),
        settings: {
          ...settings,
          gravity: 1,
          scalingRatio: graphSpacing * (nodes.length > 400 ? 3 : 2),
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

    // Only run expensive ForceAtlas2 layout when data actually changed.
    // Large graphs are laid out in a Web Worker so the UI remains
    // responsive while coordinates settle.
    if (needsLayout && nodes.length > 1 && nodes.length < WORKER_LAYOUT_NODE_THRESHOLD) {
      runMainThreadLayout()
    }

    loadGraph(graph)

    if (needsLayout && nodes.length >= WORKER_LAYOUT_NODE_THRESHOLD) {
      worker = makeLayoutWorker()
      if (!worker) {
        runMainThreadLayout()
        loadGraph(graph)
        return undefined
      }
      pendingLayoutDataKey = dataKey

      worker.onmessage = (event: MessageEvent<{ key: string; positions: Array<{ id: string; x: number; y: number }> }>) => {
        if (cancelled || event.data.key !== dataKey) return
        for (const { id, x, y } of event.data.positions) {
          if (!graph.hasNode(id)) continue
          graph.setNodeAttribute(id, "x", x)
          graph.setNodeAttribute(id, "y", y)
          positionCache.set(id, { x, y })
        }
        lastLayoutDataKey = dataKey
        if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = ""
        sigma.refresh()
      }
      worker.onerror = (event) => {
        if (cancelled) return
        console.warn("[Graph] layout worker failed; falling back to main-thread layout:", event.message)
        if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = ""
        runMainThreadLayout()
        loadGraph(graph)
      }
      worker.postMessage({
        key: dataKey,
        nodes: nodes.map((node) => {
          const cached = positionCache.get(node.id)
          return {
            id: node.id,
            x: cached?.x ?? graph.getNodeAttribute(node.id, "x"),
            y: cached?.y ?? graph.getNodeAttribute(node.id, "y"),
          }
        }),
        edges: edges.map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight })),
        iterations: layoutIterations(nodes.length),
        scalingRatio: graphSpacing * (nodes.length > 400 ? 3 : 2),
      })
    }

    return () => {
      cancelled = true
      if (pendingLayoutDataKey === dataKey) pendingLayoutDataKey = ""
      worker?.terminate()
    }
  }, [loadGraph, sigma, nodes, edges, colorMode, nodeScale, graphSpacing])

  return null
}

function GraphRenderSettings({
  hoverState,
  highlightedNodes,
  nodeCount,
}: {
  hoverState: HoverState
  highlightedNodes: Set<string>
  nodeCount: number
}) {
  const sigma = useSigma()
  const setSettings = useSetSettings()

  useEffect(() => {
    setSettings({
      hideEdgesOnMove: true,
      hideLabelsOnMove: true,
      labelDensity: labelDensity(nodeCount),
      labelRenderedSizeThreshold: labelSizeThreshold(nodeCount),
      renderEdgeLabels: false,
      nodeReducer: (node, attrs) => {
        const result = { ...attrs }
        const hasHover = !!hoverState
        const hasHighlight = highlightedNodes.size > 0
        const isHoverNode = hoverState?.node === node
        const isHoverNeighbor = hoverState?.neighbors.has(node) ?? false
        const isHighlighted = highlightedNodes.has(node)

        if (isHighlighted) {
          result.size = (attrs.size ?? BASE_NODE_SIZE) * 1.5
          result.zIndex = 10
          result.forceLabel = true
        }
        if (isHoverNode) {
          result.size = (attrs.size ?? BASE_NODE_SIZE) * 1.4
          result.zIndex = 10
          result.forceLabel = true
        }
        if ((hasHover && !isHoverNode && !isHoverNeighbor) || (hasHighlight && !isHighlighted)) {
          result.color = mixColor(attrs.color ?? "#94a3b8", "#e2e8f0", 0.75)
          result.label = ""
          result.size = (attrs.size ?? BASE_NODE_SIZE) * 0.6
        }
        return result
      },
      edgeReducer: (_edge, attrs) => {
        const result = { ...attrs }
        const source = String(attrs.sourceNode ?? "")
        const target = String(attrs.targetNode ?? "")
        const hasHover = !!hoverState
        const hasHighlight = highlightedNodes.size > 0
        const hoverEdge = hasHover && (source === hoverState?.node || target === hoverState?.node)
        const highlightedEdge = hasHighlight && highlightedNodes.has(source) && highlightedNodes.has(target)

        if (attrs.lowPriority && !hoverEdge && !highlightedEdge) {
          result.hidden = true
          return result
        }
        if ((hasHover && !hoverEdge) || (hasHighlight && !highlightedEdge)) {
          result.color = "#f1f5f9"
          result.size = 0.3
        }
        if (hoverEdge || highlightedEdge) {
          result.color = "#1e293b"
          result.size = Math.max(2, (attrs.size ?? 1) * 1.5)
        }
        return result
      },
    })
    sigma.refresh()
  }, [setSettings, sigma, hoverState, highlightedNodes, nodeCount])

  return null
}

function EventHandler({
  onNodeClick,
  onNodeContextMenu,
  onHoverChange,
}: {
  onNodeClick: (nodeId: string) => void
  onNodeContextMenu: (nodeId: string, x: number, y: number) => void
  onHoverChange: (state: HoverState) => void
}) {
  const registerEvents = useRegisterEvents()
  const sigma = useSigma()

  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => onNodeClick(node),
      rightClickNode: (payload: SigmaNodeEventPayload) => {
        payload.preventSigmaDefault()
        payload.event.original.preventDefault()
        const point = clientPointFromEvent(payload.event.original)
        onNodeContextMenu(nodeIdFromPayload(payload), point.x, point.y)
      },
      rightClickStage: () => onNodeContextMenu("", 0, 0),
      enterNode: ({ node }) => {
        const container = sigma.getContainer()
        container.style.cursor = "pointer"
        const graph = sigma.getGraph()
        onHoverChange({ node, neighbors: new Set(graph.neighbors(node)) })
      },
      leaveNode: () => {
        const container = sigma.getContainer()
        container.style.cursor = "default"
        onHoverChange(null)
      },
    })
  }, [registerEvents, sigma, onNodeClick, onNodeContextMenu, onHoverChange])

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
  const { t } = useTranslation()
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
  const [hoverState, setHoverState] = useState<HoverState>(null)
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(new Set())
  const [sigmaKey, setSigmaKey] = useState(0)
  const [isResizing, setIsResizing] = useState(false)
  const [legendCollapsed, setLegendCollapsed] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [graphSearchOpen, setGraphSearchOpen] = useState(false)
  const [graphSearch, setGraphSearch] = useState("")
  const [nodeScale, setNodeScale] = useState(DEFAULT_NODE_SCALE)
  const [graphSpacingDraft, setGraphSpacingDraft] = useState(DEFAULT_GRAPH_SPACING)
  const [graphSpacing, setGraphSpacing] = useState(DEFAULT_GRAPH_SPACING)
  const [filters, setFilters] = useState<GraphFilterState>(() => ({
    ...DEFAULT_GRAPH_FILTERS,
    hiddenTypes: new Set(),
    hiddenNodeIds: new Set(),
  }))
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const graphContainerRef = useRef<HTMLDivElement>(null)
  const researchDialogTokenRef = useRef(0)
  // i18n node type labels (populated after mount to support language switching)
  const [nodeTypeLabels, setNodeTypeLabels] = useState<Record<string, string>>({})
  const graphSearchInputRef = useRef<HTMLInputElement>(null)

  // Research confirmation dialog
  const [researchDialog, setResearchDialog] = useState<{
    loading: boolean
    topic: string
    queries: string[]
    dismissKey?: string
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

  // Initialize node type labels when i18n is ready
  useEffect(() => {
    setNodeTypeLabels({
      entity: t("graph.nodeTypeLabels.entity"),
      concept: t("graph.nodeTypeLabels.concept"),
      source: t("graph.nodeTypeLabels.source"),
      query: t("graph.nodeTypeLabels.query"),
      synthesis: t("graph.nodeTypeLabels.synthesis"),
      overview: t("graph.nodeTypeLabels.overview"),
      comparison: t("graph.nodeTypeLabels.comparison"),
      finding: t("graph.nodeTypeLabels.finding"),
      thesis: t("graph.nodeTypeLabels.thesis"),
      methodology: t("graph.nodeTypeLabels.methodology"),
      other: t("graph.nodeTypeLabels.other"),
    })
  }, [t])

  // Spacing changes trigger ForceAtlas2 layout through GraphLoader's dataKey.
  // Keep the slider responsive while debouncing the expensive relayout.
  useEffect(() => {
    const timer = window.setTimeout(() => setGraphSpacing(graphSpacingDraft), GRAPH_SPACING_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [graphSpacingDraft])

  useEffect(() => {
    if (dataVersion !== lastLoadedVersion.current) {
      loadGraph()
    }
  }, [loadGraph, dataVersion])

  useEffect(() => {
    if (!graphSearchOpen) return
    const id = window.requestAnimationFrame(() => graphSearchInputRef.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [graphSearchOpen])

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
    setFilters({
      ...DEFAULT_GRAPH_FILTERS,
      hiddenTypes: new Set(),
      hiddenNodeIds: new Set(),
    })
    setNodeScale(DEFAULT_NODE_SCALE)
    setGraphSpacingDraft(DEFAULT_GRAPH_SPACING)
    setGraphSpacing(DEFAULT_GRAPH_SPACING)
    setNodeMenu(null)
  }, [])

  const knowledgeGapKey = useCallback((gap: KnowledgeGap) => (
    `gap:${gap.type}:${gap.title}:${gap.nodeIds.join(",")}`
  ), [])

  const visibleKnowledgeGaps = useMemo(
    () => knowledgeGaps.filter((gap) => !dismissedInsights.has(knowledgeGapKey(gap))),
    [dismissedInsights, knowledgeGaps, knowledgeGapKey],
  )

  const dismissInsight = useCallback((key: string, ids?: Set<string>) => {
    setDismissedInsights((prev) => new Set([...prev, key]))
    if (ids && highlightedNodes.size === ids.size && [...ids].every((id) => highlightedNodes.has(id))) {
      setHighlightedNodes(new Set())
    }
  }, [highlightedNodes])

  const handleResearchClick = useCallback(async (gapTitle: string, gapDescription: string, gapType: string, dismissKey?: string) => {
    const store = useWikiStore.getState()
    if (!store.project) return
    const pp = normalizePath(store.project.path)
    const token = researchDialogTokenRef.current + 1
    researchDialogTokenRef.current = token

    // Show loading state
    setResearchDialog({ loading: true, topic: "", queries: [], dismissKey })

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
      if (researchDialogTokenRef.current !== token) return
      setResearchDialog({ loading: false, topic: result.topic, queries: result.searchQueries, dismissKey })
    } catch {
      if (researchDialogTokenRef.current !== token) return
      // Fallback: use raw title
      setResearchDialog({ loading: false, topic: gapTitle, queries: [gapTitle], dismissKey })
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
    if (researchDialog.dismissKey) {
      setDismissedInsights((prev) => new Set([...prev, researchDialog.dismissKey!]))
      setHighlightedNodes(new Set())
    }
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

  // Count nodes by type for legend
  const typeCounts = nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.type] = (acc[n.type] ?? 0) + 1
    return acc
  }, {})
  const nodeTypeLabelMap = useMemo(() => {
    const labels = { ...nodeTypeLabels }
    for (const type of Object.keys(typeCounts)) {
      labels[type] ??= wikiTypeLabel(type)
    }
    return labels
  }, [nodeTypeLabels, typeCounts])

  const filteredGraph = useMemo(
    () => applyGraphFilters(nodes, edges, filters),
    [nodes, edges, filters],
  )
  const searchedGraph = useMemo(
    () => applyGraphSearch(filteredGraph.nodes, filteredGraph.edges, graphSearch),
    [filteredGraph.nodes, filteredGraph.edges, graphSearch],
  )
  const searchActive = graphSearch.trim().length > 0
  const hiddenCount = nodes.length - filteredGraph.nodes.length
  const filtersActive = hasActiveGraphFilters(filters)
  const contextNode = nodeMenu ? nodes.find((node) => node.id === nodeMenu.nodeId) : null

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm">{t("graph.openProject")}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <RefreshCw className="h-8 w-8 animate-spin opacity-50" />
        <p className="text-sm">{t("graph.buildingGraph")}</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={loadGraph}>{t("graph.retry")}</Button>
      </div>
    )
  }

  if (!loading && nodes.length === 0 && !error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Network className="h-10 w-10 opacity-30" />
        <p className="text-sm">{t("graph.noPages")}</p>
        <p className="text-xs">{t("graph.importSourcesHint")}</p>
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
            <span className="text-sm font-medium">{t("graph.knowledgeGraph")}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">{searchedGraph.nodes.length}/{nodes.length} {t("graph.pages", { count: nodes.length })}</span>
            <span className="rounded bg-muted px-1.5 py-0.5">{searchedGraph.edges.length}/{edges.length} {t("graph.links", { count: edges.length })}</span>
            {hiddenCount > 0 && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                {hiddenCount} {t("graph.hidden")}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {graphSearchOpen || searchActive ? (
            <div className="relative mr-1 w-52">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={graphSearchInputRef}
                value={graphSearch}
                onChange={(e) => setGraphSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setGraphSearch("")
                    setGraphSearchOpen(false)
                  }
                }}
                className="h-7 w-full rounded-md border bg-background pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
                placeholder={t("graph.searchPlaceholder")}
                aria-label={t("graph.searchLabel")}
              />
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => {
                  if (searchActive) {
                    setGraphSearch("")
                    return
                  }
                  setGraphSearchOpen(false)
                }}
                aria-label={searchActive ? t("graph.clearSearch") : t("graph.closeSearch")}
                title={searchActive ? t("graph.clearSearch") : t("graph.closeSearch")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setGraphSearchOpen(true)}
              className="text-xs gap-1 h-7"
              aria-label={t("graph.searchLabel")}
              title={t("graph.searchLabel")}
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant={showFilters ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowFilters((v) => !v)}
            className="text-xs gap-1 h-7"
          >
            <Filter className="h-3 w-3" />
            {t("graph.filter")}
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
              {t("graph.reset")}
            </Button>
          )}
          <Button
            variant={colorMode === "type" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setColorMode("type")}
            className="text-xs gap-1 h-7"
          >
            <Tag className="h-3 w-3" />
            {t("graph.type")}
          </Button>
          <Button
            variant={colorMode === "community" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setColorMode("community")}
            className="text-xs gap-1 h-7"
          >
            <Layers className="h-3 w-3" />
            {t("graph.community")}
          </Button>
          {(surprisingConns.filter((c) => !dismissedInsights.has(c.key)).length > 0 || visibleKnowledgeGaps.length > 0) && (
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
              {t("graph.insights")}
              <span className="rounded bg-muted px-1 text-[10px]">
                {surprisingConns.filter((c) => !dismissedInsights.has(c.key)).length + visibleKnowledgeGaps.length}
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
          className="relative flex-1 min-w-0 overflow-hidden bg-slate-50 dark:bg-slate-950"
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => setNodeMenu(null)}
        >
          {isResizing ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {t("graph.resizing")}
            </div>
          ) : (
            <>
              <ErrorBoundary>
                <SigmaContainer
                  key={sigmaKey}
                  style={{ width: "100%", height: "100%", background: "transparent" }}
                  settings={{
                    defaultNodeType: "circle",
                    renderEdgeLabels: false,
                    hideEdgesOnMove: true,
                    hideLabelsOnMove: true,
                    defaultEdgeColor: "#cbd5e1",
                    defaultNodeColor: "#94a3b8",
                    labelSize: 13,
                    labelWeight: "bold",
                    labelColor: { color: "#1e293b" },
                    stagePadding: 30,
                  }}
                >
                  <GraphLoader
                    nodes={searchedGraph.nodes}
                    edges={searchedGraph.edges}
                    colorMode={colorMode}
                    nodeScale={nodeScale}
                    graphSpacing={graphSpacing}
                  />
                  <EventHandler
                    onNodeClick={handleNodeClick}
                    onNodeContextMenu={handleNodeContextMenu}
                    onHoverChange={setHoverState}
                  />
                  <GraphRenderSettings
                    hoverState={hoverState}
                    highlightedNodes={searchActive ? searchedGraph.matchedNodeIds : highlightedNodes}
                    nodeCount={searchedGraph.nodes.length}
                  />
                  <ZoomControls />
                </SigmaContainer>
              </ErrorBoundary>

              {searchedGraph.nodes.length === 0 && (
                <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-slate-50/85 text-muted-foreground backdrop-blur-[1px] dark:bg-slate-950/85">
                  <Search className="h-8 w-8 opacity-40" />
                  <p className="text-sm">{searchActive ? t("graph.noSearchResults") : t("graph.noVisibleNodes")}</p>
                  {searchActive && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="pointer-events-auto"
                      onClick={() => setGraphSearch("")}
                    >
                      {t("graph.clearSearch")}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {showFilters && (
            <div className="absolute top-3 left-3 w-72 rounded-lg border bg-background/95 p-3 text-xs shadow-lg backdrop-blur-sm">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Filter className="h-3.5 w-3.5" />
                  {t("graph.graphFilters")}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[10px]"
                  onClick={resetFilters}
                >
                  {t("graph.reset")}
                </Button>
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">{t("graph.quickFilters")}</div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={filters.hideStructural}
                      onChange={(e) => setFilters((prev) => ({ ...prev, hideStructural: e.target.checked }))}
                    />
                    <span>{t("graph.hideIndexOverview")}</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={filters.hideIsolated}
                      onChange={(e) => setFilters((prev) => ({ ...prev, hideIsolated: e.target.checked }))}
                    />
                    <span>{t("graph.hideIsolated")}</span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">{t("graph.maxLinks")}</div>
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
                    <span className="text-muted-foreground">{t("graph.maxLinksHint")}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="font-medium text-muted-foreground">{t("graph.displayTuning")}</div>
                  <label className="block space-y-1">
                    <div className="flex items-center justify-between">
                      <span>{t("graph.nodeSize")}</span>
                      <span className="text-muted-foreground">{Math.round(nodeScale * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.5}
                      max={1.5}
                      step={0.05}
                      value={nodeScale}
                      onChange={(e) => setNodeScale(Number(e.target.value))}
                      className="w-full"
                    />
                  </label>
                  <label className="block space-y-1">
                    <div className="flex items-center justify-between">
                      <span>{t("graph.spacing")}</span>
                      <span className="text-muted-foreground">{Math.round(graphSpacingDraft * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.6}
                      max={2.2}
                      step={0.05}
                      value={graphSpacingDraft}
                      onChange={(e) => setGraphSpacingDraft(Number(e.target.value))}
                      className="w-full"
                    />
                  </label>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t("graph.displayTuningHint")}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="font-medium text-muted-foreground">{t("graph.nodeTypes")}</div>
                  <div className="grid grid-cols-2 gap-1">
                    {Object.entries(nodeTypeLabelMap)
                      .filter(([type]) => (typeCounts[type] ?? 0) > 0)
                      .map(([type, label]) => (
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
                          <span className="text-muted-foreground/60">{typeCounts[type]}</span>
                        </label>
                      ))}
                  </div>
                </div>

                {filters.hiddenNodeIds.size > 0 && (
                  <div className="space-y-1.5">
                    <div className="font-medium text-muted-foreground">{t("graph.hiddenNodes")}</div>
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
                              {t("graph.show")}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="rounded bg-muted/50 px-2 py-1.5 text-muted-foreground">
                  {t("graph.showingStats", { pages: filteredGraph.nodes.length, total: nodes.length, links: filteredGraph.edges.length, totalLinks: edges.length })}
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
                {t("graph.hideThisNode")}
              </button>
            </div>
          )}

          {/* Legend */}
          <div className="absolute bottom-3 left-3 rounded-lg border bg-background/90 backdrop-blur-sm px-3 py-2 text-xs shadow-sm max-w-[260px]">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-semibold text-foreground">
                {colorMode === "type" ? t("graph.nodeTypesLabel") : t("graph.communitiesLabel")}
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
                    {t("graph.showAll")}
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
                    {Object.entries(nodeTypeLabelMap)
                      .filter(([type]) => (typeCounts[type] ?? 0) > 0)
                      .map(([type, label]) => {
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
                                backgroundColor: isHidden ? "#94a3b8" : nodeColor(type),
                                boxShadow: `0 0 4px ${hexToRgba(isHidden ? "#94a3b8" : nodeColor(type), 0.4)}`,
                              }}
                            />
                            <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                              {label}
                            </span>
                            <span className="text-muted-foreground/60 ml-auto">{typeCounts[type]}</span>
                            {isHidden && <span className="text-muted-foreground/60 text-[10px]">{t("graph.hidden")}</span>}
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
                        {c.topNodes[0] ?? `${t("graph.cluster", { id: c.id })}`}
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
                  <span className="text-sm font-medium">{t("graph.insights")}</span>
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
                    {t("graph.surprisingConnections")}
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
                                  dismissInsight(conn.key, ids)
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
              {visibleKnowledgeGaps.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-foreground">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    {t("graph.knowledgeGaps")}
                  </div>
                  <div className="flex flex-col gap-2">
                    {visibleKnowledgeGaps.map((gap, i) => {
                      const gapKey = knowledgeGapKey(gap)
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
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <div className="font-medium text-xs text-foreground">{gap.title}</div>
                            <button
                              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                              title={t("common.dismiss")}
                              onClick={(e) => {
                                e.stopPropagation()
                                dismissInsight(gapKey, ids)
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <p className="text-xs text-muted-foreground mb-2">{gap.description}</p>
                          <p className="text-xs text-muted-foreground/80 italic mb-2">{gap.suggestion}</p>
                          <Button
                            variant="default"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleResearchClick(gap.title, gap.description, gap.type, gapKey)
                            }}
                          >
                            <Search className="h-3.5 w-3.5" />
                            {t("graph.deepResearch")}
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
                <span className="font-medium text-sm">{t("graph.deepResearch")}</span>
              </div>
              <button
                className="p-1 rounded hover:bg-muted text-muted-foreground"
                onClick={() => {
                  researchDialogTokenRef.current += 1
                  setResearchDialog(null)
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {researchDialog.loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("graph.generatingTopic")}
              </div>
            ) : (
              <div className="p-4">
                <div className="mb-3">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{t("graph.researchTopic")}</label>
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
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{t("graph.searchQueries")}</label>
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      researchDialogTokenRef.current += 1
                      setResearchDialog(null)
                    }}
                  >
                    {t("graph.cancel")}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    className="gap-1"
                    onClick={handleResearchConfirm}
                  >
                    <Search className="h-3.5 w-3.5" />
                    {t("graph.startResearch")}
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
