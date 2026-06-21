import { describe, expect, it } from "vitest"
import type { PageCatalogEntry } from "./auto-link-types"
import {
  buildAutoLinkSuggestions,
  findCatalogMatches,
  isLikelySymbol,
  normalizeForMatch,
} from "./auto-link-candidates"

const noIgnores = { terms: [], pairs: [] }

function page(
  slug: string,
  overrides: Partial<PageCatalogEntry> = {},
): PageCatalogEntry {
  return {
    slug,
    title: slug,
    type: "concept",
    tags: [],
    path: `/project/wiki/${slug}.md`,
    ...overrides,
  }
}

describe("normalizeForMatch", () => {
  it("unwraps wikilinks and normalizes width, separators, case, and whitespace", () => {
    expect(normalizeForMatch("  [[ＧＤＦ３__Alpha-\tBeta]]  ")).toBe(
      "gdf3 alpha beta",
    )
  })

  it("normalizes full-width wikilink brackets before unwrapping", () => {
    expect(normalizeForMatch("［［ＧＤＦ３］］")).toBe("gdf3")
  })
})

describe("isLikelySymbol", () => {
  it("accepts only approved uppercase ASCII symbols", () => {
    expect(isLikelySymbol("GDF3")).toBe(true)
    expect(isLikelySymbol(" HDAC3 ")).toBe(true)

    for (const term of ["in", "A", "123", "p53", "eIF4E", "ＧＤＦ３"]) {
      expect(isLikelySymbol(term)).toBe(false)
    }
  })
})

describe("findCatalogMatches", () => {
  it("ranks a unique exact slug as High", () => {
    expect(
      findCatalogMatches("GDF3", [
        page("gdf3", { title: "Growth differentiation factor 3" }),
      ]),
    ).toEqual([
      expect.objectContaining({
        target: "gdf3",
        band: "high",
        matchKind: "slug-exact",
      }),
    ])
  })

  it("ranks exact title and tag matches as High", () => {
    expect(
      findCatalogMatches("Neural Crest", [
        page("neural-crest-development", { title: "Neural Crest" }),
      ]),
    ).toEqual([
      expect.objectContaining({
        target: "neural-crest-development",
        band: "high",
        matchKind: "title-exact",
      }),
    ])

    expect(
      findCatalogMatches("epigenetics", [
        page("chromatin-remodeling", { tags: ["Epigenetics"] }),
      ]),
    ).toEqual([
      expect.objectContaining({
        target: "chromatin-remodeling",
        band: "high",
        matchKind: "tag-exact",
      }),
    ])
  })

  it("promotes one literal cross-language title match to High", () => {
    expect(
      findCatalogMatches("肠肾轴", [
        page("gut-kidney-axis", { title: "肠肾轴 (Gut-Kidney Axis)" }),
      ]),
    ).toEqual([
      expect.objectContaining({
        target: "gut-kidney-axis",
        band: "high",
        matchKind: "cross-language-unique",
      }),
    ])
  })

  it("keeps full-width wrapped cross-language terms eligible for High", () => {
    expect(
      findCatalogMatches("［［肠肾轴］］", [
        page("gut-kidney-axis", { title: "肠肾轴 (Gut-Kidney Axis)" }),
      ]),
    ).toEqual([
      expect.objectContaining({
        target: "gut-kidney-axis",
        band: "high",
        matchKind: "cross-language-unique",
      }),
    ])
  })

  it("downgrades multiple literal cross-language candidates to Medium", () => {
    const catalog = [
      page("gut-kidney-axis", { title: "肠肾轴 (Gut-Kidney Axis)" }),
      page("intestinal-renal-signaling", { tags: ["肠肾轴"] }),
    ]

    expect(findCatalogMatches("肠肾轴", catalog)).toEqual([
      expect.objectContaining({
        target: "gut-kidney-axis",
        band: "medium",
        matchKind: "ambiguous-strong",
      }),
      expect.objectContaining({
        target: "intestinal-renal-signaling",
        band: "medium",
        matchKind: "ambiguous-strong",
      }),
    ])

    expect(
      buildAutoLinkSuggestions(
        [{ term: "肠肾轴", target: "invented" }],
        catalog,
        noIgnores,
      )[0],
    ).toMatchObject({ band: "medium", selectedByDefault: false })
  })

  it("promotes one symbol substring match and downgrades two", () => {
    const first = page("hdac3-macrophages", {
      title: "HDAC3 in macrophage activation",
    })

    expect(findCatalogMatches("HDAC3", [first])).toEqual([
      expect.objectContaining({
        target: "hdac3-macrophages",
        band: "high",
        matchKind: "symbol-unique",
      }),
    ])

    expect(
      findCatalogMatches("HDAC3", [
        first,
        page("histone-deacetylation", { tags: ["HDAC3"] }),
      ]),
    ).toEqual([
      expect.objectContaining({
        target: "hdac3-macrophages",
        band: "medium",
        matchKind: "ambiguous-strong",
      }),
      expect.objectContaining({
        target: "histone-deacetylation",
        band: "medium",
        matchKind: "ambiguous-strong",
      }),
    ])
  })

  it("emits one candidate when slug, title, and tag match the same page", () => {
    expect(
      findCatalogMatches("GDF3", [
        page("gdf3", { title: "GDF3", tags: ["gdf3"] }),
      ]),
    ).toEqual([
      expect.objectContaining({
        target: "gdf3",
        matchKind: "slug-exact",
      }),
    ])
  })

  it("keeps generic terms Low before symbol or cross-language promotion", () => {
    const cellPage = page("cell", { title: "Cell", tags: ["CELL"] })
    const mechanismPage = page("cellular-mechanisms", {
      title: "细胞机制研究",
    })

    expect(findCatalogMatches("cell", [cellPage])[0].band).toBe("low")
    expect(findCatalogMatches("CELL", [cellPage])[0].band).toBe("low")
    expect(findCatalogMatches("机制", [mechanismPage])[0].band).toBe("low")
  })

  it("keeps non-symbol short ASCII terms Low even on exact matches", () => {
    expect(findCatalogMatches("in", [page("in")])).toEqual([
      expect.objectContaining({
        target: "in",
        band: "low",
        matchKind: "slug-exact",
      }),
    ])

    expect(
      buildAutoLinkSuggestions(
        [{ term: "in", target: "in" }],
        [page("in")],
        noIgnores,
      )[0],
    ).toMatchObject({
      band: "low",
      selectedByDefault: false,
    })
  })

  it("ranks title-related matches above slug partial matches", () => {
    expect(
      findCatalogMatches("activated macrophage", [
        page("immune-overview", { title: "Macrophage Biology" }),
        page("activated-macrophage-pathway", { title: "Unrelated" }),
      ]),
    ).toEqual([
      expect.objectContaining({
        target: "immune-overview",
        band: "medium",
        matchKind: "title-related",
      }),
      expect.objectContaining({
        target: "activated-macrophage-pathway",
        band: "low",
        matchKind: "partial",
      }),
    ])
  })

  it("uses normalized exact matching for full-width text without symbol promotion", () => {
    expect(isLikelySymbol("ＧＤＦ３")).toBe(false)
    expect(findCatalogMatches("ＧＤＦ３", [page("gdf3")])).toEqual([
      expect.objectContaining({
        target: "gdf3",
        band: "high",
        matchKind: "slug-exact",
      }),
    ])
  })

  it("sorts otherwise tied alternatives by slug and path", () => {
    const matches = findCatalogMatches("HDAC3", [
      page("hdac3-zeta", { path: "/project/wiki/z/hdac3-zeta.md" }),
      page("hdac3-alpha", { path: "/project/wiki/z/hdac3-alpha.md" }),
      page("hdac3-notes", { path: "/project/wiki/z/hdac3-notes.md" }),
      page("hdac3-notes", { path: "/project/wiki/a/hdac3-notes.md" }),
    ])

    expect(matches.map(({ target, path }) => ({ target, path }))).toEqual([
      {
        target: "hdac3-alpha",
        path: "/project/wiki/z/hdac3-alpha.md",
      },
      {
        target: "hdac3-notes",
        path: "/project/wiki/a/hdac3-notes.md",
      },
      {
        target: "hdac3-notes",
        path: "/project/wiki/z/hdac3-notes.md",
      },
      {
        target: "hdac3-zeta",
        path: "/project/wiki/z/hdac3-zeta.md",
      },
    ])
  })
})

describe("buildAutoLinkSuggestions", () => {
  it("selects a unique High exact match by default with a deterministic id", () => {
    expect(
      buildAutoLinkSuggestions(
        [{ term: "GDF3", target: "gdf3" }],
        [page("gdf3")],
        noIgnores,
      ),
    ).toEqual([
      expect.objectContaining({
        id: "GDF3\u0000gdf3",
        term: "GDF3",
        selectedTarget: "gdf3",
        preferredTarget: "gdf3",
        band: "high",
        selectedByDefault: true,
      }),
    ])
  })

  it("omits an invalid LLM target while retaining a real lexical match", () => {
    const [suggestion] = buildAutoLinkSuggestions(
      [{ term: "GDF3", target: "invented-page" }],
      [page("gdf3")],
      noIgnores,
    )

    expect(suggestion.preferredTarget).toBeNull()
    expect(suggestion.alternatives.map(({ target }) => target)).toEqual([
      "gdf3",
    ])
  })

  it("retains a valid weak preferred target behind a stronger lexical target", () => {
    const [suggestion] = buildAutoLinkSuggestions(
      [{ term: "Alpha Pathway", target: "alpha-pathway-overview" }],
      [
        page("alpha-pathway"),
        page("alpha-pathway-overview", { title: "Overview" }),
      ],
      noIgnores,
    )

    expect(suggestion).toMatchObject({
      selectedTarget: "alpha-pathway",
      preferredTarget: "alpha-pathway-overview",
      band: "high",
      selectedByDefault: true,
    })
    expect(
      suggestion.alternatives.map(({ target, band, matchKind }) => ({
        target,
        band,
        matchKind,
      })),
    ).toEqual([
      {
        target: "alpha-pathway",
        band: "high",
        matchKind: "slug-exact",
      },
      {
        target: "alpha-pathway-overview",
        band: "low",
        matchKind: "llm-preferred",
      },
    ])
  })

  it("suppresses ignored terms and removes only ignored pairs", () => {
    const catalog = [
      page("hdac3-alpha", { title: "HDAC3 alpha" }),
      page("hdac3-beta", { title: "HDAC3 beta" }),
    ]

    expect(
      buildAutoLinkSuggestions(
        [{ term: "HDAC3", target: "hdac3-alpha" }],
        catalog,
        { terms: [" hdac3 "], pairs: [] },
      ),
    ).toEqual([])

    const [suggestion] = buildAutoLinkSuggestions(
      [{ term: "HDAC3", target: "hdac3-alpha" }],
      catalog,
      {
        terms: [],
        pairs: [{ term: " hdac3 ", target: " HDAC3-ALPHA " }],
      },
    )

    expect(suggestion.alternatives).toEqual([
      expect.objectContaining({
        target: "hdac3-beta",
        band: "high",
        matchKind: "symbol-unique",
      }),
    ])
  })

  it("drops suggestions without a real alternative", () => {
    expect(
      buildAutoLinkSuggestions(
        [{ term: "unknown", target: "invented-page" }],
        [page("gdf3")],
        noIgnores,
      ),
    ).toEqual([])
  })

  it("sorts suggestions by band, then term and id", () => {
    const suggestions = buildAutoLinkSuggestions(
      [
        { term: "CELL", target: "cell" },
        { term: "BETA", target: "beta" },
        { term: "ALPHA", target: "alpha" },
      ],
      [page("cell"), page("beta"), page("alpha")],
      noIgnores,
    )

    expect(suggestions.map(({ term, band }) => ({ term, band }))).toEqual([
      { term: "ALPHA", band: "high" },
      { term: "BETA", band: "high" },
      { term: "CELL", band: "low" },
    ])
  })
})
