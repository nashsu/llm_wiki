import { describe, expect, it } from "vitest"
import {
  addDeterministicWikilinks,
  canonicalizeRelatedFrontmatter,
  normalizePageReferencesOnWrite,
} from "./post-ingest-wikilinks"

describe("addDeterministicWikilinks", () => {
  it("links by slug/title, keeps original display text when needed", () => {
    const input = [
      "---",
      "title: Intro to Transformers",
      "---",
      "",
      "Transformer models use attention mechanism heavily.",
    ].join("\n")

    const out = addDeterministicWikilinks(
      input,
      [
        { slug: "transformer", title: "Transformer" },
        { slug: "attention-mechanism", title: "attention mechanism" },
      ],
      "intro-to-transformers",
      15,
    )

    expect(out.added).toBe(2)
    expect(out.content).toContain("[[transformer|Transformer]]")
    expect(out.content).toContain("[[attention-mechanism|attention mechanism]]")
  })

  it("skips frontmatter, fenced code, inline code, and existing wikilinks", () => {
    const input = [
      "---",
      "title: Transformer",
      "summary: attention mechanism",
      "---",
      "",
      "```md",
      "attention mechanism",
      "```",
      "",
      "`attention mechanism` and [[transformer]].",
      "",
      "Outside code we mention attention mechanism once.",
    ].join("\n")

    const out = addDeterministicWikilinks(
      input,
      [{ slug: "attention-mechanism", title: "attention mechanism" }],
      "transformer",
      15,
    )

    expect(out.added).toBe(1)
    expect(out.content).toContain("summary: attention mechanism")
    expect(out.content).toContain("`attention mechanism` and [[transformer]].")
    expect(out.content).toContain("[[attention-mechanism|attention mechanism]] once.")
  })

  it("does not match short latin substrings without boundaries", () => {
    const input = "Partial artifact appears in artificial systems."
    const out = addDeterministicWikilinks(
      input,
      [
        { slug: "art", title: "art" },
        { slug: "ai", title: "AI" },
      ],
      "self",
      15,
    )

    expect(out.added).toBe(0)
    expect(out.content).toBe(input)
  })

  it("uses longest-match-first for overlapping candidates", () => {
    const input = "Graph neural network methods are common."
    const out = addDeterministicWikilinks(
      input,
      [
        { slug: "graph", title: "Graph" },
        { slug: "graph-neural-network", title: "Graph neural network" },
      ],
      "self",
      15,
    )

    expect(out.added).toBe(1)
    expect(out.content).toContain("[[graph-neural-network|Graph neural network]] methods")
    expect(out.content).not.toContain("[[graph|Graph]] neural network")
  })

  it("caps added links per page", () => {
    const input = "Alpha Beta Gamma Delta"
    const out = addDeterministicWikilinks(
      input,
      [
        { slug: "alpha", title: "Alpha" },
        { slug: "beta", title: "Beta" },
        { slug: "gamma", title: "Gamma" },
        { slug: "delta", title: "Delta" },
      ],
      "self",
      2,
    )

    expect(out.added).toBe(2)
  })
})

describe("normalizePageReferencesOnWrite", () => {
  it("delegates to related canonicalization", () => {
    const content = [
      "---",
      "related: [spark]",
      "---",
      "",
      "Body.",
    ].join("\n")
    const known = ["apache-spark"]
    expect(normalizePageReferencesOnWrite(content, known)).toBe(
      canonicalizeRelatedFrontmatter(content, known),
    )
  })
})

describe("canonicalizeRelatedFrontmatter", () => {
  it("rewrites short related slugs to canonical page ids", () => {
    const content = [
      "---",
      'type: entity',
      'title: "Hadoop"',
      'related: [hdfs, spark]',
      "---",
      "",
      "Body.",
    ].join("\n")

    const out = canonicalizeRelatedFrontmatter(content, [
      "hdfs",
      "apache-spark",
      "hadoop",
    ])
    expect(out).toContain('related: ["hdfs", "apache-spark"]')
    expect(out).not.toContain('"spark"')
  })

  it("dedupes related when shorthand and canonical refer to the same page", () => {
    const content = [
      "---",
      'type: entity',
      'related: [apache-spark, spark]',
      "---",
      "",
      "Body.",
    ].join("\n")

    const out = canonicalizeRelatedFrontmatter(content, [
      "apache-spark",
      "hadoop",
    ])
    expect(out).toContain('related: ["apache-spark"]')
  })
})
