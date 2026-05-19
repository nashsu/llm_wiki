import { describe, it, expect } from "vitest"
import { parseAnalysisOutput } from "./analysis"

describe("parseAnalysisOutput", () => {
  it("returns manifestFound=false when no entities block is present", () => {
    const text = `## Key Entities\n- Foo\n- Bar\n\nNo machine block here.`
    const result = parseAnalysisOutput(text, 0)
    expect(result.manifestFound).toBe(false)
    expect(result.entities).toEqual([])
    expect(result.chunkIndex).toBe(0)
    expect(result.prose).toBe(text)
  })

  it("parses a single well-formed block and strips it from prose", () => {
    const text = `<entities>\n[{"name":"Foo","type":"entity"},{"name":"Bar","type":"concept"}]\n</entities>\n\n## Key Entities\nFoo is central.`
    const result = parseAnalysisOutput(text, 0)
    expect(result.manifestFound).toBe(true)
    expect(result.entities).toEqual([
      { name: "Foo", type: "entity" },
      { name: "Bar", type: "concept" },
    ])
    expect(result.prose).toBe(`## Key Entities\nFoo is central.`)
    expect(result.prose).not.toContain("<entities>")
  })

  it("preserves chunkIndex on the part", () => {
    const text = `<entities>\n[]\n</entities>\n\nprose`
    expect(parseAnalysisOutput(text, 0).chunkIndex).toBe(0)
    expect(parseAnalysisOutput(text, 3).chunkIndex).toBe(3)
  })

  it("returns parseable items when only some blocks are malformed", () => {
    const text = [
      `<entities>\n[{"name":"Good","type":"entity"}]\n</entities>`,
      `<entities>\nnot json at all\n</entities>`,
    ].join("\n\n")
    const result = parseAnalysisOutput(text, 0)
    expect(result.manifestFound).toBe(true)
    expect(result.entities).toEqual([{ name: "Good", type: "entity" }])
    // Both blocks should be stripped, even the malformed one.
    expect(result.prose).not.toContain("<entities>")
  })

  it("returns manifestFound=false when every block fails to parse", () => {
    const text = `<entities>\n{not an array}\n</entities>\n<entities>\nalso broken\n</entities>`
    const result = parseAnalysisOutput(text, 0)
    expect(result.manifestFound).toBe(false)
    expect(result.entities).toEqual([])
  })

  it("returns manifestFound=true when block is valid JSON but not an array", () => {
    // Model wrapped the payload in an object instead of an array. The block
    // existed and was valid JSON, so manifestFound=true (not a missing manifest),
    // but no items can be extracted.
    const text = `<entities>\n{"name":"Foo","type":"entity"}\n</entities>\n\nprose`
    const result = parseAnalysisOutput(text, 0)
    expect(result.manifestFound).toBe(true)
    expect(result.entities).toEqual([])
    expect(result.prose).toBe("prose")
    expect(result.prose).not.toContain("<entities>")
  })

  it("tolerates whitespace and case inside the markers", () => {
    const text = `< entities >\n  [{"name":"Foo","type":"entity"}]\n  </ entities >`
    const result = parseAnalysisOutput(text, 0)
    expect(result.manifestFound).toBe(true)
    expect(result.entities).toEqual([{ name: "Foo", type: "entity" }])
  })

  it("returns manifestFound=true with empty array when manifest is []", () => {
    // Distinct from manifestFound=false: model checked and there's nothing
    // to write. Caller should skip batch generation (no entities), not
    // fall back to legacy single-call generation.
    const text = `<entities>\n[]\n</entities>\n\nprose`
    const result = parseAnalysisOutput(text, 0)
    expect(result.manifestFound).toBe(true)
    expect(result.entities).toEqual([])
  })

  it("returns manifestFound=true with empty array when manifest is empty whitespace", () => {
    const text = `<entities>\n   \n</entities>`
    const result = parseAnalysisOutput(text, 0)
    expect(result.manifestFound).toBe(true)
    expect(result.entities).toEqual([])
  })

  it("trims whitespace in entity names", () => {
    const text = `<entities>\n[{"name":"  Padded  ","type":"entity"}]\n</entities>`
    expect(parseAnalysisOutput(text, 0).entities).toEqual([
      { name: "Padded", type: "entity" },
    ])
  })

  it("drops items with missing or invalid type", () => {
    const text = `<entities>\n[{"name":"A","type":"entity"},{"name":"B","type":"weird"},{"name":"C"}]\n</entities>`
    expect(parseAnalysisOutput(text, 0).entities).toEqual([
      { name: "A", type: "entity" },
    ])
  })

  it("drops items with empty names", () => {
    const text = `<entities>\n[{"name":"","type":"entity"},{"name":"OK","type":"concept"}]\n</entities>`
    expect(parseAnalysisOutput(text, 0).entities).toEqual([
      { name: "OK", type: "concept" },
    ])
  })

  it("prose has no leading/trailing whitespace", () => {
    const text = `\n\n<entities>\n[]\n</entities>\n\n## Section\n\n`
    expect(parseAnalysisOutput(text, 0).prose).toBe("## Section")
  })
})
