import { describe, it, expect } from "vitest"
import {
  chunkIndexByEntries,
  parsePrematchOutput,
  assembleReducedIndex,
  buildPrematchPrompt,
  parseIndexBlocks,
  appendIndexEntries,
  type ParsedIndexBlock,
} from "./index-chunker"

describe("chunkIndexByEntries", () => {
  it("returns empty array for empty index", () => {
    expect(chunkIndexByEntries("", 50)).toEqual([])
  })

  it("returns single chunk when entries <= chunkSize", () => {
    const index = [
      "# Index",
      "",
      "## Concepts",
      "- [[attention]] — Core mechanism",
      "- [[transformer]] — Architecture",
    ].join("\n")
    const chunks = chunkIndexByEntries(index, 50)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain("[[attention]]")
    expect(chunks[0]).toContain("[[transformer]]")
    expect(chunks[0]).toContain("## Concepts")
  })

  it("splits into multiple chunks at exact boundary", () => {
    const lines: string[] = ["# Index", "", "## Concepts"]
    for (let i = 0; i < 100; i++) {
      lines.push(`- [[page-${i}]] — desc ${i}`)
    }
    const index = lines.join("\n")
    const chunks = chunkIndexByEntries(index, 50)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].match(/\[\d+\]/g)).toHaveLength(50)
    expect(chunks[1].match(/\[\d+\]/g)).toHaveLength(50)
  })

  it("preserves category headers within chunks that span categories", () => {
    const lines: string[] = ["# Index", "", "## Concepts"]
    for (let i = 0; i < 40; i++) {
      lines.push(`- [[concept-${i}]] — desc ${i}`)
    }
    lines.push("## Entities")
    for (let i = 0; i < 20; i++) {
      lines.push(`- [[entity-${i}]] — desc ${i}`)
    }
    const index = lines.join("\n")
    const chunks = chunkIndexByEntries(index, 50)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toContain("## Concepts")
    expect(chunks[0]).toContain("## Entities")
    expect(chunks[1]).toContain("## Entities")
    expect(chunks[1]).not.toContain("## Concepts")
  })

  it("numbers entries sequentially across chunks starting from 1", () => {
    const lines: string[] = ["# Index", "", "## Concepts"]
    for (let i = 0; i < 120; i++) {
      lines.push(`- [[page-${i}]] — desc ${i}`)
    }
    const index = lines.join("\n")
    const chunks = chunkIndexByEntries(index, 50)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toContain("[1]")
    expect(chunks[0]).toContain("[50]")
    expect(chunks[1]).toContain("[51]")
    expect(chunks[2]).toContain("[101]")
    expect(chunks[2]).toContain("[120]")
  })

  it("skips non-entry lines (empty lines, H1) when counting", () => {
    const index = [
      "# Index",
      "",
      "## Concepts",
      "- [[a]] — desc a",
      "",
      "- [[b]] — desc b",
      "",
      "## Papers",
      "(none yet)",
      "- [[c]] — desc c",
    ].join("\n")
    const chunks = chunkIndexByEntries(index, 2)
    expect(chunks).toHaveLength(2)
  })
})

describe("parsePrematchOutput", () => {
  it("parses bracket format with spaces", () => {
    expect(parsePrematchOutput("[3, 12, 47]")).toEqual([3, 12, 47])
  })

  it("parses bracket format without spaces", () => {
    expect(parsePrematchOutput("[3,12,47]")).toEqual([3, 12, 47])
  })

  it("parses comma-separated without brackets", () => {
    expect(parsePrematchOutput("3, 12, 47")).toEqual([3, 12, 47])
  })

  it("parses single number", () => {
    expect(parsePrematchOutput("[5]")).toEqual([5])
    expect(parsePrematchOutput("5")).toEqual([5])
  })

  it("returns empty for none variations", () => {
    expect(parsePrematchOutput("none")).toEqual([])
    expect(parsePrematchOutput("None")).toEqual([])
    expect(parsePrematchOutput("NONE")).toEqual([])
    expect(parsePrematchOutput("无")).toEqual([])
  })

  it("returns empty for empty or whitespace", () => {
    expect(parsePrematchOutput("")).toEqual([])
    expect(parsePrematchOutput("   ")).toEqual([])
  })

  it("tolerates surrounding explanation text", () => {
    expect(parsePrematchOutput("Matching items: [3, 12, 47]")).toEqual([3, 12, 47])
  })

  it("ignores non-numeric tokens", () => {
    expect(parsePrematchOutput("[3, abc, 47]")).toEqual([3, 47])
  })

  it("returns empty on complete parse failure", () => {
    expect(parsePrematchOutput("I think none match")).toEqual([])
  })

  it("deduplicates numbers", () => {
    expect(parsePrematchOutput("[3, 3, 12]")).toEqual([3, 12])
  })
})

describe("assembleReducedIndex", () => {
  it("returns empty string for empty matches", () => {
    const index = "## Concepts\n- [[a]] — desc a\n- [[b]] — desc b"
    expect(assembleReducedIndex(index, [])).toBe("")
  })

  it("returns single matched entry with its category header", () => {
    const index = [
      "# Index", "",
      "## Concepts",
      "- [[attention]] — Core mechanism",
      "- [[transformer]] — Architecture",
    ].join("\n")
    const result = assembleReducedIndex(index, [1])
    expect(result).toContain("## Concepts")
    expect(result).toContain("[[attention]]")
    expect(result).not.toContain("[[transformer]]")
  })

  it("returns multiple matches preserving original order", () => {
    const index = [
      "## Concepts",
      "- [[a]] — desc a",
      "- [[b]] — desc b",
      "- [[c]] — desc c",
    ].join("\n")
    const result = assembleReducedIndex(index, [3, 1])
    expect(result.indexOf("[[a]]")).toBeLessThan(result.indexOf("[[c]]"))
  })

  it("deduplicates category headers", () => {
    const index = [
      "## Concepts",
      "- [[a]] — desc a",
      "- [[b]] — desc b",
      "## Entities",
      "- [[c]] — desc c",
    ].join("\n")
    const result = assembleReducedIndex(index, [1, 2])
    const headerCount = (result.match(/## Concepts/g) ?? []).length
    expect(headerCount).toBe(1)
  })

  it("handles matches from different categories", () => {
    const index = [
      "## Concepts",
      "- [[a]] — desc a",
      "## Entities",
      "- [[b]] — desc b",
    ].join("\n")
    const result = assembleReducedIndex(index, [1, 2])
    expect(result).toContain("## Concepts")
    expect(result).toContain("## Entities")
    expect(result).toContain("[[a]]")
    expect(result).toContain("[[b]]")
  })

  it("ignores out-of-range numbers gracefully", () => {
    const index = "## Concepts\n- [[a]] — desc a"
    const result = assembleReducedIndex(index, [1, 999])
    expect(result).toContain("[[a]]")
  })
})

describe("buildPrematchPrompt", () => {
  it("includes source document content", () => {
    const prompt = buildPrematchPrompt("This is a source about transformers.", "## Concepts\n[1] attention — desc")
    expect(prompt).toContain("This is a source about transformers.")
  })

  it("includes the index chunk", () => {
    const chunk = "## Concepts\n[1] attention — desc\n[2] transformer — desc"
    const prompt = buildPrematchPrompt("source content", chunk)
    expect(prompt).toContain("[1] attention")
    expect(prompt).toContain("[2] transformer")
  })

  it("includes strict output format instructions", () => {
    const prompt = buildPrematchPrompt("src", "chunk")
    expect(prompt).toContain("[3, 12, 47]")
    expect(prompt).toContain("none")
    expect(prompt).toContain("STRICT")
  })
})

describe("parseIndexBlocks", () => {
  it("parses a single INDEX block", () => {
    const text = [
      "---INDEX: Concepts---",
      "rope — Rotary Position Embedding",
      "flash-attention — IO-aware attention",
      "---END INDEX---",
    ].join("\n")
    const blocks = parseIndexBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].category).toBe("Concepts")
    expect(blocks[0].entries).toEqual([
      "rope — Rotary Position Embedding",
      "flash-attention — IO-aware attention",
    ])
  })

  it("parses multiple INDEX blocks", () => {
    const text = [
      "---INDEX: Concepts---",
      "rope — desc",
      "---END INDEX---",
      "",
      "---INDEX: Entities---",
      "openai — desc",
      "---END INDEX---",
    ].join("\n")
    const blocks = parseIndexBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].category).toBe("Concepts")
    expect(blocks[1].category).toBe("Entities")
  })

  it("returns empty array when no INDEX blocks", () => {
    expect(parseIndexBlocks("no blocks here")).toEqual([])
    expect(parseIndexBlocks("")).toEqual([])
  })

  it("tolerates extra whitespace in markers", () => {
    const text = "---INDEX:   Concepts   ---\nrope — desc\n---END INDEX---"
    const blocks = parseIndexBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].category).toBe("Concepts")
  })

  it("handles empty entries", () => {
    const text = "---INDEX: Concepts---\n---END INDEX---"
    const blocks = parseIndexBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].entries).toEqual([])
  })

  it("normalizes CRLF line endings", () => {
    const text = "---INDEX: Concepts---\r\nrope — desc\r\n---END INDEX---"
    const blocks = parseIndexBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].entries).toEqual(["rope — desc"])
  })
})

describe("appendIndexEntries", () => {
  it("appends entries to existing category", () => {
    const index = [
      "# Index", "",
      "## Concepts",
      "- [[attention]] — Core mechanism",
      "- [[transformer]] — Architecture",
    ].join("\n")
    const blocks: ParsedIndexBlock[] = [
      { category: "Concepts", entries: ["rope — Rotary Position Embedding"] },
    ]
    const result = appendIndexEntries(index, blocks)
    expect(result).toContain("- [[attention]]")
    expect(result).toContain("- [[transformer]]")
    expect(result).toContain("- [[rope]] — Rotary Position Embedding")
    expect(result.indexOf("[[transformer]]")).toBeLessThan(result.indexOf("rope"))
  })

  it("creates new category if it does not exist", () => {
    const index = "## Concepts\n- [[a]] — desc"
    const blocks: ParsedIndexBlock[] = [
      { category: "Entities", entries: ["openai — AI company"] },
    ]
    const result = appendIndexEntries(index, blocks)
    expect(result).toContain("## Entities")
    expect(result).toContain("- [[openai]] — AI company")
    expect(result).toContain("## Concepts")
  })

  it("appends to multiple categories", () => {
    const index = "## Concepts\n- [[a]] — desc\n## Entities\n- [[b]] — desc"
    const blocks: ParsedIndexBlock[] = [
      { category: "Concepts", entries: ["c — desc c"] },
      { category: "Entities", entries: ["d — desc d"] },
    ]
    const result = appendIndexEntries(index, blocks)
    expect(result).toContain("- [[c]] — desc c")
    expect(result).toContain("- [[d]] — desc d")
  })

  it("handles entries that need slug format conversion", () => {
    const index = "## Concepts\n- [[a]] — desc"
    const blocks: ParsedIndexBlock[] = [
      { category: "Concepts", entries: ["rope — desc"] },
    ]
    const result = appendIndexEntries(index, blocks)
    expect(result).toContain("- [[rope]] — desc")
  })

  it("preserves entries with no description", () => {
    const index = "## Concepts\n- [[a]] — desc"
    const blocks: ParsedIndexBlock[] = [
      { category: "Concepts", entries: ["rope"] },
    ]
    const result = appendIndexEntries(index, blocks)
    expect(result).toContain("- [[rope]]")
  })

  it("handles empty blocks array", () => {
    const index = "## Concepts\n- [[a]] — desc"
    expect(appendIndexEntries(index, [])).toBe(index)
  })
})
