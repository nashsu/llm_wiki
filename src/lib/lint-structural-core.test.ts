import { describe, expect, it } from "vitest"
import { computeStructuralLint, type StructuralLintPage } from "./lint-structural-core"

function page(index: number, total: number): StructuralLintPage {
  return {
    shortName: `entities/page-${index}.md`,
    slug: `entities/page-${index}`,
    title: `Page ${index}`,
    outlinks: index + 1 < total ? [`entities/page-${index + 1}`] : ["entities/page-0"],
    tokens: ["shared", `topic-${index}`],
  }
}

describe("computeStructuralLint", () => {
  it("finds typo candidates without scanning unrelated page names", () => {
    const pages = [
      { ...page(0, 2), shortName: "transformer.md", slug: "transformer", title: "Transformer", outlinks: [] },
      { ...page(1, 2), shortName: "attention.md", slug: "attention", title: "Attention", outlinks: ["transfomer"] },
    ]
    const broken = computeStructuralLint(pages).find((finding) => finding.type === "broken-link")
    expect(broken?.suggestedTarget).toBe("transformer.md")
  })

  it("handles 5,000 pages without quadratic candidate expansion", () => {
    const pages = Array.from({ length: 5_000 }, (_, index) => page(index, 5_000))
    const started = performance.now()
    const findings = computeStructuralLint(pages)
    const elapsed = performance.now() - started

    expect(findings).toEqual([])
    // A generous ceiling catches accidental restoration of the old all-pairs
    // scan while remaining stable on slower CI runners.
    expect(elapsed).toBeLessThan(5_000)
  })
})
