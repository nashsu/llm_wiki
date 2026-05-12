import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GraphNode } from "@/lib/wiki-graph"
import { buildWikiGraph } from "@/lib/wiki-graph"
import { buildProjectMaintenanceQueue, saveMaintenanceQueue } from "@/lib/maintenance-queue"
import { buildProjectHealthReport, saveHealthReport } from "@/lib/wiki-health-report"
import { OPERATIONAL_SURFACE_POLICY } from "@/lib/wiki-operational-surface"
import { refreshProjectMaintenanceQueue, saveMaintenanceQueueForGraph } from "./maintenance-refresh"

vi.mock("@/lib/wiki-graph", () => ({
  buildWikiGraph: vi.fn(),
}))

vi.mock("@/lib/maintenance-queue", () => ({
  buildProjectMaintenanceQueue: vi.fn(),
  saveMaintenanceQueue: vi.fn(),
}))

vi.mock("@/lib/wiki-health-report", () => ({
  buildProjectHealthReport: vi.fn(),
  saveHealthReport: vi.fn(),
}))

const mockBuildWikiGraph = vi.mocked(buildWikiGraph)
const mockBuildProjectMaintenanceQueue = vi.mocked(buildProjectMaintenanceQueue)
const mockSaveMaintenanceQueue = vi.mocked(saveMaintenanceQueue)
const mockBuildProjectHealthReport = vi.mocked(buildProjectHealthReport)
const mockSaveHealthReport = vi.mocked(saveHealthReport)
const TEST_LOG_RETENTION_POLICY = {
  keepRecentDays: 30,
  keepRecentEntries: 50,
  archivePathPattern: ".llm-wiki/log-archive/YYYY-MM.md",
} as const

describe("maintenance refresh", () => {
  beforeEach(() => {
    mockBuildWikiGraph.mockReset()
    mockBuildProjectMaintenanceQueue.mockReset()
    mockSaveMaintenanceQueue.mockReset()
    mockBuildProjectHealthReport.mockReset()
    mockSaveHealthReport.mockReset()
    mockBuildProjectHealthReport.mockResolvedValue(makeHealthReport())
  })

  it("saves a queue for an already-built graph", async () => {
    const nodes = [makeNode("concept")]
    const edges = [{ source: "concept", target: "source", types: ["source" as const], weight: 1 }]
    const queue = { generatedAt: "2026-05-11T00:00:00.000Z", items: [] }
    const now = new Date("2026-05-11T00:00:00.000Z")
    mockBuildProjectMaintenanceQueue.mockResolvedValueOnce(queue)

    await expect(saveMaintenanceQueueForGraph("/p//", nodes, edges, now)).resolves.toBe(queue)

    expect(mockBuildProjectMaintenanceQueue).toHaveBeenCalledWith("/p", nodes, edges, now)
    expect(mockSaveMaintenanceQueue).toHaveBeenCalledWith("/p", queue)
    expect(mockBuildProjectHealthReport).toHaveBeenCalledWith("/p", nodes, edges, queue, now)
    expect(mockSaveHealthReport).toHaveBeenCalledWith("/p", makeHealthReport())
  })

  it("refreshes the queue from the project graph without opening graph view", async () => {
    const nodes = [makeNode("concept")]
    const edges = [{ source: "concept", target: "source", types: ["source" as const], weight: 1 }]
    const queue = { generatedAt: "2026-05-11T00:00:00.000Z", items: [] }
    const now = new Date("2026-05-11T00:00:00.000Z")
    mockBuildWikiGraph.mockResolvedValueOnce({ nodes, edges, communities: [] })
    mockBuildProjectMaintenanceQueue.mockResolvedValueOnce(queue)

    await expect(refreshProjectMaintenanceQueue("/p//", now)).resolves.toBe(queue)

    expect(mockBuildWikiGraph).toHaveBeenCalledWith("/p")
    expect(mockBuildProjectMaintenanceQueue).toHaveBeenCalledWith("/p", nodes, edges, now)
    expect(mockSaveMaintenanceQueue).toHaveBeenCalledWith("/p", queue)
    expect(mockBuildProjectHealthReport).toHaveBeenCalledWith("/p", nodes, edges, queue, now)
    expect(mockSaveHealthReport).toHaveBeenCalledWith("/p", makeHealthReport())
  })
})

function makeHealthReport() {
  return {
    schemaVersion: 1 as const,
    generatedAt: "2026-05-11T00:00:00.000Z",
    totals: { wikiPages: 0, graphNodes: 0, graphEdges: 0 },
    counts: {
      pageTypes: {},
      states: {},
      qualities: {},
      queryRetentions: {},
      maintenance: {},
    },
    qualitySignals: {
      needsUpgradeTrue: 0,
      weakEvidence: 0,
      sourceTraceMissing: 0,
      orphanCandidates: 0,
      duplicateCandidates: 0,
    },
    index: {
      linkedPages: 0,
      indexableMissing: 0,
      ephemeralQueryLinks: 0,
      indexableMissingExamples: [],
      ephemeralQueryLinkExamples: [],
    },
    log: {
      entryCount: 0,
      byteLength: 0,
      oldestEntryDate: null,
      rolloverNeeded: false,
      policy: TEST_LOG_RETENTION_POLICY,
    },
    operationalSurface: {
      status: "ok" as const,
      controlSurfaceBytes: 0,
      ingestPromptSurfaceBytes: 0,
      ingestPromptSurfaceStatus: "ok" as const,
      recovery: {
        malformedFileFocusedRetryAttempts: 0,
        malformedFileFocusedRetryRecovered: 0,
        oneFileFallbackAttempts: 0,
        oneFileFallbackRecovered: 0,
        latestAt: null,
        latestSource: null,
        currentWeek: {
          weekKey: "2026-W20",
          weekStart: "2026-05-11",
          malformedFileFocusedRetryAttempts: 0,
          malformedFileFocusedRetryRecovered: 0,
          oneFileFallbackAttempts: 0,
          oneFileFallbackRecovered: 0,
        },
      },
      runtimeProofRetention: OPERATIONAL_SURFACE_POLICY.runtimeProofRetention,
      capsApplied: false,
      deterministicTruncation: true as const,
      promptContaminationRisk: {
        archivesExcludedFromBootstrap: true as const,
        deepPolicyExcludedFromBootstrap: true as const,
        runtimeArtifactsExcludedFromBootstrap: true as const,
        archivedOrDeprecatedPagesExcluded: true as const,
      },
      excludedFromBootstrap: [
        ".llm-wiki/policy/*",
        ".llm-wiki/log-archive/*",
        ".llm-wiki/runtime/*",
        "state: archived",
        "state: deprecated",
      ],
      docs: {
        purpose: makeOperationalSurfaceDoc("purpose.md"),
        schema: makeOperationalSurfaceDoc("schema.md"),
        index: makeOperationalSurfaceDoc("wiki/index.md"),
        overview: makeOperationalSurfaceDoc("wiki/overview.md"),
        log: {
          path: "wiki/log.md" as const,
          lineCount: 0,
          byteLength: 0,
          entryCount: 0,
          status: "ok" as const,
          rolloverNeeded: false,
          warnEntries: 50,
          failEntries: 60,
        },
      },
    },
  }
}

function makeOperationalSurfaceDoc(path: string) {
  return {
    path,
    lineCount: 0,
    byteLength: 0,
    status: "ok" as const,
    warnLines: 0,
    failLines: 0,
    capBytes: 0,
    truncatedForIngest: false,
  }
}

function makeNode(id: string): GraphNode {
  return {
    id,
    label: id,
    type: "concept",
    path: `/p/wiki/concepts/${id}.md`,
    related: [],
    sources: [],
    relationships: [],
    unresolvedRelated: [],
    unresolvedSources: [],
    linkCount: 1,
    community: 0,
  }
}
