import { beforeEach, describe, expect, it, vi } from "vitest"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { listDirectory, readFile } from "@/commands/fs"
import { buildMaintenanceQueue, buildProjectMaintenanceQueue } from "./maintenance-queue"

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

const mockListDirectory = vi.mocked(listDirectory)
const mockReadFile = vi.mocked(readFile)

describe("maintenance queue", () => {
  beforeEach(() => {
    mockListDirectory.mockReset()
    mockReadFile.mockReset()
  })

  it("derives durable maintenance candidates from graph metadata", () => {
    const nodes: GraphNode[] = [
      makeNode({
        id: "draft",
        label: "Draft",
        type: "concept",
        path: "/p/wiki/concepts/draft.md",
        quality: "draft",
        evidenceStrength: "weak",
        needsUpgrade: true,
        linkCount: 0,
      }),
      makeNode({
        id: "good",
        label: "Good",
        type: "concept",
        path: "/p/wiki/concepts/good.md",
        sources: ["source.md"],
        quality: "reviewed",
        coverage: "high",
        needsUpgrade: false,
        linkCount: 1,
      }),
    ]
    const edges: GraphEdge[] = []

    const queue = buildMaintenanceQueue(nodes, edges, new Date("2026-05-11T00:00:00.000Z"))

    expect(queue.generatedAt).toBe("2026-05-11T00:00:00.000Z")
    expect(queue.items.map((item) => item.type)).toEqual([
      "orphan-candidate",
      "weak-evidence-page",
      "low-quality-page",
      "source-trace-missing",
    ])
  })

  it("keeps only actionable unresolved references", () => {
    const nodes: GraphNode[] = [
      makeNode({
        id: "node",
        label: "Node",
        type: "concept",
        path: "/p/wiki/concepts/node.md",
        linkCount: 1,
        unresolvedRelated: [
          "Missing Wiki",
          "Existing Hidden Query",
          "Raw Source",
          "https://example.com/reference",
        ],
        unresolvedSources: [
          "Raw Source.md",
          "https://example.com/source",
        ],
      }),
    ]

    const queue = buildMaintenanceQueue(
      nodes,
      [],
      new Date("2026-05-11T00:00:00.000Z"),
      {
        knownExistingReferences: new Set(["existing hidden query"]),
        rawSourceReferences: new Set(["raw source", "raw source.md"]),
      },
    )

    expect(queue.items).toHaveLength(2)
    expect(queue.items[0]).toMatchObject({
      type: "unresolved-reference",
      reason: "Unresolved wiki references: Missing Wiki",
    })
  })

  it("adds hidden query promotion and archived reference candidates", async () => {
    mockListDirectory.mockResolvedValueOnce([
      {
        name: "queries",
        path: "/p/wiki/queries",
        is_dir: true,
        children: [
          { name: "Reusable Question.md", path: "/p/wiki/queries/Reusable Question.md", is_dir: false },
        ],
      },
      {
        name: "concepts",
        path: "/p/wiki/concepts",
        is_dir: true,
        children: [
          { name: "Active.md", path: "/p/wiki/concepts/Active.md", is_dir: false },
          { name: "Old Page.md", path: "/p/wiki/concepts/Old Page.md", is_dir: false },
        ],
      },
    ])
    mockListDirectory.mockResolvedValueOnce([])
    mockReadFile.mockImplementation(async (path) => {
      if (path.endsWith("Reusable Question.md")) {
        return frontmatter({
          type: "query",
          title: "Reusable Question",
          retention: "promote",
        })
      }
      if (path.endsWith("Active.md")) {
        return `${frontmatter({ type: "concept", title: "Active" })}\n[[Old Page]]`
      }
      if (path.endsWith("Old Page.md")) {
        return frontmatter({
          type: "concept",
          title: "Old Page",
          state: "archived",
        })
      }
      throw new Error("not found")
    })

    const queue = await buildProjectMaintenanceQueue(
      "/p",
      [],
      [],
      new Date("2026-05-11T00:00:00.000Z"),
    )

    expect(queue.items.map((item) => item.type)).toEqual([
      "query-promotion-candidate",
      "deprecated-active-reference",
    ])
    expect(queue.items.map((item) => item.pageTitle)).toEqual([
      "Reusable Question",
      "Old Page",
    ])
  })

  it("does not treat hidden pages, raw sources, or URLs as unresolved queue items", async () => {
    mockListDirectory.mockResolvedValueOnce([
      {
        name: "queries",
        path: "/p/wiki/queries",
        is_dir: true,
        children: [
          { name: "Existing Hidden Query.md", path: "/p/wiki/queries/Existing Hidden Query.md", is_dir: false },
        ],
      },
    ])
    mockListDirectory.mockResolvedValueOnce([
      { name: "Raw Source.md", path: "/p/raw/sources/Raw Source.md", is_dir: false },
    ])
    mockReadFile.mockResolvedValueOnce(frontmatter({
      type: "query",
      title: "Existing Hidden Query",
      retention: "ephemeral",
    }))

    const queue = await buildProjectMaintenanceQueue(
      "/p",
      [
        makeNode({
          id: "node",
          label: "Node",
          type: "concept",
          path: "/p/wiki/concepts/node.md",
          linkCount: 1,
          unresolvedRelated: ["Existing Hidden Query", "Raw Source", "https://example.com/reference"],
          unresolvedSources: ["Raw Source.md", "https://example.com/source"],
        }),
      ],
      [],
      new Date("2026-05-11T00:00:00.000Z"),
    )

    expect(queue.items.map((item) => item.type)).not.toContain("unresolved-reference")
  })

  it("does not create archived reference candidates from hidden or evidence pages", async () => {
    mockListDirectory.mockResolvedValueOnce([
      {
        name: "queries",
        path: "/p/wiki/queries",
        is_dir: true,
        children: [
          { name: "Hidden Query.md", path: "/p/wiki/queries/Hidden Query.md", is_dir: false },
        ],
      },
      {
        name: "sources",
        path: "/p/wiki/sources",
        is_dir: true,
        children: [
          { name: "Evidence.md", path: "/p/wiki/sources/Evidence.md", is_dir: false },
        ],
      },
      {
        name: "concepts",
        path: "/p/wiki/concepts",
        is_dir: true,
        children: [
          { name: "Old Page.md", path: "/p/wiki/concepts/Old Page.md", is_dir: false },
        ],
      },
    ])
    mockListDirectory.mockResolvedValueOnce([])
    mockReadFile.mockImplementation(async (path) => {
      if (path.endsWith("Hidden Query.md")) {
        return `${frontmatter({
          type: "query",
          title: "Hidden Query",
          retention: "ephemeral",
        })}\n[[Old Page]]`
      }
      if (path.endsWith("Evidence.md")) {
        return `${frontmatter({ type: "source", title: "Evidence" })}\n[[Old Page]]`
      }
      if (path.endsWith("Old Page.md")) {
        return frontmatter({
          type: "concept",
          title: "Old Page",
          state: "archived",
        })
      }
      throw new Error("not found")
    })

    const queue = await buildProjectMaintenanceQueue(
      "/p",
      [],
      [],
      new Date("2026-05-11T00:00:00.000Z"),
    )

    expect(queue.items.map((item) => item.type)).not.toContain("deprecated-active-reference")
  })
})

function makeNode(overrides: Partial<GraphNode> & Pick<GraphNode, "id" | "label" | "type" | "path">): GraphNode {
  return {
    related: [],
    sources: [],
    relationships: [],
    unresolvedRelated: [],
    unresolvedSources: [],
    linkCount: 0,
    community: 0,
    ...overrides,
  }
}

function frontmatter(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([key, value]) => `${key}: "${value}"`)
  return `---\n${lines.join("\n")}\n---\n# ${values.title ?? "Untitled"}\n`
}
