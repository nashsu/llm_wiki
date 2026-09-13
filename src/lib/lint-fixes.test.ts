import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => fsMocks)

import {
  appendWikilink,
  ensureBrokenLinkStub,
  rewriteWikilinkTarget,
  stubPageType,
  stubRelativePathFromBrokenTarget,
} from "./lint-fixes"

beforeEach(() => {
  fsMocks.createDirectory.mockReset()
  fsMocks.fileExists.mockReset()
  fsMocks.writeFile.mockReset()
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
      expect.stringContaining("title: \"Foo Bar\""),
    )
  })

  it("keeps explicit wiki subdirectories when building stub paths", () => {
    expect(stubRelativePathFromBrokenTarget("concepts/Foo Bar")).toBe("concepts/foo-bar.md")
  })

  it("writes the folder-derived type into a knowledge-folder stub", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    await ensureBrokenLinkStub("/project", "concepts/Foo Bar")

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/wiki/concepts/foo-bar.md",
      expect.stringContaining("type: concept"),
    )
  })

  it("writes the folder-derived type for entities stubs", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    await ensureBrokenLinkStub("/project", "entities/Foo Bar")

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/wiki/entities/foo-bar.md",
      expect.stringContaining("type: entity"),
    )
  })

  it("keeps type: query for single-segment stubs under queries/", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    await ensureBrokenLinkStub("/project", "Foo Bar")

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/wiki/queries/foo-bar.md",
      expect.stringContaining("type: query"),
    )
  })

  it("uses the folder name as type for unrecognized directories", async () => {
    fsMocks.fileExists.mockResolvedValue(false)

    await ensureBrokenLinkStub("/project", "standards/Foo Bar")

    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      "/project/wiki/standards/foo-bar.md",
      expect.stringContaining("type: standards"),
    )
  })
})

describe("stubPageType", () => {
  it("derives the type from a known knowledge folder", () => {
    expect(stubPageType("concepts/foo-bar.md")).toBe("concept")
  })

  it("keeps query for single-segment stubs under queries/", () => {
    expect(stubPageType("queries/foo-bar.md")).toBe("query")
  })

  it("falls back to the folder name for unrecognized directories", () => {
    expect(stubPageType("standards/foo-bar.md")).toBe("standards")
  })
})
