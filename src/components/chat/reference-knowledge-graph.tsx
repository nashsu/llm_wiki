import { useEffect, useMemo, useState } from "react"
import Graph from "graphology"
import { SigmaContainer, useLoadGraph, useRegisterEvents, useSigma } from "@react-sigma/core"
import "@react-sigma/core/lib/style.css"
import type { MessageReference } from "@/stores/chat-store"

interface ReferenceKnowledgeGraphProps {
  references: MessageReference[]
  onOpenReference?: (reference: MessageReference) => void
}

interface ReferenceGraphData {
  nodes: Array<{ id: string; label: string; reference?: MessageReference; graphResult: boolean }>
  edges: Array<{ source: string; target: string }>
}

function buildReferenceGraph(references: MessageReference[]): ReferenceGraphData {
  const byTitle = new Map(references.map((reference) => [reference.title, reference]))
  const nodes = new Map<string, ReferenceGraphData["nodes"][number]>()
  const edges = new Map<string, ReferenceGraphData["edges"][number]>()

  for (const target of references) {
    if (target.source !== "Graph") continue
    const targetId = `reference:${target.path}`
    nodes.set(targetId, { id: targetId, label: target.title, reference: target, graphResult: true })
    for (const relatedTitle of target.graphRelations ?? []) {
      const source = byTitle.get(relatedTitle)
      const sourceId = source ? `reference:${source.path}` : `relation:${relatedTitle}`
      nodes.set(sourceId, {
        id: sourceId,
        label: relatedTitle,
        reference: source,
        graphResult: false,
      })
      const key = [sourceId, targetId].sort().join("\u0000")
      edges.set(key, { source: sourceId, target: targetId })
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

function ReferenceGraphLoader({ data }: { data: ReferenceGraphData }) {
  const loadGraph = useLoadGraph()

  useEffect(() => {
    const graph = new Graph({ type: "undirected" })
    const count = Math.max(data.nodes.length, 1)
    data.nodes.forEach((node, index) => {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2
      graph.addNode(node.id, {
        x: Math.cos(angle),
        y: Math.sin(angle),
        size: node.graphResult ? 11 : 8,
        color: node.graphResult ? "#2dd4bf" : "#60a5fa",
        label: node.label,
        forceLabel: true,
      })
    })
    data.edges.forEach((edge, index) => {
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) return
      graph.addEdgeWithKey(`reference-edge-${index}`, edge.source, edge.target, {
        color: "rgba(100,116,139,0.55)",
        size: 1.5,
      })
    })
    loadGraph(graph)
  }, [data, loadGraph])

  return null
}

function ReferenceGraphEvents({ data, onOpenReference }: ReferenceKnowledgeGraphProps & { data: ReferenceGraphData }) {
  const registerEvents = useRegisterEvents()
  const sigma = useSigma()
  const referencesByNode = useMemo(
    () => new Map(data.nodes.map((node) => [node.id, node.reference])),
    [data.nodes],
  )

  useEffect(() => {
    return registerEvents({
      enterNode: ({ event }) => {
        event.original.preventDefault()
        sigma.getContainer().style.cursor = "pointer"
      },
      leaveNode: () => {
        sigma.getContainer().style.cursor = "default"
      },
      clickNode: ({ node }) => {
        const reference = referencesByNode.get(node)
        if (reference) onOpenReference?.(reference)
      },
    })
  }, [onOpenReference, referencesByNode, registerEvents, sigma])

  useEffect(() => () => {
    sigma.getContainer().style.cursor = "default"
  }, [sigma])

  return null
}

export function ReferenceKnowledgeGraph({ references, onOpenReference }: ReferenceKnowledgeGraphProps) {
  const data = useMemo(() => buildReferenceGraph(references), [references])
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")))
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  if (data.nodes.length < 2 || data.edges.length === 0) return null

  return (
    <div className="mb-1.5 h-44 overflow-hidden border-b border-border/50 pb-1.5">
      <SigmaContainer
        key={dark ? "dark" : "light"}
        style={{ width: "100%", height: "100%", background: "transparent" }}
        settings={{
          defaultNodeType: "circle",
          renderEdgeLabels: false,
          hideEdgesOnMove: true,
          // Reference graphs are deliberately small. Keep labels visible while
          // dragging and zooming; the large-graph performance optimization used
          // by GraphView makes this compact graph appear to flicker.
          hideLabelsOnMove: false,
          labelColor: { color: dark ? "#f8fafc" : "#1e293b" },
          labelSize: 11,
          labelWeight: "600",
          stagePadding: 24,
          allowInvalidContainer: true,
        }}
      >
        <ReferenceGraphLoader data={data} />
        {onOpenReference && (
          <ReferenceGraphEvents data={data} references={references} onOpenReference={onOpenReference} />
        )}
      </SigmaContainer>
    </div>
  )
}
