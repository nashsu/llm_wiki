import { describe, it, expect } from "vitest"
import {
  generateIndexMd,
  extractIndexDescription,
  buildLogEntry,
  type IndexInputPage,
} from "./index-generator"

function page(relativePath: string, frontmatter: Record<string, string>, body: string): IndexInputPage {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")
  return { relativePath, content: `---\n${fm}\n---\n\n${body}` }
}

describe("generateIndexMd", () => {
  it("groups pages by type in a stable display order", () => {
    const pages: IndexInputPage[] = [
      page("wiki/concepts/cot.md", { type: "concept", title: "Chain of Thought" }, "# Chain of Thought\n\nA prompting technique."),
      page("wiki/entities/openai.md", { type: "entity", title: "OpenAI" }, "# OpenAI\n\nAn AI research company."),
      page("wiki/sources/wei-2022.md", { type: "source", title: "Wei 2022" }, "# Wei 2022\n\nA paper on CoT."),
    ]
    const out = generateIndexMd(pages, { date: "2026-06-27" })
    // Entities before Concepts before Sources
    const entIdx = out.indexOf("## Entities")
    const conIdx = out.indexOf("## Concepts")
    const srcIdx = out.indexOf("## Sources")
    expect(entIdx).toBeGreaterThan(-1)
    expect(entIdx).toBeLessThan(conIdx)
    expect(conIdx).toBeLessThan(srcIdx)
  })

  it("emits `- [[slug]] — description` entries using the first body sentence", () => {
    const pages = [
      page("wiki/entities/openai.md", { type: "entity", title: "OpenAI" }, "# OpenAI\n\nAn AI research company. Founded in 2015."),
    ]
    const out = generateIndexMd(pages, { date: "2026-06-27" })
    expect(out).toContain("- [[openai]] — An AI research company.")
  })

  it("includes a deterministic overview-typed frontmatter header", () => {
    const out = generateIndexMd([], { date: "2026-06-27" })
    expect(out).toMatch(/^---\ntype: overview\ntitle: Wiki Index\n/)
    expect(out).toContain("created: 2026-06-27")
    expect(out).toContain("updated: 2026-06-27")
    expect(out).toContain("# Wiki Index")
  })

  it("carries an existing created date forward, refreshing only updated", () => {
    const out = generateIndexMd([], { date: "2026-06-27", created: "2026-01-05" })
    expect(out).toContain("created: 2026-01-05")
    expect(out).toContain("updated: 2026-06-27")
  })

  it("falls back to the ingest date when created is absent or blank", () => {
    expect(generateIndexMd([], { date: "2026-06-27", created: "   " })).toContain(
      "created: 2026-06-27",
    )
  })

  it("excludes index.md, log.md, and overview.md themselves", () => {
    const pages = [
      page("wiki/index.md", { type: "overview", title: "Wiki Index" }, "# Wiki Index"),
      page("wiki/log.md", { type: "overview", title: "Log" }, "# Log"),
      page("wiki/overview.md", { type: "overview", title: "Overview" }, "# Overview\n\nSummary."),
      page("wiki/entities/foo.md", { type: "entity", title: "Foo" }, "# Foo\n\nA thing."),
    ]
    const out = generateIndexMd(pages, { date: "2026-06-27" })
    expect(out).toContain("- [[foo]]")
    expect(out).not.toContain("[[index]]")
    expect(out).not.toContain("[[log]]")
    expect(out).not.toContain("[[overview]]")
  })

  it("infers type from path when frontmatter type is missing", () => {
    const pages: IndexInputPage[] = [
      { relativePath: "wiki/entities/bar.md", content: "---\ntitle: Bar\n---\n\n# Bar\n\nAn entity." },
    ]
    const out = generateIndexMd(pages, { date: "2026-06-27" })
    expect(out).toContain("## Entities")
    expect(out).toContain("- [[bar]] — An entity.")
  })

  it("sorts entries within a type alphabetically by slug", () => {
    const pages = [
      page("wiki/entities/zebra.md", { type: "entity", title: "Zebra" }, "# Zebra\n\nLast."),
      page("wiki/entities/alpha.md", { type: "entity", title: "Alpha" }, "# Alpha\n\nFirst."),
    ]
    const out = generateIndexMd(pages, { date: "2026-06-27" })
    expect(out.indexOf("[[alpha]]")).toBeLessThan(out.indexOf("[[zebra]]"))
  })

  it("falls back to a placeholder when there are no pages", () => {
    const out = generateIndexMd([], { date: "2026-06-27" })
    expect(out).toContain("_No pages yet._")
  })

  it("places custom/unknown types after known types, alphabetically", () => {
    const pages = [
      page("wiki/entities/foo.md", { type: "entity", title: "Foo" }, "# Foo\n\nE."),
      page("wiki/people/jane.md", { type: "people", title: "Jane" }, "# Jane\n\nP."),
    ]
    const out = generateIndexMd(pages, { date: "2026-06-27" })
    expect(out.indexOf("## Entities")).toBeLessThan(out.indexOf("## People"))
  })
})

describe("extractIndexDescription", () => {
  it("takes the first sentence of the body", () => {
    expect(extractIndexDescription("# Title\n\nFirst sentence. Second sentence.", "Title", "slug")).toBe("First sentence.")
  })

  it("skips headings, comments, blockquotes, and lists", () => {
    const body = "# Heading\n\n<!-- comment -->\n\n> placeholder\n\n- a list item\n\nReal prose here."
    expect(extractIndexDescription(body, "Title", "slug")).toBe("Real prose here.")
  })

  it("flattens wikilinks and markdown to plain text", () => {
    const body = "# T\n\nSee [[other-page|the other page]] and **bold** `code`."
    expect(extractIndexDescription(body, "T", "slug")).toBe("See the other page and bold code.")
  })

  it("falls back to title when the body has no prose", () => {
    expect(extractIndexDescription("# Only Heading", "My Title", "slug")).toBe("My Title")
  })

  it("falls back to a de-slugified slug when title is empty too", () => {
    expect(extractIndexDescription("", "", "my-page-slug")).toBe("my page slug")
  })

  it("truncates very long sentences", () => {
    const long = "x".repeat(300) + "."
    const out = extractIndexDescription(`# T\n\n${long}`, "T", "slug")
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("buildLogEntry", () => {
  it("formats a log line with date and title", () => {
    expect(buildLogEntry("2026-06-27", "My Source")).toBe("## [2026-06-27] ingest | My Source")
  })

  it("collapses whitespace in the title", () => {
    expect(buildLogEntry("2026-06-27", "  My   Source  ")).toBe("## [2026-06-27] ingest | My Source")
  })

  it("uses a placeholder for an empty title", () => {
    expect(buildLogEntry("2026-06-27", "")).toBe("## [2026-06-27] ingest | (untitled source)")
  })
})
