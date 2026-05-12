import { createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import {
  fileNameToGraphId,
  parseGraphPage,
  type ParsedGraphPage,
} from "@/lib/graph-relations"

export type MaintenanceIssueType =
  | "orphan-candidate"
  | "weak-evidence-page"
  | "low-quality-page"
  | "source-trace-missing"
  | "unresolved-reference"
  | "query-promotion-candidate"
  | "deprecated-active-reference"

export interface MaintenanceQueueItem {
  id: string
  type: MaintenanceIssueType
  pagePath: string
  pageTitle: string
  severity: "low" | "medium" | "high"
  reason: string
}

export interface MaintenanceQueue {
  generatedAt: string
  items: MaintenanceQueueItem[]
}

interface MaintenanceQueueOptions {
  knownExistingReferences?: ReadonlySet<string>
  rawSourceReferences?: ReadonlySet<string>
}

interface ParsedMaintenancePage {
  id: string
  path: string
  title: string
  parsed: ParsedGraphPage
}

export function buildMaintenanceQueue(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  now: Date = new Date(),
  options: MaintenanceQueueOptions = {},
): MaintenanceQueue {
  const referencedDeprecated = new Set<string>()
  for (const edge of edges) {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (source && isDeprecatedOrArchived(source) && target && !isDeprecatedOrArchived(target)) {
      referencedDeprecated.add(source.id)
    }
    if (target && isDeprecatedOrArchived(target) && source && !isDeprecatedOrArchived(source)) {
      referencedDeprecated.add(target.id)
    }
  }

  const items: MaintenanceQueueItem[] = []
  for (const node of nodes) {
    const unresolvedRelated = (node.unresolvedRelated ?? [])
      .filter((reference) => isActionableWikiReference(reference, options))
    const unresolvedSources = (node.unresolvedSources ?? [])
      .filter((reference) => isActionableSourceReference(reference, options))
    if (unresolvedRelated.length > 0 || unresolvedSources.length > 0) {
      const reasonParts = [
        unresolvedRelated.length > 0 ? `Unresolved wiki references: ${unresolvedRelated.join(", ")}` : "",
        unresolvedSources.length > 0 ? `Missing source traces: ${unresolvedSources.join(", ")}` : "",
      ].filter(Boolean)
      items.push(item(node, "unresolved-reference", "high", reasonParts.join("; ")))
    }
    if (node.linkCount <= 0) {
      items.push(item(node, "orphan-candidate", "medium", "No inbound or outbound graph links."))
    }
    if (node.evidenceStrength === "weak") {
      items.push(item(node, "weak-evidence-page", "high", "evidence_strength is weak."))
    }
    if (shouldQueueLowQualityPage(node)) {
      items.push(item(node, "low-quality-page", "medium", "Quality metadata marks this page as incomplete."))
    }
    if (isKnowledgeNode(node) && (node.sources?.length ?? 0) === 0) {
      items.push(item(node, "source-trace-missing", "high", "Knowledge node has no source trace."))
    }
    if (node.retention === "promote") {
      items.push(item(node, "query-promotion-candidate", "medium", "Query retention requests promotion into a durable knowledge page."))
    }
    if (referencedDeprecated.has(node.id)) {
      items.push(item(node, "deprecated-active-reference", "medium", "Active graph still references a deprecated or archived page."))
    }
  }

  return { generatedAt: now.toISOString(), items }
}

export async function buildProjectMaintenanceQueue(
  projectPath: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  now: Date = new Date(),
): Promise<MaintenanceQueue> {
  const pages = await readWikiMaintenancePages(projectPath)
  const rawSourceReferences = await readRawSourceReferences(projectPath)
  const queue = buildMaintenanceQueue(nodes, edges, now, {
    knownExistingReferences: buildKnownReferenceSet(pages),
    rawSourceReferences,
  })
  addHiddenSurfaceCandidates(queue.items, pages)
  return queue
}

export async function saveMaintenanceQueue(
  projectPath: string,
  queue: MaintenanceQueue,
): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.llm-wiki`).catch(() => {})
  await writeFile(`${pp}/.llm-wiki/maintenance.json`, JSON.stringify(queue, null, 2))
}

function shouldQueueLowQualityPage(node: GraphNode): boolean {
  const markedIncomplete =
    node.needsUpgrade === true || node.quality === "seed" || node.quality === "draft" || node.coverage === "low"
  if (!markedIncomplete) return false
  if (isRoutineDraftSourceSummary(node)) return false
  return true
}

function isRoutineDraftSourceSummary(node: GraphNode): boolean {
  if (node.type !== "source") return false
  const hasSourceTrace = (node.sources?.length ?? 0) > 0 || (node.sourceCount ?? 0) > 0
  const hasUsableEvidence = node.evidenceStrength === "moderate" || node.evidenceStrength === "strong"
  const hasUsableCoverage = node.coverage === "medium" || node.coverage === "high"
  return hasSourceTrace && hasUsableEvidence && hasUsableCoverage
}

function item(
  node: GraphNode,
  type: MaintenanceIssueType,
  severity: MaintenanceQueueItem["severity"],
  reason: string,
): MaintenanceQueueItem {
  return {
    id: `${type}:${node.id}`,
    type,
    pagePath: node.path,
    pageTitle: node.label,
    severity,
    reason,
  }
}

function isKnowledgeNode(node: GraphNode): boolean {
  return node.type === "entity" || node.type === "concept" || node.type === "comparison" || node.type === "synthesis"
}

function isDeprecatedOrArchived(node: GraphNode): boolean {
  return node.state === "deprecated" || node.state === "archived"
}

async function readWikiMaintenancePages(projectPath: string): Promise<ParsedMaintenancePage[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const pages: ParsedMaintenancePage[] = []
  for (const file of flattenMdFiles(tree)) {
    try {
      const content = await readFile(file.path)
      const parsed = parseGraphPage(content, file.name, file.path)
      pages.push({
        id: fileNameToGraphId(file.name),
        path: file.path,
        title: parsed.title,
        parsed,
      })
    } catch {
      // A queue is best-effort; one unreadable file should not block graph load.
    }
  }
  return pages
}

async function readRawSourceReferences(projectPath: string): Promise<Set<string>> {
  const rawRoot = `${normalizePath(projectPath)}/raw`
  let tree: FileNode[]
  try {
    tree = await listDirectory(rawRoot)
  } catch {
    return new Set()
  }

  const references = new Set<string>()
  for (const file of flattenFiles(tree)) {
    addReferenceAliases(references, file.name)
  }
  return references
}

function buildKnownReferenceSet(pages: readonly ParsedMaintenancePage[]): Set<string> {
  const references = new Set<string>()
  for (const page of pages) {
    addReferenceAliases(references, page.id)
    addReferenceAliases(references, page.title)
    addReferenceAliases(references, page.path)
  }
  return references
}

function addHiddenSurfaceCandidates(
  items: MaintenanceQueueItem[],
  pages: readonly ParsedMaintenancePage[],
): void {
  const existingIds = new Set(items.map((candidate) => candidate.id))

  for (const page of pages) {
    if (page.parsed.retention === "promote") {
      const candidate = rawItem(
        page,
        "query-promotion-candidate",
        "medium",
        "Query retention requests promotion into a durable knowledge page.",
      )
      if (!existingIds.has(candidate.id)) {
        items.push(candidate)
        existingIds.add(candidate.id)
      }
    }
  }

  const deprecatedTargets = new Map<string, ParsedMaintenancePage>()
  for (const page of pages) {
    if (page.parsed.state !== "deprecated" && page.parsed.state !== "archived") continue
    deprecatedTargets.set(normalizeLookupKey(page.id), page)
    deprecatedTargets.set(normalizeLookupKey(page.title), page)
  }

  for (const page of pages) {
    if (!isActiveKnowledgeSurfacePage(page)) continue
    if (page.parsed.state === "deprecated" || page.parsed.state === "archived") continue
    const references = [
      ...page.parsed.wikilinks,
      ...page.parsed.related,
      ...page.parsed.relationships.map((relationship) => relationship.target),
    ]
    for (const reference of references) {
      const target = deprecatedTargets.get(normalizeLookupKey(reference))
      if (!target) continue
      const candidate = rawItem(
        target,
        "deprecated-active-reference",
        "medium",
        `Referenced by active page: ${page.title}`,
      )
      if (!existingIds.has(candidate.id)) {
        items.push(candidate)
        existingIds.add(candidate.id)
      }
    }
  }
}

function rawItem(
  page: ParsedMaintenancePage,
  type: MaintenanceIssueType,
  severity: MaintenanceQueueItem["severity"],
  reason: string,
): MaintenanceQueueItem {
  return {
    id: `${type}:${page.id}`,
    type,
    pagePath: page.path,
    pageTitle: page.title,
    severity,
    reason,
  }
}

function isActiveKnowledgeSurfacePage(page: ParsedMaintenancePage): boolean {
  if (page.parsed.state === "deprecated" || page.parsed.state === "archived") return false
  if (page.parsed.retention === "ephemeral" || page.parsed.retention === "archive") return false
  return page.parsed.type === "entity" ||
    page.parsed.type === "concept" ||
    page.parsed.type === "comparison" ||
    page.parsed.type === "synthesis"
}

function normalizeLookupKey(value: string): string {
  return value.replace(/\.md$/i, "").trim().toLowerCase()
}

function isActionableWikiReference(
  reference: string,
  options: MaintenanceQueueOptions,
): boolean {
  if (isExternalReference(reference)) return false
  if (matchesReferenceSet(reference, options.rawSourceReferences)) return false
  return !matchesReferenceSet(reference, options.knownExistingReferences)
}

function isActionableSourceReference(
  reference: string,
  options: MaintenanceQueueOptions,
): boolean {
  if (isExternalReference(reference)) return false
  if (matchesReferenceSet(reference, options.knownExistingReferences)) return false
  if (matchesReferenceSet(reference, options.rawSourceReferences)) return false
  return true
}

function isExternalReference(reference: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(reference.trim()) || /^mailto:/i.test(reference.trim())
}

function matchesReferenceSet(reference: string, references: ReadonlySet<string> | undefined): boolean {
  if (!references) return false
  return referenceAliases(reference).some((alias) => references.has(alias))
}

function addReferenceAliases(references: Set<string>, value: string): void {
  for (const alias of referenceAliases(value)) {
    references.add(alias)
  }
}

function referenceAliases(value: string): string[] {
  const unwrapped = value
    .trim()
    .replace(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/, "$1")
    .replace(/#.*$/, "")
    .replace(/\\/g, "/")
    .trim()
  const withoutWikiPrefix = unwrapped.replace(/^wiki\//i, "")
  const segments = withoutWikiPrefix.split("/").filter(Boolean)
  const basename = segments[segments.length - 1] ?? withoutWikiPrefix
  const candidates = [
    unwrapped,
    unwrapped.replace(/\.md$/i, ""),
    withoutWikiPrefix,
    withoutWikiPrefix.replace(/\.md$/i, ""),
    basename,
    basename.replace(/\.md$/i, ""),
  ]
  return [...new Set(candidates.map((candidate) => candidate.trim().toLowerCase()).filter(Boolean))]
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

function flattenFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
