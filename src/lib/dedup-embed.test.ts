import { describe, it, expect } from "vitest"
import {
  extractProse,
  isRichProse,
  buildEmbedText,
  clusterPairs,
  packClusters,
  RICH_MIN_PROSE_CHARS,
} from "./dedup-embed"

describe("extractProse", () => {
  it("drops headings, tables, blockquotes, and bullet/metadata lines", () => {
    const body = [
      "# Heading",
      "Real prose sentence one.",
      "| a | b |",
      "> a quote",
      "- **Status:** Open",
      "* a bullet",
      "Real prose sentence two.",
    ].join("\n")
    expect(extractProse(body)).toBe("Real prose sentence one. Real prose sentence two.")
  })

  it("returns empty for a body that is only structure", () => {
    expect(extractProse("# Title\n| x |\n- **Tags:** [a]")).toBe("")
  })
})

describe("isRichProse", () => {
  it("rejects prose below the threshold", () => {
    expect(isRichProse("short")).toBe(false)
  })
  it("rejects content-pending placeholders even if long enough", () => {
    const long = "This page contains comparative analyses. *(Content pending)* ".repeat(5)
    expect(long.length).toBeGreaterThanOrEqual(RICH_MIN_PROSE_CHARS)
    expect(isRichProse(long)).toBe(false)
  })
  it("accepts substantive prose", () => {
    expect(isRichProse("x".repeat(RICH_MIN_PROSE_CHARS))).toBe(true)
  })
})

describe("buildEmbedText", () => {
  it("includes type, title, tags, and a prose excerpt", () => {
    expect(buildEmbedText("entity", "Zephyros", ["giant", "cloud"], "A cloud giant wizard.")).toBe(
      "entity: Zephyros [giant, cloud] — A cloud giant wizard.",
    )
  })
  it("omits the tag bracket when there are no tags", () => {
    expect(buildEmbedText("concept", "Curse", [], "A curse.")).toBe("concept: Curse — A curse.")
  })
})

describe("clusterPairs (union-find)", () => {
  it("merges transitively connected pairs into one cluster", () => {
    const clusters = clusterPairs([
      { a: "curse", b: "sacrifice" },
      { a: "sacrifice", b: "grandfather-tree" },
      { a: "vfa", b: "volatile-fatty-acids" },
    ])
    const sets = clusters.map((c) => new Set(c))
    expect(clusters).toHaveLength(2)
    expect(sets.some((s) => s.size === 3 && s.has("curse") && s.has("grandfather-tree"))).toBe(true)
    expect(sets.some((s) => s.size === 2 && s.has("vfa"))).toBe(true)
  })
  it("returns no clusters for no pairs", () => {
    expect(clusterPairs([])).toEqual([])
  })
})

describe("packClusters", () => {
  it("packs clusters into batches within the page budget without splitting a cluster", () => {
    const clusters = [["a", "b"], ["c", "d"], ["e", "f", "g"]]
    const batches = packClusters(clusters, 4)
    // [a,b,c,d] (=4) then [e,f,g]
    expect(batches).toEqual([["a", "b", "c", "d"], ["e", "f", "g"]])
  })
  it("keeps an over-budget cluster intact as its own batch", () => {
    const batches = packClusters([["a", "b", "c", "d", "e"]], 3)
    expect(batches).toEqual([["a", "b", "c", "d", "e"]])
  })
})
