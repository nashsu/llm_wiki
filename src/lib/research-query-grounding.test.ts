import { describe, expect, it } from "vitest"
import {
  groundBareResearchQueries,
  groundedFallbackResearchQuery,
} from "./research-query-grounding"

describe("research query grounding", () => {
  it("keeps the exact local term while adding context", () => {
    expect(groundedFallbackResearchQuery(
      "AF",
      "An attention-filter signal in the project pipeline.",
    )).toBe("AF An attention-filter signal in the project pipeline.")
  })

  it("replaces only bare topic queries", () => {
    expect(groundBareResearchQueries(
      ["AF", "AF attention filter cognitive signal"],
      "AF",
      "attention-filter signal",
    )).toEqual([
      "AF attention-filter signal",
      "AF attention filter cognitive signal",
    ])
  })

  it("preserves special characters in non-bare model queries", () => {
    expect(groundBareResearchQueries(
      ["C# async await", "snake_case naming", "F# pattern matching", "site:https://example.com AF"],
      "AF",
      "attention filter",
    )).toEqual([
      "C# async await",
      "snake_case naming",
      "F# pattern matching",
      "site:https://example.com AF",
    ])
  })

  it("normalizes wrapped bare terms and removes duplicate searches", () => {
    expect(groundBareResearchQueries(
      ["AF", "af", "[[AF]]", "\"AF\""],
      "AF",
      "attention filter",
    )).toEqual(["AF attention filter"])
  })

  it("removes prompt-shaping Markdown and URLs from fallback context", () => {
    const query = groundedFallbackResearchQuery(
      "[[Hana]]",
      "# Module `Hana` details https://example.test/private",
    )
    expect(query).toBe("Hana Module Hana details")
  })

  it("keeps CJK terms and caps long fallback context at a word boundary", () => {
    const query = groundedFallbackResearchQuery("灵犀", "context ".repeat(100))
    expect(query.startsWith("灵犀 ")).toBe(true)
    expect(Array.from(query).length).toBeLessThanOrEqual(280)
    expect(query.endsWith(" ")).toBe(false)
  })

  it("does not discard long CJK context without spaces", () => {
    const query = groundedFallbackResearchQuery("灵犀", `AI ${"中".repeat(300)}`)
    expect(Array.from(query).filter((character) => character === "中").length)
      .toBeGreaterThanOrEqual(150)
  })
})
