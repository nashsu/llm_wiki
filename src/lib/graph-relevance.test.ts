import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { buildRetrievalGraph, clearGraphCache } from "./graph-relevance"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

function mockPages(pages: ReadonlyArray<readonly [string, string | Error]>): void {
  const contents = new Map(pages.map(([id, content]) => [`/project/wiki/${id}.md`, content]))
  const files: FileNode[] = pages.map(([id]) => ({
    name: `${id}.md`,
    path: `/project/wiki/${id}.md`,
    is_dir: false,
  }))
  vi.mocked(listDirectory).mockResolvedValue(files)
  vi.mocked(readFile).mockImplementation(async (path) => {
    const content = contents.get(path)
    if (content instanceof Error) throw content
    if (content === undefined) throw new Error(`Unexpected read: ${path}`)
    return content
  })
}

// Independent oracle: the pre-index resolver from e8082119649e6a8e1cf85eaf289adcabfdf39d4e.
function legacyResolve(raw: string, nodeIds: ReadonlySet<string>): string | null {
  if (nodeIds.has(raw)) return raw
  const normalized = raw.toLowerCase().replace(/\s+/g, "-")
  for (const id of nodeIds) {
    const idLower = id.toLowerCase()
    if (idLower === normalized) return id
    if (idLower === raw.toLowerCase()) return id
    if (idLower.replace(/\s+/g, "-") === normalized) return id
  }
  return null
}

describe("retrieval graph link resolution", () => {
  beforeEach(() => {
    clearGraphCache()
    vi.resetAllMocks()
  })

  afterEach(() => {
    clearGraphCache()
    vi.restoreAllMocks()
  })

  it.each([
    ["Page 00042", "page-00042"],
    ["PAGE-00042", "page-00042"],
    ["page-00042", "Page 00042"],
    ["PAGE 00042", "Page 00042"],
    ["Page\t  00042", "page-00042"],
    ["ÉTUDE\u00a0中", "étude-中"],
  ])("resolves %j to %j and records the backlink", async (target, id) => {
    mockPages([["origin", `[[${target}]]`], [id, ""]])
    const graph = await buildRetrievalGraph("/project")
    expect([...graph.nodes.get("origin")!.outLinks]).toEqual([id])
    expect([...graph.nodes.get(id)!.inLinks]).toEqual(["origin"])
  })

  it.each([
    ["Page 00042", "page-00042"],
    ["page-00042", "Page 00042"],
  ])("keeps exact IDs ahead of aliases with %j first", async (first, second) => {
    mockPages([[first, ""], [second, ""], ["origin", `[[${second}]]`]])
    const graph = await buildRetrievalGraph("/project")
    expect([...graph.nodes.get("origin")!.outLinks]).toEqual([second])
    expect(graph.nodes.get(first)!.inLinks.size).toBe(0)
  })

  it.each([
    ["Page 00042", "page-00042"],
    ["page-00042", "Page 00042"],
  ])("keeps the first alias match when %j precedes %j", async (first, second) => {
    mockPages([[first, ""], [second, ""], ["origin", "[[PAGE 00042]]"]])
    const graph = await buildRetrievalGraph("/project")
    expect([...graph.nodes.get("origin")!.outLinks]).toEqual([first])
    expect(graph.nodes.get(second)!.inLinks.size).toBe(0)
  })

  it("deduplicates aliases and ignores missing targets and self-links", async () => {
    mockPages([
      ["origin", "[[  Page 00042 |label]] [[PAGE-00042]] [[missing]] [[ORIGIN]]"],
      ["page-00042", "[[Page 00042]]"],
    ])
    const graph = await buildRetrievalGraph("/project")
    expect([...graph.nodes.get("origin")!.outLinks]).toEqual(["page-00042"])
    expect([...graph.nodes.get("page-00042")!.inLinks]).toEqual(["origin"])
    expect(graph.nodes.get("page-00042")!.outLinks.size).toBe(0)
  })

  it("does not fall through to another colliding ID after resolving a self-link", async () => {
    mockPages([["Page 00042", "[[PAGE 00042]]"], ["page-00042", ""]])
    const graph = await buildRetrievalGraph("/project")
    expect(graph.nodes.get("Page 00042")!.outLinks.size).toBe(0)
    expect(graph.nodes.get("page-00042")!.inLinks.size).toBe(0)
  })

  it("indexes only successfully read pages", async () => {
    mockPages([
      ["Page 00042", new Error("unreadable")],
      ["page-00042", ""],
      ["origin", "[[PAGE 00042]]"],
    ])
    const graph = await buildRetrievalGraph("/project")
    expect(graph.nodes.has("Page 00042")).toBe(false)
    expect([...graph.nodes.get("origin")!.outLinks]).toEqual(["page-00042"])
  })

  it("reuses a cached graph and rebuilds aliases on version changes and cache clears", async () => {
    mockPages([["origin", "[[PAGE 00042]]"], ["Page 00042", ""]])
    const first = await buildRetrievalGraph("/project", 1)
    expect([...first.nodes.get("origin")!.outLinks]).toEqual(["Page 00042"])
    expect(await buildRetrievalGraph("/project", 1)).toBe(first)
    expect(listDirectory).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledTimes(2)

    mockPages([["origin", "[[PAGE 00042]]"], ["page-00042", ""]])
    const second = await buildRetrievalGraph("/project", 2)
    expect([...second.nodes.get("origin")!.outLinks]).toEqual(["page-00042"])
    expect(second.nodes.has("Page 00042")).toBe(false)

    mockPages([["origin", "[[PAGE 00042]]"]])
    clearGraphCache()
    const third = await buildRetrievalGraph("/project", 2)
    expect(third.nodes.get("origin")!.outLinks.size).toBe(0)
  })

  it("matches the legacy resolver across collision orders and mixed targets", async () => {
    const ids = ["Page Name", "page-name", "PAGE NAME", "page\tname", "ÉTUDE 中", "étude-中", "", "__proto__"]
    for (let offset = 0; offset < ids.length; offset++) {
      const ordered = [...ids.slice(offset), ...ids.slice(0, offset)]
      for (const order of [ordered, [...ordered].reverse()]) {
        const nodeIds = new Set(["origin", ...order])
        const targets = [
          ...order.flatMap((id) => [id || " ", id.toUpperCase() || " ", id.replace(/[\s-]+/g, "  ") || " "]),
          "Page\u00a0Name", "missing", "ORIGIN", "__PROTO__", "toString",
        ]
        const expected = new Set<string>()
        for (const target of targets) {
          const id = legacyResolve(target.trim(), nodeIds)
          if (id !== null && id !== "origin") expected.add(id)
        }
        clearGraphCache()
        mockPages([
          ["origin", targets.map((target) => `[[${target}]]`).join(" ")],
          ...order.map((id): [string, string] => [id, ""]),
        ])
        const graph = await buildRetrievalGraph("/project")
        expect([...graph.nodes.get("origin")!.outLinks]).toEqual([...expected])
        for (const id of order) {
          expect([...graph.nodes.get(id)!.inLinks]).toEqual(expected.has(id) ? ["origin"] : [])
        }
      }
    }
  })

  it.each(["alias", "missing"])("uses a linear normalization budget for %s links", async (mode) => {
    const n = 128
    const linksPerPage = 8
    const ids = Array.from({ length: n }, (_, i) => `page-${i}`)
    mockPages(ids.map((id, i) => [id, Array.from({ length: linksPerPage }, (_, j) => {
      const target = (i + j + 1) % n
      return `[[${mode === "alias" ? "Page" : "Missing"} ${target}]]`
    }).join(" ")]))

    // Count work, not elapsed time: a per-edge scan exceeds this by orders of magnitude.
    const lowerCase = vi.spyOn(String.prototype, "toLowerCase")
    const graph = await buildRetrievalGraph("/project")
    const normalizations = lowerCase.mock.calls.length
    lowerCase.mockRestore()
    expect(normalizations).toBeLessThanOrEqual(2 * (n + n * linksPerPage))
    expect(graph.nodes.size).toBe(n)
    for (const node of graph.nodes.values()) {
      expect(node.outLinks.size).toBe(mode === "alias" ? linksPerPage : 0)
    }
  })
})
