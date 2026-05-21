/**
 * ADR 0003 Tier A: the entity/concept write chokepoint.
 */
import { describe, it, expect } from "vitest"
import { canonicalizeContentPage } from "./wiki-content-page"

const page = (title: string, body = "# Body") =>
  `---\ntype: concept\ntitle: ${title}\n---\n\n${body}`

describe("canonicalizeContentPage", () => {
  it("normalizes the LLM filename through pageId (camelCase split)", () => {
    const r = canonicalizeContentPage("wiki/concepts/MapReduce.md", page("MapReduce"))
    expect(r.relativePath).toBe("wiki/concepts/map-reduce.md")
  })

  it("keeps the LLM's short id — not pageId(title)", () => {
    // filename `rope`, title `Rotary Position Embedding` — the short
    // id is a deliberate choice and must survive.
    const r = canonicalizeContentPage(
      "wiki/concepts/rope.md",
      `---\ntype: concept\ntitle: Rotary Position Embedding\n---\n\n# Body`,
    )
    expect(r.relativePath).toBe("wiki/concepts/rope.md")
  })

  it("collapses case/camelCase variants of one filename to one path", () => {
    const a = canonicalizeContentPage("wiki/entities/DynamoDB.md", `---\ntype: entity\ntitle: DynamoDB\n---\nx`)
    const b = canonicalizeContentPage("wiki/entities/dynamo-db.md", `---\ntype: entity\ntitle: DynamoDB\n---\nx`)
    expect(a.relativePath).toBe(b.relativePath)
  })

  it("keeps the LLM's folder choice, only fixes the filename", () => {
    const r = canonicalizeContentPage("wiki/entities/Apache Kafka.md", `---\ntype: entity\ntitle: Apache Kafka\n---\nx`)
    expect(r.relativePath).toBe("wiki/entities/apache-kafka.md")
  })

  it("canonically re-serializes frontmatter (kills `--- ` delimiter drift)", () => {
    const r = canonicalizeContentPage(
      "wiki/concepts/foo.md",
      `--- \ntype: concept\ntitle: Foo\n--- \n\n# Body`,
    )
    expect(r.content.split("\n")[0]).toBe("---")
  })

  it("leaves non-content pages' path alone but still serializes", () => {
    const r = canonicalizeContentPage("wiki/sources/some-source.md", page("Some Source"))
    expect(r.relativePath).toBe("wiki/sources/some-source.md")
  })

  it("leaves unparseable frontmatter's path and content untouched", () => {
    const raw = "no frontmatter here"
    const r = canonicalizeContentPage("wiki/concepts/x.md", raw)
    expect(r.relativePath).toBe("wiki/concepts/x.md")
    expect(r.content).toBe(raw)
  })

  it("flags an entity/concept page with a blank body (Tier A)", () => {
    const r = canonicalizeContentPage("wiki/concepts/foo.md", `---\ntype: concept\ntitle: Foo\n---\n\n   `)
    expect(r.isContentPage).toBe(true)
    expect(r.bodyEmpty).toBe(true)
  })

  it("does not flag a page that has real body content", () => {
    const r = canonicalizeContentPage("wiki/concepts/foo.md", page("Foo", "# Foo\n\nReal text."))
    expect(r.bodyEmpty).toBe(false)
  })

  it("marks non-content paths with isContentPage false", () => {
    const r = canonicalizeContentPage("wiki/sources/s.md", page("S"))
    expect(r.isContentPage).toBe(false)
  })
})
