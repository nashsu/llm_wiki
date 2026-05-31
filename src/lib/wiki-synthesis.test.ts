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

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(async (_config: unknown, _messages: unknown[], handlers: { onToken: (t: string) => void; onDone: () => void }) => {
    handlers.onToken("---\ntype: synthesis\ntitle: Test Synthesis\n---\n\n# Test Synthesis\n\n## Research Question\n\nWhat connects these concepts?\n\n## Key Findings\n\n- Finding 1\n- Finding 2\n")
    handlers.onDone()
  }),
}))

vi.mock("@/lib/web-search", () => ({
  webSearch: vi.fn(async () => [
    { title: "External Source", snippet: "Relevant info", url: "https://example.com", source: "exa" },
  ]),
}))

describe("runWikiSynthesis", () => {
  beforeEach(() => {
    fsMock.files.clear()
    fsMock.tree = []
    vi.clearAllMocks()
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
    const children = Array.from({ length: 4 }, (_, i) => ({
      name: `page${i}.md`, path: `/project/wiki/page${i}.md`, is_dir: false,
    }))
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children }]

    for (let i = 0; i < 4; i++) {
      fsMock.files.set(`/project/wiki/page${i}.md`,
        `---\ntype: concept\ntitle: Page ${i}\ntags: [ai, ml]\n---\n\n# Page ${i}\n\n## Definition\n\nConcept ${i}\n\n## Key Points\n\n- Point about [[other]]\n`
      )
    }

    const result = await runWikiSynthesis("/project", { model: "test" } as never, { provider: "none" } as never, undefined, 3)
    expect(result.ok).toBe(true)
    expect(result.topic).toBeTruthy()
    expect(result.clusterSize).toBeGreaterThanOrEqual(3)
    expect(result.synthesisPath).toContain("synthesis")
  })
})
