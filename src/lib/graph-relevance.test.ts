import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const { listDirectory, readFile } = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({ listDirectory, readFile }))

import { buildRetrievalGraph, clearGraphCache } from "./graph-relevance"

function files(root: string, count: number): FileNode[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `page-${index}.md`,
    path: `${root}/wiki/page-${index}.md`,
    is_dir: false,
  }))
}

beforeEach(() => {
  clearGraphCache()
  listDirectory.mockReset()
  readFile.mockReset()
})

describe("buildRetrievalGraph", () => {
  it("reads wiki pages concurrently without exceeding the worker limit", async () => {
    listDirectory.mockResolvedValue(files("/project", 40))
    let active = 0
    let peak = 0
    readFile.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return "---\ntype: concept\n---\n# Page"
    })

    const graph = await buildRetrievalGraph("/project", 1)

    expect(graph.nodes.size).toBe(40)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(16)
  })

  it("does not reuse a same-version cache entry across projects", async () => {
    listDirectory.mockImplementation(async (root: string) => files(root.replace(/\/wiki$/, ""), 1))
    readFile.mockImplementation(async (path: string) => `# ${path.includes("project-a") ? "A" : "B"}`)

    const a = await buildRetrievalGraph("/project-a", 7)
    const b = await buildRetrievalGraph("/project-b", 7)

    expect(a.nodes.values().next().value?.title).toBe("A")
    expect(b.nodes.values().next().value?.title).toBe("B")
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("includes frontmatter related entries in retrieval links", async () => {
    listDirectory.mockResolvedValue([
      ...files("/project", 2),
    ])
    readFile.mockImplementation(async (path: string) =>
      path.endsWith("page-0.md")
        ? "---\nrelated: [page-1]\n---\n# Source"
        : "# Target",
    )

    const graph = await buildRetrievalGraph("/project", 2)

    expect(graph.nodes.get("page-0")?.outLinks).toContain("page-1")
    expect(graph.nodes.get("page-1")?.inLinks).toContain("page-0")
  })

  it("resolves case and whitespace aliases through the prebuilt index", async () => {
    listDirectory.mockResolvedValue([
      { name: "source.md", path: "/project/wiki/source.md", is_dir: false },
      { name: "page-00042.md", path: "/project/wiki/page-00042.md", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => path.endsWith("source.md")
      ? "# Source\n\n[[Page 00042]]"
      : "# Target")

    const graph = await buildRetrievalGraph("/project", 3)

    expect(graph.nodes.get("source")?.outLinks).toEqual(new Set(["page-00042"]))
    expect(graph.nodes.get("page-00042")?.inLinks).toEqual(new Set(["source"]))
  })

  it("keeps exact IDs ahead of normalized aliases", async () => {
    listDirectory.mockResolvedValue([
      { name: "source.md", path: "/project/wiki/source.md", is_dir: false },
      { name: "Page 1.md", path: "/project/wiki/Page 1.md", is_dir: false },
      { name: "page-1.md", path: "/project/wiki/page-1.md", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => path.endsWith("source.md")
      ? "# Source\n\n[[page-1]]"
      : "# Target")

    const graph = await buildRetrievalGraph("/project", 4)

    expect(graph.nodes.get("source")?.outLinks).toEqual(new Set(["page-1"]))
  })

  it.each([
    [["foo-bar.md", "foo bar.md"], "foo-bar"],
    [["foo bar.md", "foo-bar.md"], "foo bar"],
  ] as const)("keeps the first listed node for ambiguous aliases in order %j", async (names, expected) => {
    listDirectory.mockResolvedValue([
      { name: "source.md", path: "/project/wiki/source.md", is_dir: false },
      ...names.map((name) => ({ name, path: `/project/wiki/${name}`, is_dir: false })),
    ])
    readFile.mockImplementation(async (path: string) => path.endsWith("source.md")
      ? "# Source\n\n[[FOO BAR]]"
      : "# Target")

    const graph = await buildRetrievalGraph("/project", 5)

    expect(graph.nodes.get("source")?.outLinks).toEqual(new Set([expected]))
  })

  it("collapses repeated whitespace and filters self-links resolved through aliases", async () => {
    listDirectory.mockResolvedValue([
      { name: "source-page.md", path: "/project/wiki/source-page.md", is_dir: false },
      { name: "target-page.md", path: "/project/wiki/target-page.md", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => path.endsWith("source-page.md")
      ? "# Source\n\n[[SOURCE PAGE]] [[Target  Page]]"
      : "# Target")

    const graph = await buildRetrievalGraph("/project", 6)

    expect(graph.nodes.get("source-page")?.outLinks).toEqual(new Set(["target-page"]))
    expect(graph.nodes.get("source-page")?.inLinks.size).toBe(0)
  })

  it("resolves frontmatter related aliases and non-ASCII whitespace", async () => {
    listDirectory.mockResolvedValue([
      { name: "source-page.md", path: "/project/wiki/source-page.md", is_dir: false },
      { name: "target-page.md", path: "/project/wiki/target-page.md", is_dir: false },
    ])
    readFile.mockImplementation(async (path: string) => path.endsWith("source-page.md")
      ? "---\nrelated: [Target\u00a0Page]\n---\n# Source"
      : "# Target")

    const graph = await buildRetrievalGraph("/project", 7)

    expect(graph.nodes.get("source-page")?.outLinks).toEqual(new Set(["target-page"]))
    expect(graph.nodes.get("target-page")?.inLinks).toEqual(new Set(["source-page"]))
  })

  it("does not create edges for many missing aliases", async () => {
    listDirectory.mockResolvedValue([
      { name: "source.md", path: "/project/wiki/source.md", is_dir: false },
      ...files("/project", 1_000),
    ])
    readFile.mockImplementation(async (path: string) => path.endsWith("source.md")
      ? `# Source\n\n${Array.from({ length: 1_000 }, (_, i) => `[[missing ${i}]]`).join(" ")}`
      : "# Target")

    const graph = await buildRetrievalGraph("/project", 8)

    expect(graph.nodes.get("source")?.outLinks.size).toBe(0)
    expect([...graph.nodes.values()].every((node) => node.inLinks.size === 0)).toBe(true)
  })
})
