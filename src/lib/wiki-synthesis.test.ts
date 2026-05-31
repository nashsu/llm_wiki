import { describe, expect, it, vi, beforeEach } from "vitest"
import { runWikiSynthesis } from "./wiki-synthesis"

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tree: [] as unknown[],
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const val = fsMock.files.get(path)
    if (val === undefined) throw new Error(`missing: ${path}`)
    return val
  }),
  listDirectory: vi.fn(async () => fsMock.tree),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsMock.files.set(path, content)
  }),
  createDirectory: vi.fn(async () => {}),
}))

vi.mock("@/lib/frontmatter", () => ({
  parseFrontmatter: vi.fn((content: string) => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return { frontmatter: null, body: content, rawBlock: "" }
    const yaml = match[1]
    const body = match[2]
    const fm: Record<string, string | string[]> = {}
    for (const line of yaml.split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (m) {
        const key = m[1]
        let val: string | string[] = m[2].trim()
        if (val.startsWith("[") && val.endsWith("]")) {
          val = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
        } else {
          val = val.replace(/^"|"$/g, "")
        }
        fm[key] = val
      }
    }
    return { frontmatter: fm, body, rawBlock: match[0] }
  }),
}))

vi.mock("@/lib/output-language", () => ({
  buildLanguageDirective: vi.fn(() => "Respond in the same language as the input."),
}))

const streamChatMock = vi.fn(async (
  _config: unknown,
  _messages: unknown[],
  handlers: { onToken: (t: string) => void; onDone: () => void; onError?: (e: unknown) => void },
) => {
  handlers.onToken("---\ntype: synthesis\ntitle: Test Synthesis\n---\n\n# Test Synthesis\n\n## Research Question\n\nWhat connects these concepts?\n\n## Key Findings\n\n- Finding 1\n- Finding 2\n")
  handlers.onDone()
})

vi.mock("@/lib/llm-client", () => ({
  streamChat: (config: unknown, messages: unknown[], handlers: unknown) => streamChatMock(config, messages, handlers),
}))

const webSearchMock = vi.fn(async () => [
  { title: "External Source", snippet: "Relevant info", url: "https://example.com", source: "exa" },
])

vi.mock("@/lib/web-search", () => ({
  webSearch: (query: unknown, config: unknown, limit: unknown) => webSearchMock(query, config, limit),
}))

/** Helper: create a cluster of N wiki concept pages with the given tag. */
function makeCluster(tree: Array<{ name: string; path: string; is_dir: boolean }>, tag: string, count: number) {
  for (let i = 0; i < count; i++) {
    const path = `/project/wiki/p${i}.md`
    tree.push({ name: `p${i}.md`, path, is_dir: false })
    fsMock.files.set(path,
      `---\ntype: concept\ntitle: Page ${i}\ntags: [${tag}]\n---\n\n# Page ${i}\n\n## Definition\n\nConcept ${i}\n\n## Key Points\n\n- Point\n`,
    )
  }
}

describe("runWikiSynthesis", () => {
  beforeEach(() => {
    fsMock.files.clear()
    fsMock.tree = []
    vi.clearAllMocks()
    // Reset streamChat to default behavior
    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onToken("---\ntype: synthesis\ntitle: Test Synthesis\n---\n\n# Test\n\n## Research Question\n\nQ?\n\n## Key Findings\n\n- F1\n")
      h.onDone()
    })
  })

  it("returns error when no concept/entity pages exist", async () => {
    fsMock.tree = []
    const result = await runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("No concept/entity")
  })

  it("returns error when no cluster meets minimum size", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [
      { name: "a.md", path: "/project/wiki/a.md", is_dir: false },
    ]}]
    fsMock.files.set("/project/wiki/a.md", '---\ntype: concept\ntitle: A\ntags: [ml]\n---\n\n# A\n\nContent')
    const result = await runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never, undefined, 3)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("No tag clusters")
  })

  it("generates synthesis when cluster is large enough", async () => {
    const children: Array<{ name: string; path: string; is_dir: boolean }> = []
    makeCluster(children, "ai", 4)
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children }]

    const result = await runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never, undefined, 3)
    expect(result.ok).toBe(true)
    expect(result.topic).toBeTruthy()
    expect(result.clusterSize).toBeGreaterThanOrEqual(3)
    expect(result.synthesisPath).toContain("synthesis")
  })

  it("throws when streamChat reports an error", async () => {
    const children: Array<{ name: string; path: string; is_dir: boolean }> = []
    makeCluster(children, "ml", 4)
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children }]

    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onError?.(new Error("LLM rate limited"))
    })

    await expect(
      runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never, undefined, 3),
    ).rejects.toThrow("LLM rate limited")
  })

  it("continues when external search fails", async () => {
    const children: Array<{ name: string; path: string; is_dir: boolean }> = []
    makeCluster(children, "deep-learning", 4)
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children }]

    webSearchMock.mockRejectedValueOnce(new Error("EXA API down"))

    const result = await runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never, undefined, 3)
    expect(result.ok).toBe(true)
    expect(result.externalSources).toBe(0)
  })

  it("returns error when LLM returns empty response", async () => {
    const children: Array<{ name: string; path: string; is_dir: boolean }> = []
    makeCluster(children, "nlp", 4)
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children }]

    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onDone()
    })

    const result = await runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never, undefined, 3)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("empty")
  })

  it("returns error when LLM output lacks synthesis frontmatter", async () => {
    const children: Array<{ name: string; path: string; is_dir: boolean }> = []
    makeCluster(children, "cv", 4)
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children }]

    streamChatMock.mockImplementation(async (_c, _m, h) => {
      h.onToken("# Just a plain markdown response\n\nNo frontmatter here.")
      h.onDone()
    })

    const result = await runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never, undefined, 3)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("frontmatter")
  })

  it("falls back to largest cluster when targetTag not found", async () => {
    const children: Array<{ name: string; path: string; is_dir: boolean }> = []
    makeCluster(children, "robotics", 4)
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children }]

    const result = await runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never, "nonexistent-tag", 3)
    expect(result.ok).toBe(true)
    expect(result.topic).toBe("robotics")
  })
})
