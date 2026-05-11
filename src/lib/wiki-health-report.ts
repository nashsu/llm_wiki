import { createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import { parseGraphPage } from "@/lib/graph-relations"
import { normalizePath } from "@/lib/path-utils"
import type { MaintenanceQueue } from "@/lib/maintenance-queue"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { inferStateFromQuality } from "@/lib/wiki-metadata"
import type { FileNode } from "@/types/wiki"

export const LOG_RETENTION_POLICY = {
  keepRecentDays: 30,
  keepRecentEntries: 50,
  archivePathPattern: ".llm-wiki/log-archive/YYYY-MM.md",
} as const

const PAGE_TYPES = ["source", "entity", "concept", "query", "comparison", "synthesis", "overview", "index", "log", "other"] as const
const STATES = ["seed", "draft", "active", "canonical", "deprecated", "archived", "missing"] as const
const QUALITIES = ["seed", "draft", "reviewed", "canonical", "missing"] as const
const QUERY_RETENTIONS = ["ephemeral", "reusable", "promote", "archive", "missing"] as const

type CountKey = typeof PAGE_TYPES[number] | typeof STATES[number] | typeof QUALITIES[number] | typeof QUERY_RETENTIONS[number] | string

export interface HealthWikiPage {
  path: string
  name: string
  content: string
}

export interface WikiHealthReport {
  schemaVersion: 1
  generatedAt: string
  totals: {
    wikiPages: number
    graphNodes: number
    graphEdges: number
  }
  counts: {
    pageTypes: Record<string, number>
    states: Record<string, number>
    qualities: Record<string, number>
    queryRetentions: Record<string, number>
    maintenance: Record<string, number>
  }
  qualitySignals: {
    needsUpgradeTrue: number
    weakEvidence: number
    sourceTraceMissing: number
    orphanCandidates: number
    duplicateCandidates: number
  }
  index: {
    linkedPages: number
    indexableMissing: number
    ephemeralQueryLinks: number
    indexableMissingExamples: string[]
    ephemeralQueryLinkExamples: string[]
  }
  log: {
    entryCount: number
    byteLength: number
    oldestEntryDate: string | null
    rolloverNeeded: boolean
    policy: typeof LOG_RETENTION_POLICY
  }
}

interface ParsedHealthPage {
  path: string
  content: string
  title: string
  type: string
  state?: string
  quality?: string
  evidenceStrength?: string
  reviewStatus?: string
  retention?: string
  sources: string[]
  wikilinks: string[]
}

export function buildWikiHealthReport(args: {
  pages: readonly HealthWikiPage[]
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  maintenanceQueue: MaintenanceQueue
  now?: Date
}): WikiHealthReport {
  const now = args.now ?? new Date()
  const parsedPages = args.pages.map(parseHealthPage)
  const byAlias = buildAliasMap(parsedPages)
  const indexPage = parsedPages.find((page) => normalizeWikiPath(page.path).endsWith("wiki/index.md"))
  const logPage = parsedPages.find((page) => normalizeWikiPath(page.path).endsWith("wiki/log.md"))
  const indexLinks = new Set(indexPage?.wikilinks.map(normalizeAlias) ?? [])
  const linkedPageIds = new Set<string>()
  const ephemeralQueryLinkExamples: string[] = []
  let ephemeralQueryLinks = 0

  for (const link of indexLinks) {
    const page = byAlias.get(link)
    if (!page) continue
    linkedPageIds.add(pageKey(page))
    if (isEphemeralQuery(page)) {
      ephemeralQueryLinks += 1
      ephemeralQueryLinkExamples.push(formatPageExample(page))
    }
  }

  const indexableMissingPages = parsedPages
    .filter(isHumanIndexPage)
    .filter((page) => !linkedPageIds.has(pageKey(page)))
  const indexableMissing = indexableMissingPages.length

  const maintenanceCounts = countBy(args.maintenanceQueue.items.map((item) => item.type))
  const logStats = computeLogStats(logPage?.content ?? "", now)

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    totals: {
      wikiPages: parsedPages.length,
      graphNodes: args.nodes.length,
      graphEdges: args.edges.length,
    },
    counts: {
      pageTypes: countBy(parsedPages.map((page) => bucket(page.type, PAGE_TYPES, "other"))),
      states: countBy(parsedPages.map((page) => bucket(page.state, STATES, "missing"))),
      qualities: countBy(parsedPages.map((page) => bucket(page.quality, QUALITIES, "missing"))),
      queryRetentions: countBy(parsedPages
        .filter((page) => isQueryPage(page))
        .map((page) => bucket(page.retention, QUERY_RETENTIONS, "missing"))),
      maintenance: maintenanceCounts,
    },
    qualitySignals: {
      needsUpgradeTrue: args.nodes.filter((node) => node.needsUpgrade === true).length,
      weakEvidence: args.nodes.filter((node) => node.evidenceStrength === "weak").length,
      sourceTraceMissing: parsedPages.filter(isKnowledgePage).filter((page) => page.sources.length === 0).length,
      orphanCandidates: args.maintenanceQueue.items.filter((item) => item.type === "orphan-candidate").length,
      duplicateCandidates: args.maintenanceQueue.items.filter((item) => item.type.includes("duplicate")).length,
    },
    index: {
      linkedPages: linkedPageIds.size,
      indexableMissing,
      ephemeralQueryLinks,
      indexableMissingExamples: indexableMissingPages.slice(0, 20).map(formatPageExample),
      ephemeralQueryLinkExamples: ephemeralQueryLinkExamples.slice(0, 20),
    },
    log: {
      ...logStats,
      policy: LOG_RETENTION_POLICY,
    },
  }
}

function formatPageExample(page: ParsedHealthPage): string {
  const path = normalizeWikiPath(page.path)
  const wikiIndex = path.lastIndexOf("/wiki/")
  const relativePath = wikiIndex >= 0 ? path.slice(wikiIndex + 1) : path
  return `${page.title} (${relativePath})`
}

export async function buildProjectHealthReport(
  projectPath: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  maintenanceQueue: MaintenanceQueue,
  now: Date = new Date(),
): Promise<WikiHealthReport> {
  const pages = await readProjectWikiPages(projectPath)
  return buildWikiHealthReport({ pages, nodes, edges, maintenanceQueue, now })
}

export async function saveHealthReport(projectPath: string, report: WikiHealthReport): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.llm-wiki`).catch(() => {})
  await writeFile(`${pp}/.llm-wiki/health.json`, JSON.stringify(report, null, 2))
}

async function readProjectWikiPages(projectPath: string): Promise<HealthWikiPage[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const pages: HealthWikiPage[] = []
  for (const file of flattenMdFiles(tree)) {
    try {
      pages.push({
        path: file.path,
        name: file.name,
        content: await readFile(file.path),
      })
    } catch {
      // Health reports are best-effort; one unreadable page should not block startup.
    }
  }
  return pages
}

function parseHealthPage(page: HealthWikiPage): ParsedHealthPage {
  const parsed = parseGraphPage(page.content, page.name, page.path)
  const type = parsed.type
  return {
    path: page.path,
    content: page.content,
    title: parsed.title,
    type,
    state: parsed.state ?? inferStateFromQuality(parsed.quality),
    quality: parsed.quality,
    evidenceStrength: parsed.evidenceStrength,
    reviewStatus: parsed.reviewStatus,
    retention: isQueryPathOrType(page.path, type) ? (parsed.retention ?? "ephemeral") : parsed.retention,
    sources: parsed.sources,
    wikilinks: parsed.wikilinks,
  }
}

function isHumanIndexPage(page: ParsedHealthPage): boolean {
  if (isStructuralPage(page)) return false
  if (page.state === "archived" || page.state === "deprecated") return false
  if (isQueryPage(page)) return page.retention === "reusable" || page.retention === "promote"
  return (
    page.state === "active" ||
    page.state === "canonical" ||
    page.quality === "reviewed" ||
    page.quality === "canonical" ||
    page.reviewStatus === "ai_reviewed" ||
    page.reviewStatus === "human_reviewed" ||
    page.reviewStatus === "validated"
  )
}

function isKnowledgePage(page: ParsedHealthPage): boolean {
  return ["source", "entity", "concept", "comparison", "synthesis"].includes(page.type)
}

function isQueryPage(page: ParsedHealthPage): boolean {
  return isQueryPathOrType(page.path, page.type)
}

function isEphemeralQuery(page: ParsedHealthPage): boolean {
  return isQueryPage(page) && (page.retention === undefined || page.retention === "ephemeral" || page.retention === "archive")
}

function isStructuralPage(page: ParsedHealthPage): boolean {
  const path = normalizeWikiPath(page.path)
  return page.type === "overview" || page.type === "index" || page.type === "log" ||
    path.endsWith("wiki/overview.md") || path.endsWith("wiki/index.md") || path.endsWith("wiki/log.md")
}

function computeLogStats(content: string, now: Date): Omit<WikiHealthReport["log"], "policy"> {
  const headings = [...content.matchAll(/^##\s+\[(\d{4}-\d{2}-\d{2})\]/gm)]
  const dates = headings
    .map((match) => match[1])
    .sort()
  const oldestEntryDate = dates[0] ?? null
  const oldestMs = oldestEntryDate ? Date.parse(`${oldestEntryDate}T00:00:00Z`) : null
  const nowMs = now.getTime()
  const olderThanPolicy = oldestMs !== null
    ? nowMs - oldestMs > LOG_RETENTION_POLICY.keepRecentDays * 24 * 60 * 60 * 1000
    : false
  return {
    entryCount: headings.length,
    byteLength: new TextEncoder().encode(content).length,
    oldestEntryDate,
    rolloverNeeded: headings.length > LOG_RETENTION_POLICY.keepRecentEntries || olderThanPolicy,
  }
}

function buildAliasMap(pages: readonly ParsedHealthPage[]): Map<string, ParsedHealthPage> {
  const aliases = new Map<string, ParsedHealthPage>()
  for (const page of pages) {
    for (const alias of pageAliases(page)) {
      aliases.set(alias, page)
    }
  }
  return aliases
}

function pageAliases(page: ParsedHealthPage): string[] {
  const path = normalizeWikiPath(page.path)
  const basename = path.split("/").pop() ?? path
  const noExt = basename.replace(/\.md$/i, "")
  const wikiRelative = path.replace(/^.*\/wiki\//i, "wiki/")
  return [
    page.title,
    basename,
    noExt,
    wikiRelative,
    wikiRelative.replace(/\.md$/i, ""),
    wikiRelative.replace(/^wiki\//i, ""),
    wikiRelative.replace(/^wiki\//i, "").replace(/\.md$/i, ""),
  ].map(normalizeAlias)
}

function pageKey(page: ParsedHealthPage): string {
  return normalizeWikiPath(page.path)
}

function normalizeAlias(value: string): string {
  return value
    .trim()
    .replace(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/, "$1")
    .replace(/#.*$/, "")
    .replace(/\.md$/i, "")
    .replace(/\\/g, "/")
    .trim()
    .toLowerCase()
}

function normalizeWikiPath(path: string): string {
  return path.replace(/\\/g, "/")
}

function isQueryPathOrType(path: string, type: string | undefined): boolean {
  return type === "query" || normalizeWikiPath(path).includes("/wiki/queries/")
}

function countBy(values: readonly CountKey[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function bucket<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  return allowed.find((item) => item === normalized) ?? fallback
}

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
