import { describe, it, expect } from "vitest"
import { canApplyLlmReviewResolution, extractJsonObject } from "./sweep-reviews"
import type { ReviewItem } from "@/stores/review-store"

function makeReview(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "review-1",
    type: "suggestion",
    title: "Review",
    description: "description",
    affectedPages: [],
    options: [],
    resolved: false,
    createdAt: 1,
    ...overrides,
  }
}

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

describe("canApplyLlmReviewResolution", () => {
  it("keeps an LLM-resolved suggestion pending when any affected page is missing", () => {
    const item = makeReview({
      affectedPages: [
        "wiki/concepts/self-wiki.md",
        "wiki/queries/security-guidelines-for-personal-data.md",
      ],
    })

    expect(canApplyLlmReviewResolution(item, {
      byId: new Set(["self-wiki"]),
      byTitle: new Set(),
    })).toBe(false)
  })

  it("allows an LLM-resolved suggestion only when all affected pages exist", () => {
    const item = makeReview({
      affectedPages: [
        "wiki/concepts/self-wiki.md",
        "queries/security-guidelines-for-personal-data.md",
      ],
    })

    expect(canApplyLlmReviewResolution(item, {
      byId: new Set(["self-wiki", "security-guidelines-for-personal-data"]),
      byTitle: new Set(),
    })).toBe(true)
  })

  it("never lets LLM cleanup resolve confirmation or contradiction items", () => {
    const index = { byId: new Set(["profile"]), byTitle: new Set<string>() }

    expect(canApplyLlmReviewResolution(makeReview({ type: "confirm" }), index)).toBe(false)
    expect(canApplyLlmReviewResolution(makeReview({ type: "contradiction" }), index)).toBe(false)
  })

  it("keeps a missing-page review pending until that exact target exists", () => {
    const item = makeReview({
      type: "missing-page",
      title: "Missing wiki page: dify",
      affectedPages: ["wiki/index.md"],
    })

    expect(canApplyLlmReviewResolution(item, {
      byId: new Set(["index"]),
      byTitle: new Set(["Index", "dify"]),
    })).toBe(false)
    expect(canApplyLlmReviewResolution(item, {
      byId: new Set(["index", "dify"]),
      byTitle: new Set(["Index"]),
    })).toBe(true)
  })
})
