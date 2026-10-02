import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)

import {
  appendWikilink,
  ensureBrokenLinkStub,
  inferStubType,
  rewriteWikilinkTarget,
  stubRelativePathFromBrokenTarget,
} from "./lint-fixes"
import { parseWikiSchemaRouting, validateWikiPageRouting } from "./wiki-schema"

/** A schema declaring both a built-in and a custom directory. */
const SCHEMA = [
  "# Schema",
  "",
  "## Page Types",
  "",
  "| Type | Directory |",
  "| --- | --- |",
  "| concept | wiki/concepts |",
  "| playbook | wiki/playbooks |",
  "",
].join("\n")

beforeEach(() => {
  fsMocks.createDirectory.mockReset()
  fsMocks.fileExists.mockReset()
  fsMocks.writeFile.mockReset()
  fsMocks.readFile.mockReset()
  // No schema by default, matching a project that has not written one.
  fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
})

describe("rewriteWikilinkTarget", () => {
  it("rewrites a matching wikilink and preserves aliases", () => {
    const out = rewriteWikilinkTarget(
      "See [[transfomer|the Transformer page]] and [[attention]].",
      "transfomer",
      "entities/transformer.md",
    )

    expect(out).toBe("See [[entities/transformer|the Transformer page]] and [[attention]].")
  })

  it("leaves non-matching wikilinks byte-identical", () => {
    const input = "See [[attention|Attention]] only."
    expect(rewriteWikilinkTarget(input, "transformer", "entities/transformer.md")).toBe(input)
  })
})

describe("appendWikilink", () => {
  it("does not duplicate an existing aliased wikilink", () => {
    const input = "See [[entities/transformer|Transformer]]."
    expect(appendWikilink(input, "entities/transformer.md")).toBe(input)
  })

  it("appends a related section when the target is absent", () => {
    expect(appendWikilink("# Page\nBody", "entities/transformer.md")).toBe(
      "# Page\nBody\n\n## Related\n- [[entities/transformer]]\n",
    )
  })

  it("adds to an existing related section without duplicating the heading", () => {
    const out = appendWikilink(
      "# Page\n\n## Related\n- [[entities/attention]]\n",
      "entities/transformer.md",
    )

    expect(out.match(/^## Related$/gm)).toHaveLength(1)
    expect(out).toContain("## Related\n- [[entities/transformer]]\n- [[entities/attention]]")
  })
})

describe("ensureBrokenLinkStub", () => {
  it("reuses an existing slugified target instead of overwriting it", async () => {
    fsMocks.fileExists.mockResolvedValue(true)

    const result = await ensureBrokenLinkStub("/project", "Foo Bar")

    expect(result).toEqual({
      fullPath: "/project/wiki/queries/foo-bar.md",
      relativePath: "queries/foo-bar.md",
      created: false,
    })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("creates a safe stub path when no target exists", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    const result = await ensureBrokenLinkStub("/project", "Foo Bar")

    expect(result.relativePath).toBe("queries/foo-bar.md")
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("/project/wiki/queries")
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/wiki/queries/foo-bar.md",
      expect.stringContaining("type: query\ntitle: \"Foo Bar\""),
    )
  })

  it("uses the destination folder type for explicit knowledge paths", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    await ensureBrokenLinkStub("/project", "concepts/Clash Detection")

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/wiki/concepts/clash-detection.md",
      expect.stringContaining("type: concept\ntitle: \"Clash Detection\""),
    )
  })

  it("singularizes known schema folders when creating stubs", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    await ensureBrokenLinkStub("/project", "standards/Release Gate")

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/wiki/standards/release-gate.md",
      expect.stringContaining("type: standard\ntitle: \"Release Gate\""),
    )
  })

  it("keeps explicit wiki subdirectories when building stub paths", () => {
    expect(stubRelativePathFromBrokenTarget("concepts/Foo Bar")).toBe("concepts/foo-bar.md")
  })
})

describe("inferStubType", () => {
  it("derives the type from a built-in folder instead of hard-coding query (#733)", () => {
    expect(inferStubType("concepts/foo.md", null)).toBe("concept")
    expect(inferStubType("entities/foo.md", null)).toBe("entity")
    expect(inferStubType("sources/foo.md", null)).toBe("source")
    expect(inferStubType("findings/foo.md", null)).toBe("finding")
    expect(inferStubType("standards/foo.md", null)).toBe("standard")
    expect(inferStubType("comparisons/foo.md", null)).toBe("comparison")
  })

  it("keeps query for the queries folder", () => {
    expect(inferStubType("queries/foo.md", null)).toBe("query")
  })

  it("prefers the project schema, which is what routing validates against", () => {
    const routing = parseWikiSchemaRouting(SCHEMA)

    expect(inferStubType("concepts/foo.md", routing)).toBe("concept")
    // The built-in map does not know this directory and would answer
    // "playbooks" — the plural would still fail routing's exact match.
    expect(inferStubType("playbooks/foo.md", routing)).toBe("playbook")
  })

  it("falls back to the built-in map for folders the schema omits", () => {
    const routing = parseWikiSchemaRouting(SCHEMA)
    expect(inferStubType("entities/foo.md", routing)).toBe("entity")
  })

  it("falls back to the built-in map when the schema omits the wiki/ prefix", () => {
    // `parseWikiSchemaRouting` drops any directory that is not `wiki`
    // or `wiki/…`, so such an entry never reaches the lookup and the
    // built-in map answers instead.
    const routing = parseWikiSchemaRouting(
      ["## Page Types", "| standard | concepts |"].join("\n"),
    )
    expect(routing.typeDirs).toEqual({})
    expect(inferStubType("concepts/foo.md", routing)).toBe("concept")
  })
})

describe("ensureBrokenLinkStub frontmatter type", () => {
  function writtenContent(): string {
    return fsMocks.writeFile.mock.calls[0][1] as string
  }

  it("does not write a query stub into a knowledge folder", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    await ensureBrokenLinkStub("/project", "concepts/Foo Bar")

    expect(writtenContent()).toContain("type: concept")
    expect(writtenContent()).not.toContain("type: query")
  })

  it("uses the schema's type for a custom folder", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockResolvedValue(SCHEMA)

    await ensureBrokenLinkStub("/project", "playbooks/Foo Bar")

    expect(fsMocks.readFile).toHaveBeenCalledWith("/project/schema.md")
    expect(writtenContent()).toContain("type: playbook")
  })

  it("still writes query for the queries folder", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    await ensureBrokenLinkStub("/project", "Foo Bar")

    expect(writtenContent()).toContain("type: query")
  })

  it("does not read the schema when the stub already exists", async () => {
    fsMocks.fileExists.mockResolvedValue(true)

    await ensureBrokenLinkStub("/project", "concepts/Foo Bar")

    expect(fsMocks.readFile).not.toHaveBeenCalled()
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("produces frontmatter that passes schema routing", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockResolvedValue(SCHEMA)

    await ensureBrokenLinkStub("/project", "concepts/Foo Bar")

    const content = writtenContent()
    expect(validateWikiPageRouting("wiki/concepts/foo-bar.md", content, parseWikiSchemaRouting(SCHEMA)))
      .toBeNull()
  })
})
