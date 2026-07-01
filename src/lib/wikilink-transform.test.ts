import { describe, it, expect } from "vitest"
import { transformImageEmbeds, transformWikilinks } from "./wikilink-transform"

describe("transformWikilinks", () => {
  it("returns input unchanged when there are no wikilinks", () => {
    expect(transformWikilinks("just plain text")).toBe("just plain text")
    expect(transformWikilinks("# Heading\n\nparagraph")).toBe("# Heading\n\nparagraph")
  })

  it("converts a bare [[slug]] to a standard markdown link", () => {
    expect(transformWikilinks("see [[foo]] for details")).toBe(
      "see [foo](#foo) for details",
    )
  })

  it("uses the alias as label and target as href for [[slug|alias]]", () => {
    expect(transformWikilinks("see [[foo|the foo page]]")).toBe(
      "see [the foo page](#foo)",
    )
  })

  it("trims whitespace inside the wikilink", () => {
    expect(transformWikilinks("[[ foo | the alias ]]")).toBe(
      "[the alias](#foo)",
    )
  })

  it("converts multiple wikilinks on the same line", () => {
    expect(transformWikilinks("[[a]] and [[b|B]] and [[c]]")).toBe(
      "[a](#a) and [B](#b) and [c](#c)",
    )
  })

  it("encodes special characters in the href", () => {
    expect(transformWikilinks("[[hello world]]")).toBe(
      "[hello world](#hello%20world)",
    )
  })

  it("does not touch wikilinks inside fenced code blocks", () => {
    const input = "before [[a]]\n```md\ncode [[b]] block\n```\nafter [[c]]"
    expect(transformWikilinks(input)).toBe(
      "before [a](#a)\n```md\ncode [[b]] block\n```\nafter [c](#c)",
    )
  })

  it("does not touch wikilinks inside inline code spans", () => {
    expect(transformWikilinks("text `[[skip]]` and [[keep]]")).toBe(
      "text `[[skip]]` and [keep](#keep)",
    )
  })

  it("handles multiple inline-code spans correctly", () => {
    expect(transformWikilinks("[[a]] `[[b]]` [[c]] `[[d]]` [[e]]")).toBe(
      "[a](#a) `[[b]]` [c](#c) `[[d]]` [e](#e)",
    )
  })

  it("preserves [[empty alias|]] by falling back to target as label", () => {
    expect(transformWikilinks("[[foo|]]")).toBe("[foo](#foo)")
  })

  it("matches the real DPAO body wikilink density", () => {
    const input =
      "DPAOs differ from [[paos|Polyphosphate-Accumulating Organisms (PAOs)]] " +
      "and store [[pha|polyhydroxyalkanoates (PHAs)]] from [[vfa|volatile fatty acids (VFAs)]]. " +
      "[[accumulibacter]] is the most-characterized genus."
    const out = transformWikilinks(input)
    expect(out).toContain("[Polyphosphate-Accumulating Organisms (PAOs)](#paos)")
    expect(out).toContain("[polyhydroxyalkanoates (PHAs)](#pha)")
    expect(out).toContain("[volatile fatty acids (VFAs)](#vfa)")
    expect(out).toContain("[accumulibacter](#accumulibacter)")
    expect(out).not.toContain("[[")
  })

  it("does not mangle existing standard markdown links", () => {
    const input = "see [foo](https://example.com) and [[bar]]"
    expect(transformWikilinks(input)).toBe(
      "see [foo](https://example.com) and [bar](#bar)",
    )
  })

  it("leaves dangling brackets untouched", () => {
    expect(transformWikilinks("[[broken")).toBe("[[broken")
    expect(transformWikilinks("broken]]")).toBe("broken]]")
  })
})

describe("transformImageEmbeds", () => {
  it("returns input unchanged when there are no embeds", () => {
    expect(transformImageEmbeds("plain text")).toBe("plain text")
    expect(transformImageEmbeds("a [[link]] but no embed")).toBe(
      "a [[link]] but no embed",
    )
  })

  it("converts an Obsidian image embed to standard markdown", () => {
    expect(transformImageEmbeds("![[../assets/abc123.png]]")).toBe(
      "![](<../assets/abc123.png>)",
    )
  })

  it("converts a whiteboard-screenshot embed (jpg under boards/)", () => {
    expect(
      transformImageEmbeds("![[../assets/boards/WB1.jpg]]"),
    ).toBe("![](<../assets/boards/WB1.jpg>)")
  })

  it("uses the alias as alt text for ![[target|alias]]", () => {
    expect(transformImageEmbeds("![[img.png|A diagram]]")).toBe(
      "![A diagram](<img.png>)",
    )
  })

  it("wraps the target in <…> so spaces/non-ASCII survive the parser", () => {
    expect(transformImageEmbeds("![[../assets/变与不变 图.png]]")).toBe(
      "![](<../assets/变与不变 图.png>)",
    )
  })

  it("converts multiple embeds and keeps surrounding text", () => {
    expect(
      transformImageEmbeds("before ![[a.png]] middle ![[b.png|B]] after"),
    ).toBe("before ![](<a.png>) middle ![B](<b.png>) after")
  })

  it("does not touch embeds inside fenced code blocks", () => {
    const input = "![[a.png]]\n```\n![[b.png]]\n```\n![[c.png]]"
    expect(transformImageEmbeds(input)).toBe(
      "![](<a.png>)\n```\n![[b.png]]\n```\n![](<c.png>)",
    )
  })

  it("does not touch embeds inside inline code spans", () => {
    expect(transformImageEmbeds("`![[skip.png]]` and ![[keep.png]]")).toBe(
      "`![[skip.png]]` and ![](<keep.png>)",
    )
  })

  it("leaves an embed whose alias contains `]` untouched (safe degradation)", () => {
    // A `]` inside an alias is not valid Obsidian embed syntax; the
    // regex declines to match rather than producing a malformed
    // image. The literal text is preserved.
    expect(transformImageEmbeds("![[x.png|a ] b]]")).toBe("![[x.png|a ] b]]")
  })
})

describe("composition: embeds then wikilinks", () => {
  it("an image embed survives the wikilink pass unmangled", () => {
    // This is the real pipeline order used by the renderers.
    const input = "See ![[../assets/x.png]] and the [[concept]] page."
    const out = transformWikilinks(transformImageEmbeds(input))
    expect(out).toBe("See ![](<../assets/x.png>) and the [concept](#concept) page.")
  })

  it("REGRESSION: wikilinks-only would have mangled an image embed", () => {
    // Documents the bug this fix addresses: running the generic
    // wikilink transform alone turns `![[x.png]]` into a broken
    // image whose src is a `#fragment`. The embed pass must run first.
    const mangled = transformWikilinks("![[x.png]]")
    expect(mangled).toBe("![x.png](#x.png)")
    // …whereas the correct pipeline yields a real image reference:
    const correct = transformWikilinks(transformImageEmbeds("![[x.png]]"))
    expect(correct).toBe("![](<x.png>)")
  })
})
