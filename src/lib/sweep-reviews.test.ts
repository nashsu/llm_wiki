import { describe, it, expect } from "vitest"
import { extractJsonObject } from "./sweep-reviews"

describe("extractJsonObject", () => {
  describe("bare JSON", () => {
    it("extracts a simple object", () => {
      expect(extractJsonObject('{"resolved":["a","b"]}')).toBe('{"resolved":["a","b"]}')
    })

    it("extracts an empty object", () => {
      expect(extractJsonObject("{}")).toBe("{}")
    })

    it("extracts JSON with empty array", () => {
      expect(extractJsonObject('{"resolved":[]}')).toBe('{"resolved":[]}')
    })

    it("preserves whitespace inside the object", () => {
      const raw = '{\n  "resolved": [\n    "id-1"\n  ]\n}'
      expect(extractJsonObject(raw)).toBe(raw)
    })
  })

  describe("markdown fences", () => {
    it("strips ```json ... ``` multi-line fence", () => {
      const raw = '```json\n{"resolved":["a"]}\n```'
      expect(extractJsonObject(raw)).toBe('{"resolved":["a"]}')
    })

    it("strips bare ``` ... ``` multi-line fence", () => {
      const raw = '```\n{"resolved":["a"]}\n```'
      expect(extractJsonObject(raw)).toBe('{"resolved":["a"]}')
    })

    it("strips single-line ```json {...}``` fence", () => {
      const raw = '```json {"resolved":["x"]}```'
      expect(extractJsonObject(raw)).toBe('{"resolved":["x"]}')
    })

    it("handles fences with surrounding whitespace", () => {
      const raw = '  \n  ```json\n{"resolved":[]}\n```  \n  '
      expect(extractJsonObject(raw)).toBe('{"resolved":[]}')
    })

    it("is case-insensitive on the 'json' language tag", () => {
      const raw = "```JSON\n{}\n```"
      expect(extractJsonObject(raw)).toBe("{}")
    })
  })

  describe("prose-wrapped JSON", () => {
    it("finds JSON at the end of prose", () => {
      const raw = 'Here is the answer: {"resolved":["a"]}'
      expect(extractJsonObject(raw)).toBe('{"resolved":["a"]}')
    })

    it("returns the FIRST balanced object when prose has other braces before", () => {
      // First balanced {...} is the prose one — expected behavior,
      // callers then try JSON.parse and fall back on failure.
      const raw = 'An example: {maybe like this}. Real answer: {"resolved":["a"]}'
      const result = extractJsonObject(raw)
      expect(result).toBe("{maybe like this}")
    })

    it("handles JSON with nested objects", () => {
      const raw = '{"outer":{"inner":[1,2,3]}}'
      expect(extractJsonObject(raw)).toBe(raw)
    })
  })

  describe("string / escape handling", () => {
    it("ignores braces inside string values", () => {
      const raw = '{"note":"this { has } braces"}'
      expect(extractJsonObject(raw)).toBe(raw)
    })

    it("handles escaped quotes inside strings", () => {
      const raw = '{"q":"she said \\"hi\\""}'
      expect(extractJsonObject(raw)).toBe(raw)
    })

    it("handles escaped backslash", () => {
      const raw = '{"path":"C:\\\\foo"}'
      expect(extractJsonObject(raw)).toBe(raw)
    })
  })

  describe("malformed input", () => {
    it("returns empty string for no JSON at all", () => {
      expect(extractJsonObject("no json here")).toBe("")
    })

    it("returns empty string for empty input", () => {
      expect(extractJsonObject("")).toBe("")
    })

    it("returns empty string for whitespace-only input", () => {
      expect(extractJsonObject("   \n  \t  ")).toBe("")
    })

    it("returns empty string for unclosed object", () => {
      expect(extractJsonObject('{"resolved":')).toBe("")
    })

    it("returns empty string when only opening brace", () => {
      expect(extractJsonObject("{")).toBe("")
    })

    it("handles a fence with no inner JSON", () => {
      expect(extractJsonObject("```json\n```")).toBe("")
    })
  })

  describe("realistic LLM responses", () => {
    it("parses the expected fenced output from our prompt", () => {
      const raw = '```json\n{"resolved": ["review-1", "review-5"]}\n```'
      const extracted = extractJsonObject(raw)
      expect(JSON.parse(extracted)).toEqual({ resolved: ["review-1", "review-5"] })
    })

    it("parses a bare response with no fence", () => {
      const raw = '{"resolved": []}'
      expect(JSON.parse(extractJsonObject(raw))).toEqual({ resolved: [] })
    })

    it("survives a chatty preamble", () => {
      const raw = 'I analyzed the reviews. Final answer:\n\n{"resolved": ["abc"]}'
      expect(JSON.parse(extractJsonObject(raw))).toEqual({ resolved: ["abc"] })
    })
  })
})
