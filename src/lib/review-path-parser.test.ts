import { describe, expect, it } from "vitest"
import { extractFilePathFromResolvedAction } from "@/lib/review-path-parser"

describe("extractFilePathFromResolvedAction", () => {
  it("extracts a wiki path from a Created action", () => {
    expect(extractFilePathFromResolvedAction("Created: wiki/queries/some-topic.md")).toBe(
      "wiki/queries/some-topic.md",
    )
  })

  it("extracts a nested research page path", () => {
    expect(extractFilePathFromResolvedAction("Created: wiki/research/attention-mechanism.md")).toBe(
      "wiki/research/attention-mechanism.md",
    )
  })

  it("extracts a raw source path", () => {
    expect(extractFilePathFromResolvedAction("Created: raw/sources/paper.pdf.md")).toBe(
      "raw/sources/paper.pdf.md",
    )
  })

  it("returns null for actions without a file path", () => {
    expect(extractFilePathFromResolvedAction("Saved to Wiki")).toBeNull()
    expect(extractFilePathFromResolvedAction("Deleted")).toBeNull()
    expect(extractFilePathFromResolvedAction("auto-resolved")).toBeNull()
    expect(extractFilePathFromResolvedAction("llm-judged")).toBeNull()
    expect(extractFilePathFromResolvedAction("")).toBeNull()
  })

  it("stops at trailing punctuation", () => {
    expect(extractFilePathFromResolvedAction("Created: wiki/queries/foo.md.")).toBe(
      "wiki/queries/foo.md",
    )
    expect(extractFilePathFromResolvedAction("Created: wiki/queries/foo.md, plus more")).toBe(
      "wiki/queries/foo.md",
    )
  })

  it("does not match arbitrary non-md references", () => {
    expect(extractFilePathFromResolvedAction("Referenced wiki/queries/foo.txt")).toBeNull()
  })
})
