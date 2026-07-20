/**
 * wiki-graph.test.ts — regression tests for frontmatter-scoped title/type extraction
 *
 * extractTitle/extractType previously searched for `title:`/`type:` anywhere in the
 * whole file content, not just inside the `---...---` frontmatter block, because the
 * lazy `[\s\S]*?` in their regexes was never required to stop at the closing `---`.
 * A body line that merely starts with `title:` or `type:` (plain prose, not YAML)
 * could be misread as the frontmatter value.
 */
import { describe, it, expect, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const mockListDirectory = vi.fn()
const mockReadFile = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => mockListDirectory(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

async function loadBuildWikiGraph() {
  const mod = await import("../wiki-graph")
  return mod.buildWikiGraph
}

function mdFile(name: string): FileNode {
  return { name, path: `/project/wiki/${name}`, is_dir: false }
}

describe("buildWikiGraph frontmatter extraction", () => {
  it("does not read a title: line from the document body as the frontmatter title", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\ntype: entity\n---\n# Real Heading\n\nSome text.\ntitle: not-frontmatter-at-all\n",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0].label).toBe("Real Heading")
  })

  it("does not read a type: line from the document body as the frontmatter type", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\ntitle: Real Page\n---\n# Real Page\n\nSome text.\ntype: query\nMore text.\n",
    )

    const graph = await buildWikiGraph("/project")

    // A misread type of "query" would match HIDDEN_TYPES and silently drop the page.
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0].type).toBe("other")
  })

  it("parses CRLF frontmatter consistently with the rest of the application", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      "---\r\ntitle: CRLF Page\r\ntype: entity\r\n---\r\n# Fallback Heading\r\n",
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ label: "CRLF Page", type: "entity" })
  })

  it("uses YAML parsing for quoted values that contain a colon", async () => {
    const buildWikiGraph = await loadBuildWikiGraph()
    mockListDirectory.mockResolvedValue([mdFile("page.md")])
    mockReadFile.mockResolvedValue(
      '---\ntitle: "Attention: Architecture"\ntype: "Concept"\n---\n# Fallback Heading\n',
    )

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ label: "Attention: Architecture", type: "concept" })
  })
})
