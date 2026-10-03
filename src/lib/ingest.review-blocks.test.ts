import { describe, it, expect, vi } from "vitest"
import { parseReviewBlocks } from "./ingest"

/**
 * Regression tests for REVIEW block parsing — the companion of the
 * `parseFileBlocks` fixture set in ingest-parse.test.ts.
 *
 * That parser documents its hazards as H1–H6 (each with a fixture here in
 * `src/lib/`). REVIEW blocks had none of them: the regex required a literal
 * `---END REVIEW---`, so a single missing marker made `([\s\S]*?)` run on to
 * the next closer and fold every following block into the first one.
 *
 * Observed on two unrelated projects, both on unmodified v0.6.12:
 *   - a 5-block / 2-closer response produced 2 cards, the second holding 3 blocks
 *   - every swallowed block lost its own `type` (the first block's type won)
 *   - the swallowed `OPTIONS:` / `PAGES:` / `SEARCH:` lines leaked into the
 *     visible description
 *   - `Create Page` then guessed a page title out of that text
 *
 * These tests need no model and no network: the fixtures are fixed strings.
 */
describe("parseReviewBlocks — missing `---END REVIEW---`", () => {
  const mergedOutput = [
    "---REVIEW: suggestion | First review---",
    "Body of the first review.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/queries/a.md, wiki/synthesis/b.md",
    "SEARCH: query one | query two",
    "",
    "---REVIEW: missing-page | Second review---",
    "Body of the second review.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/concepts/c.md",
    "SEARCH: query three | query four",
    "---END REVIEW---",
  ].join("\n")

  it("keeps the damage local instead of swallowing the next block", () => {
    const items = parseReviewBlocks(mergedOutput, "raw/sources/技能大纲.md")
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.title)).toEqual(["First review", "Second review"])
    expect(items.map((item) => item.type)).toEqual(["suggestion", "missing-page"])
  })

  it("gives the first block only its own PAGES/SEARCH, not the swallowed block's", () => {
    const items = parseReviewBlocks(mergedOutput, "raw/sources/技能大纲.md")
    expect(items[0].affectedPages).toEqual(["wiki/queries/a.md", "wiki/synthesis/b.md"])
    expect(items[0].searchQueries).toEqual(["query one", "query two"])
    expect(items[0].description).toBe("Body of the first review.")
    expect(items[1].affectedPages).toEqual(["wiki/concepts/c.md"])
    expect(items[1].description).toBe("Body of the second review.")
  })

  it("strips OPTIONS/PAGES/SEARCH from every merge level, not just the first", () => {
    // Simulates a body that already absorbed a later block: two triplets in
    // one block. The old non-global replaces removed only the first triplet.
    const folded = [
      "---REVIEW: contradiction | Overlapping---",
      "Only the prose should survive.",
      "OPTIONS: Create Page | Skip",
      "PAGES: wiki/concepts/x.md",
      "SEARCH: first query",
      "---REVIEW: suggestion | Swallowed---",
      "Swallowed prose.",
      "OPTIONS: Create Page | Skip",
      "PAGES: wiki/concepts/y.md",
      "SEARCH: second query",
      "---END REVIEW---",
    ].join("\n")

    const items = parseReviewBlocks(folded, "raw/sources/x.md")
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item.description).not.toContain("OPTIONS:")
      expect(item.description).not.toContain("PAGES:")
      expect(item.description).not.toContain("SEARCH:")
    }
  })
})

describe("parseReviewBlocks — well-formed output is unchanged", () => {
  it("reads back-to-back closed blocks", () => {
    const closed = [
      "---REVIEW: missing-page | Prefix Tuning 独立概念页---",
      "仅在 [[comparisons/lora-vs-qlora-vs-p-tuning]] 中部分覆盖。",
      "OPTIONS: Create Page | Skip",
      "PAGES: wiki/concepts/prefix-tuning.md, wiki/concepts/p-tuning.md",
      "SEARCH: prefix tuning explained | PEFT taxonomy",
      "---END REVIEW---",
      "",
      "---REVIEW: duplicate | 多跳检索 vs multi-hop retrieval---",
      "两页指向同一概念。",
      "OPTIONS: Create Page | Skip",
      "---END REVIEW---",
    ].join("\n")

    const items = parseReviewBlocks(closed, "raw/sources/x.md")
    expect(items).toHaveLength(2)
    expect(items[0].type).toBe("missing-page")
    expect(items[0].affectedPages).toEqual([
      "wiki/concepts/prefix-tuning.md",
      "wiki/concepts/p-tuning.md",
    ])
    expect(items[0].searchQueries).toEqual(["prefix tuning explained", "PEFT taxonomy"])
    expect(items[1].type).toBe("duplicate")
    // No SEARCH line → undefined, not an empty array.
    expect(items[1].searchQueries).toBeUndefined()
    expect(items[1].description).toBe("两页指向同一概念。")
  })

  it("falls back to the default Approve/Skip options when OPTIONS is missing", () => {
    const items = parseReviewBlocks(
      "---REVIEW: confirm | Check this---\nNeeds a human.\n---END REVIEW---",
      "raw/sources/x.md",
    )
    expect(items).toHaveLength(1)
    expect(items[0].options.map((option) => option.label)).toEqual(["Approve", "Skip"])
  })

  it("maps an unknown type to `confirm`", () => {
    const items = parseReviewBlocks(
      "---REVIEW: made-up-type | Weird---\nBody.\n---END REVIEW---",
      "raw/sources/x.md",
    )
    expect(items[0].type).toBe("confirm")
  })

  it("handles a block that ends the response with no trailing newline", () => {
    const items = parseReviewBlocks(
      "---REVIEW: suggestion | Trailing---\nBody.\nOPTIONS: Create Page | Skip\n---END REVIEW---",
      "raw/sources/x.md",
    )
    expect(items).toHaveLength(1)
    expect(items[0].description).toBe("Body.")
  })

  it("ignores a REVIEW header that is not at the start of a line", () => {
    const items = parseReviewBlocks(
      "---FILE: wiki/concepts/a.md---\nsee ---REVIEW: suggestion | inside a page---\n---END FILE---",
      "raw/sources/x.md",
    )
    expect(items).toHaveLength(0)
  })

  it("returns nothing when there is no REVIEW block at all", () => {
    expect(parseReviewBlocks("---FILE: wiki/a.md---\nbody\n---END FILE---", "p")).toEqual([])
  })
})

// Mirrors parseFileBlocks' H3: "Marker whitespace / case variants are accepted."
describe("parseReviewBlocks — tolerant markers (H3)", () => {
  it("accepts spacing and case variants on the closer", () => {
    const closers = [
      "---END REVIEW---",
      "--- END REVIEW ---",
      "---end review---",
      "   ---END REVIEW---   ",
    ]
    for (const closer of closers) {
      const items = parseReviewBlocks(
        `---REVIEW: suggestion | Variant---\nBody.\n${closer}`,
        "raw/sources/x.md",
      )
      expect(items, `closer: ${JSON.stringify(closer)}`).toHaveLength(1)
      expect(items[0].description).toBe("Body.")
    }
  })

  it("accepts a case variant on the opener", () => {
    const items = parseReviewBlocks(
      "---review: suggestion | Lowercase---\nBody.\n---END REVIEW---",
      "raw/sources/x.md",
    )
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe("suggestion")
  })
})

// Mirrors parseFileBlocks' H2/H6: "surface, don't hide" — an inferred block
// boundary has to leave a trace somewhere.
describe("parseReviewBlocks — inferred boundary is surfaced (H2/H6)", () => {
  it("warns when a closer is missing", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const items = parseReviewBlocks(
        "---REVIEW: suggestion | A---\nBody A.\n---REVIEW: missing-page | B---\nBody B.\n---END REVIEW---",
        "raw/sources/x.md",
      )
      expect(items).toHaveLength(2)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0][0])).toMatch(/was not closed/i)
    } finally {
      spy.mockRestore()
    }
  })

  it("stays quiet when every block is closed", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      parseReviewBlocks(
        "---REVIEW: suggestion | A---\nBody A.\n---END REVIEW---",
        "raw/sources/x.md",
      )
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("warns when a trailing block is dropped as truncated", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const items = parseReviewBlocks(
        "---REVIEW: suggestion | A---\nBody A.\n---END REVIEW---\n---REVIEW: missing-page | B---\nBody B.",
        "raw/sources/x.md",
      )
      expect(items).toHaveLength(1)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0][0])).toMatch(/truncated and dropped/i)
    } finally {
      spy.mockRestore()
    }
  })
})

// The property the old expression could not hold: a block that forgot its
// closer must not swallow the blocks that follow it.
describe("parseReviewBlocks — block boundaries", () => {
  const block = (type: string, title: string, closed: boolean) => [
    `---REVIEW: ${type} | ${title}---`,
    `Body ${title}.`,
    ...(closed ? ["---END REVIEW---"] : []),
  ]

  const aOpen = block("suggestion", "A", false)
  const aClosed = block("suggestion", "A", true)
  const bOpen = block("missing-page", "B", false)
  const bClosed = block("missing-page", "B", true)
  const cOpen = block("contradiction", "C", false)
  const cClosed = block("contradiction", "C", true)

  it("recovers a block whose closer is missing when another block follows", () => {
    // The real-world failure: A lost its marker, B is intact.
    const items = parseReviewBlocks([...aOpen, ...bClosed].join("\n"), "raw/sources/x.md")
    expect(items.map((item) => item.title)).toEqual(["A", "B"])
    expect(items[0].description).toBe("Body A.")
    expect(items[1].description).toBe("Body B.")
  })

  it("recovers every block of a fully unclosed response except the trailing one", () => {
    const items = parseReviewBlocks([...aOpen, ...bOpen, ...cOpen].join("\n"), "raw/sources/x.md")
    expect(items.map((item) => item.title)).toEqual(["A", "B"])
  })

  it("drops a trailing block with no closer, matching the truncation guard", () => {
    const items = parseReviewBlocks([...aClosed, ...bOpen].join("\n"), "raw/sources/x.md")
    expect(items.map((item) => item.title)).toEqual(["A"])
  })

  it("never lets a card hold another card's header or leaked metadata", () => {
    const inputs = [
      [...aOpen, ...bClosed],
      [...aOpen, ...bOpen, ...cOpen],
      [...aClosed, ...bOpen],
      [...aOpen, ...bOpen, ...cClosed],
      [...aClosed, ...bClosed, ...cClosed],
    ]
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (const parts of inputs) {
        for (const item of parseReviewBlocks(parts.join("\n"), "raw/sources/x.md")) {
          expect(item.description).not.toContain("---REVIEW:")
          expect(item.description).not.toMatch(/^(OPTIONS|PAGES|SEARCH):/m)
        }
      }
    } finally {
      spy.mockRestore()
    }
  })
})
