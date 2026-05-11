import { buildProjectMaintenanceQueue, saveMaintenanceQueue, type MaintenanceQueue } from "@/lib/maintenance-queue"
import { buildProjectHealthReport, saveHealthReport } from "@/lib/wiki-health-report"
import { buildWikiGraph, type GraphEdge, type GraphNode } from "@/lib/wiki-graph"
import { normalizePath } from "@/lib/path-utils"

export async function saveMaintenanceQueueForGraph(
  projectPath: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  now: Date = new Date(),
): Promise<MaintenanceQueue> {
  const pp = normalizeProjectPath(projectPath)
  const queue = await buildProjectMaintenanceQueue(pp, nodes, edges, now)
  await saveMaintenanceQueue(pp, queue)
  const health = await buildProjectHealthReport(pp, nodes, edges, queue, now)
  await saveHealthReport(pp, health)
  return queue
}

export async function refreshProjectMaintenanceQueue(
  projectPath: string,
  now: Date = new Date(),
): Promise<MaintenanceQueue> {
  const pp = normalizeProjectPath(projectPath)
  const graph = await buildWikiGraph(pp)
  return saveMaintenanceQueueForGraph(pp, graph.nodes, graph.edges, now)
}

function normalizeProjectPath(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}
