import { describe, expect, it } from "vitest"
import type { GraphNode } from "@/lib/wiki-graph"
import { buildWikiHealthReport } from "./wiki-health-report"

describe("wiki health report", () => {
  it("counts metadata, excludes ephemeral queries from the human index, and flags log rollover", () => {
    const pages = [
      page("/p/wiki/index.md", "index.md", [
        "---",
        "type: index",
        "title: Index",
        "---",
        "# Index",
        "- [[Active Concept]]",
        "- [[Temp Query]]",
      ].join("\n")),
      page("/p/wiki/log.md", "log.md", [
        "---",
        "type: log",
        "title: Log",
        "---",
        "# Log",
        "## [2026-05-11] newest",
        "## [2026-03-01] oldest",
      ].join("\n")),
      page("/p/wiki/concepts/Active Concept.md", "Active Concept.md", frontmatter({
        type: "concept",
        title: "Active Concept",
        state: "active",
        quality: "reviewed",
        review_status: "ai_reviewed",
        evidence_strength: "moderate",
        sources: "[source.md]",
      })),
      page("/p/wiki/concepts/Missing Index.md", "Missing Index.md", frontmatter({
        type: "concept",
        title: "Missing Index",
        state: "active",
        quality: "reviewed",
        review_status: "ai_reviewed",
        evidence_strength: "weak",
        needs_upgrade: "true",
        sources: "[]",
      })),
      page("/p/wiki/queries/Temp Query.md", "Temp Query.md", frontmatter({
        type: "query",
        title: "Temp Query",
        state: "draft",
        quality: "draft",
      })),
      page("/p/wiki/queries/Promote Query.md", "Promote Query.md", frontmatter({
        type: "query",
        title: "Promote Query",
        retention: "promote",
      })),
    ]

    const nodes: GraphNode[] = [
      makeNode({ id: "active", evidenceStrength: "moderate", needsUpgrade: false }),
      makeNode({ id: "missing", evidenceStrength: "weak", needsUpgrade: true }),
    ]
    const report = buildWikiHealthReport({
      pages,
      nodes,
      edges: [{ source: "active", target: "missing", types: ["wikilink"], weight: 1 }],
      maintenanceQueue: {
        generatedAt: "2026-05-11T00:00:00.000Z",
        items: [
          {
            id: "orphan:missing",
            type: "orphan-candidate",
            pagePath: "/p/wiki/concepts/Missing Index.md",
            pageTitle: "Missing Index",
            severity: "medium",
            reason: "No links.",
          },
        ],
      },
      now: new Date("2026-05-11T00:00:00.000Z"),
    })

    expect(report.totals).toEqual({ wikiPages: 6, graphNodes: 2, graphEdges: 1 })
    expect(report.counts.pageTypes.concept).toBe(2)
    expect(report.counts.queryRetentions.ephemeral).toBe(1)
    expect(report.counts.queryRetentions.promote).toBe(1)
    expect(report.qualitySignals.needsUpgradeTrue).toBe(1)
    expect(report.qualitySignals.weakEvidence).toBe(1)
    expect(report.qualitySignals.sourceTraceMissing).toBe(1)
    expect(report.qualitySignals.orphanCandidates).toBe(1)
    expect(report.index.indexableMissing).toBe(2)
    expect(report.index.ephemeralQueryLinks).toBe(1)
    expect(report.index.indexableMissingExamples).toEqual([
      "Missing Index (wiki/concepts/Missing Index.md)",
      "Promote Query (wiki/queries/Promote Query.md)",
    ])
    expect(report.index.ephemeralQueryLinkExamples).toEqual([
      "Temp Query (wiki/queries/Temp Query.md)",
    ])
    expect(report.log.entryCount).toBe(2)
    expect(report.log.rolloverNeeded).toBe(true)
  })
})

function page(path: string, name: string, content: string) {
  return { path, name, content }
}

function frontmatter(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}: ${value}`)
  return `---\n${lines.join("\n")}\n---\n# ${values.title}\n`
}

function makeNode(overrides: Partial<GraphNode> & Pick<GraphNode, "id">): GraphNode {
  const { id, ...rest } = overrides
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
    ...rest,
  }
}
