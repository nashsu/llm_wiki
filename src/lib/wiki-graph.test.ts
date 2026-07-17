import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)
vi.mock("./graph-relevance", () => ({
  buildRetrievalGraph: vi.fn().mockRejectedValue(new Error("not needed")),
  calculateRelevance: vi.fn(),
}))

import { buildWikiGraph } from "./wiki-graph"

beforeEach(() => {
  fsMocks.listDirectory.mockReset()
  fsMocks.readFile.mockReset()
})

describe("buildWikiGraph", () => {
  it("keeps repository pages visible as typed graph nodes", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      {
        name: "repositories",
        path: "/project/wiki/repositories",
        is_dir: true,
        children: [
          {
            name: "nashsu-llm-wiki.md",
            path: "/project/wiki/repositories/nashsu-llm-wiki.md",
            is_dir: false,
          },
        ],
      },
      {
        name: "concepts",
        path: "/project/wiki/concepts",
        is_dir: true,
        children: [
          {
            name: "knowledge-core.md",
            path: "/project/wiki/concepts/knowledge-core.md",
            is_dir: false,
          },
        ],
      },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("nashsu-llm-wiki.md")) {
        return "---\ntype: repository\ntitle: Nashsu / llm_wiki\n---\n\n[[knowledge-core]]"
      }
      return "---\ntype: concept\ntitle: Knowledge Core\n---\n\n[[nashsu-llm-wiki]]"
    })

    const graph = await buildWikiGraph("/project")

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "nashsu-llm-wiki",
        type: "repository",
        path: "/project/wiki/repositories/nashsu-llm-wiki.md",
      }),
    ]))
    expect(graph.edges).toEqual([
      expect.objectContaining({
        source: "nashsu-llm-wiki",
        target: "knowledge-core",
      }),
    ])
  })
})

