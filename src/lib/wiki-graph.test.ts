import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const mockReadFile = vi.fn<(path: string) => Promise<string>>()
const mockListDirectory = vi.fn<(path: string) => Promise<FileNode[]>>()

vi.mock("@/commands/fs", () => ({
  readFile: (path: string) => mockReadFile(path),
  listDirectory: (path: string) => mockListDirectory(path),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: () => ({ dataVersion: 0 }),
  },
}))

import { buildWikiGraph } from "./wiki-graph"
import { buildRetrievalGraph, clearGraphCache } from "./graph-relevance"

const PROJECT = "/project"
const WIKI = `${PROJECT}/wiki`

function file(path: string): FileNode {
  return { name: path.split("/").pop()!, path, is_dir: false }
}

function dir(path: string, children: FileNode[]): FileNode {
  return { name: path.split("/").pop()!, path, is_dir: true, children }
}

function page(frontmatter: string, body: string = ""): string {
  return ["---", frontmatter.trim(), "---", "", body].join("\n")
}

function installWiki(files: Record<string, string>): void {
  const rootFiles = Object.keys(files).filter((p) => {
    const relative = p.slice(`${WIKI}/`.length)
    return !relative.includes("/")
  }).map(file)
  const tree = [
    ...rootFiles,
    dir(`${WIKI}/concepts`, Object.keys(files).filter((p) => p.includes("/concepts/")).map(file)),
    dir(`${WIKI}/entities`, Object.keys(files).filter((p) => p.includes("/entities/")).map(file)),
    dir(`${WIKI}/sources`, Object.keys(files).filter((p) => p.includes("/sources/")).map(file)),
    dir(`${WIKI}/queries`, Object.keys(files).filter((p) => p.includes("/queries/")).map(file)),
  ]
  mockListDirectory.mockResolvedValue(tree)
  mockReadFile.mockImplementation(async (path) => {
    const content = files[path]
    if (content === undefined) throw new Error(`missing file: ${path}`)
    return content
  })
}

beforeEach(() => {
  mockReadFile.mockReset()
  mockListDirectory.mockReset()
  clearGraphCache()
})

describe("buildWikiGraph", () => {
  it("creates typed edges from body wikilinks", async () => {
    installWiki({
      [`${WIKI}/concepts/concept-a.md`]: page("type: concept\ntitle: Concept A", "[[entity-b]]"),
      [`${WIKI}/entities/entity-b.md`]: page("type: entity\ntitle: Entity B"),
    })

    const graph = await buildWikiGraph(PROJECT)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({
      source: "concept-a",
      target: "entity-b",
      types: ["wikilink"],
    })
  })

  it("creates related edges from frontmatter related arrays", async () => {
    installWiki({
      [`${WIKI}/concepts/concept-a.md`]: page("type: concept\ntitle: Concept A\nrelated: [entity-b]"),
      [`${WIKI}/entities/entity-b.md`]: page("type: entity\ntitle: Entity B"),
    })

    const graph = await buildWikiGraph(PROJECT)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({
      source: "concept-a",
      target: "entity-b",
      types: ["related"],
    })
  })

  it("creates source edges only when sources resolve to wiki source nodes", async () => {
    installWiki({
      [`${WIKI}/concepts/concept-a.md`]: page("type: concept\ntitle: Concept A\nsources: [paper.md, raw-only.pdf]"),
      [`${WIKI}/sources/paper.md`]: page("type: source\ntitle: Paper"),
    })

    const graph = await buildWikiGraph(PROJECT)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({
      source: "concept-a",
      target: "paper",
      types: ["source"],
    })
    expect(graph.nodes.find((node) => node.id === "concept-a")?.unresolvedSources).toEqual(["raw-only.pdf"])
  })

  it("resolves raw source filenames through clean source summary pages", async () => {
    installWiki({
      [`${WIKI}/concepts/concept-a.md`]: page(
        'type: concept\ntitle: Concept A\nsources: ["OpenClaw vs Hermes-20260509.md"]',
      ),
      [`${WIKI}/sources/openclaw-vs-hermes-source.md`]: page(
        'type: source\ntitle: OpenClaw vs Hermes\nsources: ["OpenClaw vs Hermes-20260509.md"]',
      ),
    })

    const graph = await buildWikiGraph(PROJECT)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({
      source: "concept-a",
      target: "openclaw-vs-hermes-source",
      types: ["source"],
    })
  })

  it("merges duplicate relation types into one edge", async () => {
    installWiki({
      [`${WIKI}/concepts/concept-a.md`]: page(
        "type: concept\ntitle: Concept A\nrelated: [entity-b]",
        "[[entity-b]]",
      ),
      [`${WIKI}/entities/entity-b.md`]: page("type: entity\ntitle: Entity B"),
    })

    const graph = await buildWikiGraph(PROJECT)

    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({
      source: "concept-a",
      target: "entity-b",
      types: ["wikilink", "related"],
    })
  })

  it("does not resolve title-only references", async () => {
    installWiki({
      [`${WIKI}/concepts/concept-a.md`]: page("type: concept\ntitle: Concept A\nrelated: [Entity B Title]"),
      [`${WIKI}/entities/entity-b.md`]: page("type: entity\ntitle: Entity B Title"),
    })

    const graph = await buildWikiGraph(PROJECT)

    expect(graph.edges).toEqual([])
    expect(graph.nodes.find((node) => node.id === "concept-a")?.unresolvedRelated).toEqual(["Entity B Title"])
  })

  it("excludes query records before graph metrics are built", async () => {
    installWiki({
      [`${WIKI}/concepts/concept-a.md`]: page("type: concept\ntitle: Concept A", "[[research-question]]"),
      [`${WIKI}/queries/research-question.md`]: page("type: query\ntitle: Research Question", "[[concept-a]]"),
    })

    const graph = await buildWikiGraph(PROJECT)

    expect(graph.nodes.map((node) => node.id)).toEqual(["concept-a"])
    expect(graph.edges).toEqual([])
  })

  it("excludes structural and index-like pages before graph metrics are built", async () => {
    installWiki({
      [`${WIKI}/index.md`]: page("type: index\ntitle: Index", "[[concept-a]]"),
      [`${WIKI}/overview.md`]: page("type: overview\ntitle: Overview", "[[concept-a]]"),
      [`${WIKI}/concepts/concept-a.md`]: page("type: concept\ntitle: Concept A"),
      [`${WIKI}/sources/10_maps/codex-chats.md`]: page(
        "type: source-map\ntitle: Codex Chats\nsource_role: source_map",
        "[[concept-a]]",
      ),
      [`${WIKI}/sources/manifest.md`]: page("type: source\ntitle: Source Manifest"),
      [`${WIKI}/sources/raw-registry.md`]: page(
        "type: registry\ntitle: Raw Registry",
        "[[concept-a]]",
      ),
      [`${WIKI}/queries/research-question.md`]: page(
        "type: query\ntitle: Research Question",
        "[[concept-a]]",
      ),
    })

    const graph = await buildWikiGraph(PROJECT)

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["concept-a"])
    expect(graph.edges).toEqual([])
    expect(graph.communities.flatMap((community) => community.topNodes)).toEqual(["Concept A"])
  })

  it("excludes structural and index-like pages from the retrieval graph", async () => {
    installWiki({
      [`${WIKI}/index.md`]: page("type: index\ntitle: Index", "[[concept-a]]"),
      [`${WIKI}/concepts/concept-a.md`]: page("type: concept\ntitle: Concept A"),
      [`${WIKI}/sources/10_maps/codex-chats.md`]: page(
        "type: source-map\ntitle: Codex Chats\nsource_role: source_map",
        "[[concept-a]]",
      ),
      [`${WIKI}/sources/registry.md`]: page("type: source\ntitle: Source Registry"),
      [`${WIKI}/sources/raw-manifest.md`]: page("type: manifest\ntitle: Raw Manifest"),
      [`${WIKI}/queries/research-question.md`]: page("type: query\ntitle: Research Question"),
    })

    const graph = await buildRetrievalGraph(PROJECT, 1)

    expect([...graph.nodes.keys()].sort()).toEqual(["concept-a"])
  })
})
