import { describe, expect, it, vi, beforeEach } from "vitest"
import { normalizeConceptSlug, isLowQualitySource, findExistingPageByNormalizedSlug } from "./ingest"

const fsMock = vi.hoisted(() => ({
  directories: new Map<string, Array<{ name: string; path: string; is_dir: boolean }>>(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async (path: string) => {
    const entries = fsMock.directories.get(path)
    if (!entries) throw new Error(`Directory not found: ${path}`)
    return entries
  }),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

describe("normalizeConceptSlug", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(normalizeConceptSlug("Transformer Model")).toBe("transformer-model")
  })

  it("collapses consecutive hyphens", () => {
    expect(normalizeConceptSlug("foo--bar---baz")).toBe("foo-bar-baz")
  })

  it("strips leading and trailing hyphens", () => {
    expect(normalizeConceptSlug("-hello-")).toBe("hello")
  })

  it("strips leading articles", () => {
    expect(normalizeConceptSlug("the-transformer")).toBe("transformer")
    expect(normalizeConceptSlug("a-neural-network")).toBe("neural-network")
    expect(normalizeConceptSlug("an-attention-mechanism")).toBe("attention-mechanism")
  })

  it("replaces special characters with hyphens", () => {
    expect(normalizeConceptSlug("C++ Programming")).toBe("c-programming")
    expect(normalizeConceptSlug("foo.bar/baz")).toBe("foo-bar-baz")
  })

  it("handles empty string", () => {
    expect(normalizeConceptSlug("")).toBe("")
  })

  it("handles pure Chinese characters", () => {
    // Chinese chars become hyphens (non a-z0-9), then collapsed
    expect(normalizeConceptSlug("注意力机制")).toBe("")
  })

  it("handles mixed English and Chinese", () => {
    expect(normalizeConceptSlug("GPT模型")).toBe("gpt")
  })
})

describe("isLowQualitySource", () => {
  it("skips very short content", () => {
    const result = isLowQualitySource("article.md", "Hi")
    expect(result.skip).toBe(true)
    expect(result.reason).toContain("too short")
  })

  it("skips placeholder file names", () => {
    for (const name of ["readme.md", "index.md", "toc.md", "untitled.md"]) {
      const result = isLowQualitySource(name, "Some content that is long enough to pass the length check.")
      expect(result.skip).toBe(true)
      expect(result.reason).toContain("Placeholder")
    }
  })

  it("skips TOC/navigation pages with high link density", () => {
    const toc = [
      "[Link 1](http://a.com)",
      "[Link 2](http://b.com)",
      "[Link 3](http://c.com)",
      "[Link 4](http://d.com)",
      "Some plain text line",
    ].join("\n")
    const result = isLowQualitySource("navigation.md", toc)
    expect(result.skip).toBe(true)
    expect(result.reason).toContain("TOC")
  })

  it("passes normal content", () => {
    const content = "This is a real article with enough content to pass all quality checks. It has multiple paragraphs and meaningful text.".repeat(2)
    const result = isLowQualitySource("transformer-architecture.md", content)
    expect(result.skip).toBe(false)
  })

  it("passes content with low link density", () => {
    const content = [
      "This is a paragraph with a [link](http://example.com).",
      "Another paragraph of text.",
      "Yet another paragraph with content.",
      "Final paragraph to make it long enough.",
    ].join("\n")
    const result = isLowQualitySource("article.md", content)
    expect(result.skip).toBe(false)
  })
})

describe("findExistingPageByNormalizedSlug", () => {
  beforeEach(() => {
    fsMock.directories.clear()
  })

  it("returns null for non-concept/non-entity paths", async () => {
    const result = await findExistingPageByNormalizedSlug("/project", "wiki/sources/something.md")
    expect(result).toBeNull()
  })

  it("returns null when directory doesn't exist", async () => {
    const result = await findExistingPageByNormalizedSlug("/project", "wiki/concepts/new-page.md")
    expect(result).toBeNull()
  })

  it("finds exact match in concepts", async () => {
    fsMock.directories.set("/project/wiki/concepts", [
      { name: "transformer.md", path: "/project/wiki/concepts/transformer.md", is_dir: false },
    ])
    const result = await findExistingPageByNormalizedSlug("/project", "wiki/concepts/transformer.md")
    expect(result).toBe("wiki/concepts/transformer.md")
  })

  it("finds case-insensitive match", async () => {
    fsMock.directories.set("/project/wiki/concepts", [
      { name: "Transformer.md", path: "/project/wiki/concepts/Transformer.md", is_dir: false },
    ])
    const result = await findExistingPageByNormalizedSlug("/project", "wiki/concepts/transformer.md")
    expect(result).toBe("wiki/concepts/Transformer.md")
  })

  it("finds match after normalization", async () => {
    fsMock.directories.set("/project/wiki/entities", [
      { name: "gpt-4.md", path: "/project/wiki/entities/gpt-4.md", is_dir: false },
    ])
    // "GPT 4" normalizes to "gpt-4" which matches
    const result = await findExistingPageByNormalizedSlug("/project", "wiki/entities/GPT 4.md")
    expect(result).toBe("wiki/entities/gpt-4.md")
  })

  it("returns null when no match found", async () => {
    fsMock.directories.set("/project/wiki/concepts", [
      { name: "attention.md", path: "/project/wiki/concepts/attention.md", is_dir: false },
    ])
    const result = await findExistingPageByNormalizedSlug("/project", "wiki/concepts/transformer.md")
    expect(result).toBeNull()
  })

  it("returns null for very short normalized slugs", async () => {
    fsMock.directories.set("/project/wiki/concepts", [
      { name: "ai.md", path: "/project/wiki/concepts/ai.md", is_dir: false },
    ])
    // "AI" normalizes to "ai" which is length 2 (< 3), so null
    const result = await findExistingPageByNormalizedSlug("/project", "wiki/concepts/AI.md")
    expect(result).toBeNull()
  })

  it("checks both concepts and entities directories", async () => {
    fsMock.directories.set("/project/wiki/concepts", [])
    fsMock.directories.set("/project/wiki/entities", [
      { name: "openai.md", path: "/project/wiki/entities/openai.md", is_dir: false },
    ])
    const result = await findExistingPageByNormalizedSlug("/project", "wiki/concepts/openai.md")
    expect(result).toBe("wiki/entities/openai.md")
  })
})
