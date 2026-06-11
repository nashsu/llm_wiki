import { describe, it, expect, beforeEach, vi } from "vitest"
import type { EmbeddingConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

// Mock the embedding + turbovecdb layer so the test controls which page pairs
// come back as "related". FS is mocked; the activity store is left real.
vi.mock("./llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))
vi.mock("@/lib/embedding", () => ({
  fetchEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}))
vi.mock("@/lib/dedup-embed", () => ({
  clusterPairs: vi.fn(),
  servicePost: vi.fn(),
}))

import { runLinkSuggestions, addRelatedLink, bestLexicalSlug, buildBrokenLinkStub, resolveOrphansByEmbedding, type SlugCandidate, type LintResult } from "./lint"
import { readFile, listDirectory } from "@/commands/fs"
import { fetchEmbedding } from "@/lib/embedding"
import { servicePost } from "@/lib/dedup-embed"
import { useActivityStore } from "@/stores/activity-store"

const mockReadFile = vi.mocked(readFile)
const mockListDirectory = vi.mocked(listDirectory)
const mockFetchEmbedding = vi.mocked(fetchEmbedding)
const mockServicePost = vi.mocked(servicePost)

function node(name: string): FileNode {
  return { name, path: `/project/wiki/${name}`, is_dir: false, children: [] } as FileNode
}

function embeddingConfig(): EmbeddingConfig {
  return { enabled: true, endpoint: "http://embed", apiKey: "", model: "m" }
}

/** Return `{a, b}` from `/candidate_pairs`; empty for clear/upsert. */
function candidatePairs(pairs: { a: string; b: string }[]) {
  mockServicePost.mockImplementation(async (_url, route) =>
    (route === "/candidate_pairs" ? { pairs } : {}) as never,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useActivityStore.setState({ items: [] })
})

describe("runLinkSuggestions — fast mode", () => {
  it("suggests a link between related pages that link to neither", async () => {
    mockListDirectory.mockResolvedValue([node("a.md"), node("b.md")])
    mockReadFile.mockImplementation(async (p) =>
      p.endsWith("a.md") ? "About foxes and dens" : "About foxes and burrows",
    )
    candidatePairs([{ a: "a.md", b: "b.md" }])

    const results = await runLinkSuggestions("/project", embeddingConfig(), "http://svc", { mode: "fast" })

    expect(results).toHaveLength(1)
    expect(results[0].type).toBe("suggested-link")
    expect(results[0].page).toBe("a.md")
    expect(results[0].affectedPages).toEqual(["b.md"])
  })

  it("does NOT suggest a link that already exists (a links b)", async () => {
    mockListDirectory.mockResolvedValue([node("a.md"), node("b.md")])
    mockReadFile.mockImplementation(async (p) =>
      p.endsWith("a.md") ? "About foxes, see [[b]]" : "About foxes and burrows",
    )
    candidatePairs([{ a: "a.md", b: "b.md" }])

    const results = await runLinkSuggestions("/project", embeddingConfig(), "http://svc", { mode: "fast" })

    expect(results).toHaveLength(0)
  })

  it("does NOT suggest when the embedding endpoint is not configured (early error)", async () => {
    const results = await runLinkSuggestions(
      "/project",
      { ...embeddingConfig(), enabled: false },
      "http://svc",
      { mode: "fast" },
    )
    expect(results).toEqual([])
    const item = useActivityStore.getState().items[0]
    expect(item.status).toBe("error")
    expect(mockServicePost).not.toHaveBeenCalled()
  })
})

describe("addRelatedLink", () => {
  it("appends a new ## Related section when none exists", () => {
    const out = addRelatedLink("# Foo\n\nBody text.", "bar")
    expect(out).toContain("## Related")
    expect(out).toContain("- [[bar]]")
    expect(out.trimEnd().endsWith("- [[bar]]")).toBe(true)
  })

  it("inserts under an existing Related heading instead of duplicating it", () => {
    const content = "# Foo\n\nBody.\n\n## Related\n\n- [[baz]]\n"
    const out = addRelatedLink(content, "bar")
    expect(out.match(/## Related/g)).toHaveLength(1)
    expect(out).toContain("- [[bar]]")
    expect(out).toContain("- [[baz]]")
  })

  it("is a no-op when the page already links the target (case-insensitive)", () => {
    const content = "# Foo\n\nSee [[Bar]] for details."
    expect(addRelatedLink(content, "bar")).toBe(content)
  })
})

describe("bestLexicalSlug", () => {
  const candidates: SlugCandidate[] = [
    { basename: "transformer", shortPath: "concepts/transformer.md" },
    { basename: "attention-head", shortPath: "concepts/attention-head.md" },
    { basename: "fox-den", shortPath: "entities/fox-den.md" },
  ]

  it("matches a typo to the closest existing page", () => {
    expect(bestLexicalSlug("transformr", candidates)?.basename).toBe("transformer")
  })

  it("matches across spacing/case differences (normalized-equal wins)", () => {
    expect(bestLexicalSlug("Fox Den", candidates)?.shortPath).toBe("entities/fox-den.md")
  })

  it("returns null when nothing is close enough (avoids a wrong repoint)", () => {
    expect(bestLexicalSlug("quantum-economics", candidates)).toBeNull()
  })

  it("ignores too-short broken text", () => {
    expect(bestLexicalSlug("ai", candidates)).toBeNull()
  })
})

describe("resolveOrphansByEmbedding", () => {
  function orphan(page: string): LintResult {
    return { type: "orphan", severity: "info", page, detail: "No other pages link to this page." }
  }

  it("attaches the closest related page as the orphan's suggestedSource", async () => {
    mockListDirectory.mockResolvedValue([node("a.md"), node("b.md"), node("c.md")])
    mockReadFile.mockImplementation(async (p) => `body of ${p}`)
    // a (orphan) is near b, far from c.
    mockFetchEmbedding.mockImplementation(async (text) => {
      if (text.startsWith("a.md")) return [1, 0, 0]
      if (text.startsWith("b.md")) return [0.95, 0.05, 0]
      return [0, 1, 0] // c.md — orthogonal to a
    })

    const results = [orphan("a.md")]
    const out = await resolveOrphansByEmbedding("/project", results, embeddingConfig())

    expect(out[0].suggestedSource).toBe("b.md")
    expect(out[0].detail).toContain("[[b]]")
  })

  it("leaves a genuinely standalone orphan unconnected (below threshold)", async () => {
    mockListDirectory.mockResolvedValue([node("a.md"), node("b.md")])
    mockReadFile.mockImplementation(async (p) => `body of ${p}`)
    mockFetchEmbedding.mockImplementation(async (text) =>
      text.startsWith("a.md") ? [1, 0, 0] : [0, 1, 0],
    )

    const out = await resolveOrphansByEmbedding("/project", [orphan("a.md")], embeddingConfig())

    expect(out[0].suggestedSource).toBeUndefined()
  })

  it("no-ops when embeddings are not configured", async () => {
    const out = await resolveOrphansByEmbedding(
      "/project",
      [orphan("a.md")],
      { ...embeddingConfig(), enabled: false },
    )
    expect(out[0].suggestedSource).toBeUndefined()
    expect(mockFetchEmbedding).not.toHaveBeenCalled()
  })
})

describe("buildBrokenLinkStub", () => {
  it("places the stub beside the source page so [[X]] resolves by basename", () => {
    const stub = buildBrokenLinkStub("phandalin", "entities/jenna.md", "2026-06-10")
    expect(stub?.path).toBe("entities/phandalin.md")
    expect(stub?.content).toContain("type: entity")
    expect(stub?.content).toContain("# Phandalin")
    expect(stub?.content).toContain("[[jenna]]") // backlink to source
  })

  it("infers type: concept under the concepts/ directory", () => {
    const stub = buildBrokenLinkStub("attention", "concepts/transformer.md", "2026-06-10")
    expect(stub?.path).toBe("concepts/attention.md")
    expect(stub?.content).toContain("type: concept")
  })

  it("title-cases multi-word slugs", () => {
    const stub = buildBrokenLinkStub("fox-den", "entities/jenna.md", "2026-06-10")
    expect(stub?.content).toContain("title: Fox Den")
    expect(stub?.content).toContain("# Fox Den")
  })

  it("uses an explicit type override instead of the folder inference", () => {
    const stub = buildBrokenLinkStub("phandalin", "entities/jenna.md", "2026-06-10", "location")
    expect(stub?.content).toContain("type: location")
    expect(stub?.path).toBe("entities/phandalin.md") // stays beside the source
  })

  it("returns null when the broken text can't form a filename", () => {
    expect(buildBrokenLinkStub("   ", "entities/jenna.md", "2026-06-10")).toBeNull()
  })
})
