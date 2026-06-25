import { describe, it, expect } from "vitest"
import { chunkIndexByEntries, parsePrematchOutput } from "./index-chunker"

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
