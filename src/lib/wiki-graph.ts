import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { buildRetrievalGraph, calculateRelevance } from "./graph-relevance"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { detectCommunities } from "./wiki-graph-analysis"

export interface GraphNode {
  id: string
  label: string
  type: string
  path: string
  linkCount: number // inbound + outbound
  community: number // community id from Louvain detection
}

export interface GraphEdge {
  source: string
  target: string
  weight: number // relevance score between source and target
}

export interface CommunityInfo {
  id: number
  nodeCount: number
  cohesion: number // intra-community edge density
  topNodes: string[] // top nodes by linkCount (labels)
}

export interface WikiGraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  communities: CommunityInfo[]
}

const GRAPH_FILE_READ_CONCURRENCY = 16
const MAX_WEIGHTED_GRAPH_NODES = 3_000
const COMMUNITY_WORKER_THRESHOLD = 3_000
const MAX_CACHED_PROJECT_GRAPHS = 2
const graphCache = new Map<string, { dataVersion: number; result: WikiGraphResult }>()
const graphBuilds = new Map<string, Promise<WikiGraphResult>>()

async function analyzeCommunities(
  nodes: { id: string; label: string; linkCount: number }[],
  edges: GraphEdge[],
): Promise<{ assignments: Map<string, number>; communities: CommunityInfo[] }> {
  if (nodes.length < COMMUNITY_WORKER_THRESHOLD || typeof Worker === "undefined") {
    return detectCommunities(nodes, edges)
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./wiki-graph-analysis.worker.ts", import.meta.url),
      { type: "module" },
    )
    worker.onmessage = (event: MessageEvent<{
      assignments: [string, number][]
      communities: CommunityInfo[]
    }>) => {
      worker.terminate()
      resolve({
        assignments: new Map(event.data.assignments),
        communities: event.data.communities,
      })
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || "Knowledge graph analysis worker failed"))
    }
    worker.postMessage({ nodes, edges })
  })
}

const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractTitle(content: string, fileName: string): string {
  const title = parseFrontmatter(content).frontmatter?.title
  if (typeof title === "string" && title.trim()) return title.trim()

  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

function extractType(content: string): string {
  const type = parseFrontmatter(content).frontmatter?.type
  if (typeof type === "string" && type.trim()) return type.trim().toLowerCase()
  return "other"
}

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = new RegExp(WIKILINK_REGEX.source, "g")
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function fileNameToId(fileName: string): string {
  return fileName.replace(/\.md$/, "")
}

function targetAliases(value: string): string[] {
  const lower = value.toLowerCase()
  return [value, lower, lower.replace(/\s+/g, "-")]
}

function buildTargetIndex(nodeIds: Iterable<string>): Map<string, string> {
  const ids = Array.from(nodeIds)
  const index = new Map<string, string>()
  // Exact IDs must win over case-folded aliases. On a case-sensitive
  // filesystem, Foo.md and foo.md are distinct pages and [[foo]] must retain
  // the reader's exact-match behavior.
  for (const id of ids) index.set(id, id)
  for (const id of ids) {
    for (const alias of targetAliases(id).slice(1)) {
      if (!index.has(alias)) index.set(alias, id)
    }
  }
  return index
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor
        cursor += 1
        results[index] = await mapper(values[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

export async function buildWikiGraph(
  projectPath: string,
  dataVersion?: number,
): Promise<WikiGraphResult> {
  const normalizedProjectPath = normalizePath(projectPath)
  if (dataVersion !== undefined) {
    const cached = graphCache.get(normalizedProjectPath)
    if (cached?.dataVersion === dataVersion) return cached.result
  }

  const buildKey = `${normalizedProjectPath}\u0000${dataVersion ?? "uncached"}`
  const pending = graphBuilds.get(buildKey)
  if (pending) return pending
  const build = buildWikiGraphUncached(normalizedProjectPath)
  graphBuilds.set(buildKey, build)
  let result: WikiGraphResult
  try {
    result = await build
  } finally {
    graphBuilds.delete(buildKey)
  }
  if (dataVersion !== undefined) {
    const cached = graphCache.get(normalizedProjectPath)
    // An older build may finish after a newer dataVersion. Never let it
    // replace the newer cached graph.
    if (!cached || cached.dataVersion <= dataVersion) {
      if (!cached && graphCache.size >= MAX_CACHED_PROJECT_GRAPHS) {
        const oldestProject = graphCache.keys().next().value
        if (oldestProject) graphCache.delete(oldestProject)
      }
      graphCache.set(normalizedProjectPath, { dataVersion, result })
    }
  }
  return result
}

async function buildWikiGraphUncached(projectPath: string): Promise<WikiGraphResult> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`

  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return { nodes: [], edges: [], communities: [] }
  }

  const mdFiles = flattenMdFiles(tree)
  if (mdFiles.length === 0) {
    return { nodes: [], edges: [], communities: [] }
  }

  // Build a map of id -> node data
  const nodeMap = new Map<
    string,
    { id: string; label: string; type: string; path: string; links: string[] }
  >()

  const parsedFiles = await mapWithConcurrency(
    mdFiles,
    GRAPH_FILE_READ_CONCURRENCY,
    async (file) => {
      try {
        const content = await readFile(file.path)
        const id = fileNameToId(file.name)
        return {
          id,
          label: extractTitle(content, file.name),
          type: extractType(content),
          path: file.path,
          links: extractWikilinks(content),
        }
      } catch {
        return null
      }
    },
  )
  for (const parsed of parsedFiles) {
    if (parsed) nodeMap.set(parsed.id, parsed)
  }

  // Filter out query nodes (research results, saved chat answers) — they are
  // intermediate artifacts, not knowledge structure. The entities/concepts
  // extracted from them via auto-ingest are what belong in the graph.
  const HIDDEN_TYPES = new Set(["query"])
  for (const [id, node] of nodeMap) {
    if (HIDDEN_TYPES.has(node.type)) {
      nodeMap.delete(id)
    }
  }

  // Count link references
  const linkCounts = new Map<string, number>()
  for (const [id] of nodeMap) {
    linkCounts.set(id, 0)
  }

  const rawEdges: GraphEdge[] = []
  const targetIndex = buildTargetIndex(nodeMap.keys())

  for (const [sourceId, nodeData] of nodeMap) {
    for (const targetRaw of nodeData.links) {
      // Normalize target: try matching by id (case-insensitive, hyphen/space)
      const targetId = resolveTarget(targetRaw, targetIndex)
      if (targetId === null) continue
      if (targetId === sourceId) continue

      rawEdges.push({ source: sourceId, target: targetId, weight: 1 })

      linkCounts.set(sourceId, (linkCounts.get(sourceId) ?? 0) + 1)
      linkCounts.set(targetId, (linkCounts.get(targetId) ?? 0) + 1)
    }
  }

  // Deduplicate edges
  const seenEdges = new Set<string>()
  const dedupedEdges: { source: string; target: string }[] = []
  for (const edge of rawEdges) {
    const key = `${edge.source}:::${edge.target}`
    const reverseKey = `${edge.target}:::${edge.source}`
    if (!seenEdges.has(key) && !seenEdges.has(reverseKey)) {
      seenEdges.add(key)
      dedupedEdges.push(edge)
    }
  }

  // Calculate relevance weights using the retrieval graph
  let retrievalGraph: Awaited<ReturnType<typeof buildRetrievalGraph>> | null = null
  if (nodeMap.size <= MAX_WEIGHTED_GRAPH_NODES) {
    try {
      const { useWikiStore } = await import("@/stores/wiki-store")
      const dv = useWikiStore.getState().dataVersion
      retrievalGraph = await buildRetrievalGraph(normalizePath(projectPath), dv)
    } catch {
      // ignore — weights will default to 1
    }
  }

  const edges: GraphEdge[] = dedupedEdges.map((e) => {
    let weight = 1
    if (retrievalGraph) {
      const nodeA = retrievalGraph.nodes.get(e.source)
      const nodeB = retrievalGraph.nodes.get(e.target)
      if (nodeA && nodeB) {
        weight = calculateRelevance(nodeA, nodeB, retrievalGraph)
      }
    }
    return { source: e.source, target: e.target, weight }
  })

  // Build preliminary nodes for community detection
  const prelimNodes = Array.from(nodeMap.values()).map((n) => ({
    id: n.id,
    label: n.label,
    linkCount: linkCounts.get(n.id) ?? 0,
  }))

  const { assignments, communities } = await analyzeCommunities(prelimNodes, edges).catch(
    () => detectCommunities(prelimNodes, edges),
  )

  const nodes: GraphNode[] = Array.from(nodeMap.values()).map((n) => ({
    id: n.id,
    label: n.label,
    type: n.type,
    path: n.path,
    linkCount: linkCounts.get(n.id) ?? 0,
    community: assignments.get(n.id) ?? 0,
  }))

  return { nodes, edges, communities }
}

function resolveTarget(
  raw: string,
  targetIndex: ReadonlyMap<string, string>,
): string | null {
  for (const alias of targetAliases(raw)) {
    const target = targetIndex.get(alias)
    if (target) return target
  }
  return null
}
