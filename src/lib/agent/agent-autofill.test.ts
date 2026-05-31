import { describe, expect, it, vi, beforeEach } from "vitest"
import { runAutofill } from "./agent-autofill"

const fsMock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  tree: [] as unknown[],
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const value = fsMock.files.get(path)
    if (value === undefined) throw new Error(`missing file: ${path}`)
    return value
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
    const frontmatter: Record<string, string | string[]> = {}
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
        frontmatter[key] = val
      }
    }
    return { frontmatter, body, rawBlock: match[0] }
  }),
}))

describe("runAutofill", () => {
  beforeEach(() => {
    fsMock.files.clear()
    fsMock.tree = []
    vi.clearAllMocks()
  })

  it("returns empty result when wiki directory is empty", async () => {
    fsMock.tree = []
    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(0)
    expect(result.statusPromoted).toBe(0)
    expect(result.tagsAssigned).toBe(0)
  })

  it("promotes Draft to Under Review when created ≥7 days ago and content is complete", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "concept.md", path: "/project/wiki/concept.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/concept.md", `---
type: concept
title: Transformer
created: ${eightDaysAgo}
tags: []
status: Draft
---

# Transformer

## Definition

A neural network architecture based on self-attention.

## Key Points

- Enables parallel processing
- Used in [[GPT]] and [[BERT]]

`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(1)
    expect(result.statusPromoted).toBe(1)
    expect(result.details[0]).toEqual({
      path: "concept",
      action: "status",
      from: "draft",
      to: "Under Review",
    })
  })

  it("promotes to Reviewed when referenced by ≥2 summaries", async () => {
    fsMock.tree = [
      { name: "wiki", path: "/project/wiki", is_dir: true, children: [
        { name: "concept.md", path: "/project/wiki/concept.md", is_dir: false },
        { name: "sources", path: "/project/wiki/sources", is_dir: true, children: [
          { name: "source-a.md", path: "/project/wiki/sources/source-a.md", is_dir: false },
          { name: "source-b.md", path: "/project/wiki/sources/source-b.md", is_dir: false },
        ]},
      ]},
    ]

    fsMock.files.set("/project/wiki/concept.md", `---
type: concept
title: Attention
created: 2026-01-01
tags: [ml]
status: Draft
---

# Attention

## Definition

A mechanism for focusing on relevant parts of input.

## Key Points

- Core of [[Transformer]]
`)

    fsMock.files.set("/project/wiki/sources/source-a.md", `---
type: source
title: Source A
---

# Source A

See [[concept]] for details.
`)

    fsMock.files.set("/project/wiki/sources/source-b.md", `---
type: source
title: Source B
---

# Source B

Based on [[concept]] research.
`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(1)
    expect(result.statusPromoted).toBe(1)
    expect(result.details[0]).toEqual({
      path: "concept",
      action: "status",
      from: "draft",
      to: "Reviewed",
    })
  })

  it("assigns tags when empty", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "entity.md", path: "/project/wiki/entity.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/entity.md", `---
type: entity
title: GPT-4
created: 2026-01-01
tags: []
---

# GPT-4

## Definition

A large language model by OpenAI.

## Key Points

- Multimodal capabilities
`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(1)
    expect(result.tagsAssigned).toBe(1)
    expect(result.details[0].action).toBe("tags")
    expect(result.details[0].from).toBe("(empty)")
  })

  it("skips pages with existing tags", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "concept.md", path: "/project/wiki/concept.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/concept.md", `---
type: concept
title: RAG
created: 2026-01-01
tags: [ai, retrieval]
---

# RAG

## Definition

Retrieval-Augmented Generation.

## Key Points

- Combines retrieval with generation
`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(1)
    expect(result.tagsAssigned).toBe(0)
  })

  it("skips non-concept/non-entity pages", async () => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true, children: [{ name: "source.md", path: "/project/wiki/source.md", is_dir: false }] }]
    fsMock.files.set("/project/wiki/source.md", `---
type: source
title: Source
created: 2026-01-01
tags: []
---

# Source

Some content.
`)

    const result = await runAutofill("/project")
    expect(result.pagesScanned).toBe(0)
  })
})
