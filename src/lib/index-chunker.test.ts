import { describe, it, expect } from "vitest"
import { chunkIndexByEntries } from "./index-chunker"

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
