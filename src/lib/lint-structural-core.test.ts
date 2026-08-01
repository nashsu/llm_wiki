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

  it("skips orphan/no-outlinks findings for lint-generated stub pages", () => {
    // A stub (tags: [stub, lint]) is intentionally empty and unlinked. Without
    // the exclusion it would be flagged both orphan and no-outlinks the moment
    // the "Fix broken link" action creates it.
    const pages: StructuralLintPage[] = [
      {
        shortName: "concepts/transformer.md",
        slug: "concepts/transformer",
        title: "Transformer",
        outlinks: ["queries/missing-page"],
        tokens: ["transformer"],
      },
      {
        shortName: "queries/missing-page.md",
        slug: "queries/missing-page",
        title: "Missing Page",
        outlinks: [],
        tokens: ["missing", "page"],
        isLintStub: true,
      },
    ]
    const findings = computeStructuralLint(pages)

    // The stub must not be re-flagged as orphan or no-outlinks.
    expect(findings.filter((f) => f.page === "queries/missing-page.md")).toEqual([])
    // The link from the real page to the stub still resolves (not broken).
    expect(findings.filter((f) => f.type === "broken-link")).toEqual([])
    // The real page is linked-to by nothing but links out, so it is an orphan
    // but not no-outlinks — proving the checks still run for normal pages.
    const realFindings = findings.filter((f) => f.page === "concepts/transformer.md")
    expect(realFindings.map((f) => f.type)).toEqual(["orphan"])
  })

  it("still flags an empty non-stub page as orphan and no-outlinks", () => {
    const pages: StructuralLintPage[] = [
      {
        shortName: "notes/lonely.md",
        slug: "notes/lonely",
        title: "Lonely",
        outlinks: [],
        tokens: ["lonely"],
      },
    ]
    const types = computeStructuralLint(pages).map((f) => f.type).sort()
    expect(types).toEqual(["no-outlinks", "orphan"])
  })
})
