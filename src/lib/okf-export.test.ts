import { describe, expect, it } from "vitest"
import yaml from "js-yaml"

import { parseFrontmatter } from "@/lib/frontmatter"
import {
  OKF_VERSION,
  planOkfBundle,
  rewriteWikilinks,
  synthesizeRootIndex,
  transformConcept,
  transformIndex,
  transformLog,
  type OkfSourcePage,
} from "@/lib/okf-export"

// Realistic fixtures, modeled on real llm_wiki pages (see
// frontmatter.test.ts) and on the index/log formats the app writes
// (rebuild_wiki_index, source-lifecycle, ingest prompts).

const ACCUMULIBACTER = `---
type: entity
title: "Accumulibacter"
created: 2026-04-09
updated: 2026-04-10
tags: [microorganism, PAO, DPAO]
related:
  - wiki/entities/dpao.md
  - wiki/concepts/denitrifying-phosphorus-removal.md
sources: ["research-foo-2026-04-09.md", "https://example.org/paper"]
---

# Accumulibacter

A PAO. See [[entities/dpao|DPAO]] and [[nitrospira]] for context.
`

const DPAO = `---
type: entity
title: DPAO
created: 2026-04-09
sources: ["research-foo-2026-04-09.md"]
---

Denitrifying phosphorus removal organisms. [[missing-page]] is not written yet.
`

const NITROSPIRA = `---
type: entity
title: Nitrospira
created: 2026-04-07
updated: 2026-04-07
tags: [污水处理, NOB优势菌]
---

Nitrite oxidizer.
`

const INDEX = `# Wiki Index

## entity

- [[entities/accumulibacter|Accumulibacter]]
- [[entities/dpao|DPAO]]
- [[entities/nitrospira|Nitrospira]]
`

const LOG = `# Wiki Log

## [2026-04-10] ingest | research-foo-2026-04-09.md

Created [[entities/accumulibacter|Accumulibacter]] summary and 2 pages.

## [2026-04-09] ingest | paper.pdf

Initial import.

## [2026-04-09] delete | old-source.md

Deleted 1 source file and 1 wiki page.
`

function wikiPages(): OkfSourcePage[] {
  return [
    { path: "index.md", content: INDEX },
    { path: "log.md", content: LOG },
    { path: "entities/accumulibacter.md", content: ACCUMULIBACTER },
    { path: "entities/dpao.md", content: DPAO },
    { path: "entities/nitrospira.md", content: NITROSPIRA },
  ]
}

function fmOf(content: string): Record<string, unknown> {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/)
  expect(m, "output must start with a frontmatter block").toBeTruthy()
  return yaml.load(m![1], { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
}

describe("transformConcept", () => {
  it("maps llm_wiki frontmatter to OKF v0.2 and preserves extension keys", () => {
    const resolver = { resolve: () => null }
    const r = transformConcept(
      { path: "entities/accumulibacter.md", content: ACCUMULIBACTER },
      resolver,
    )
    const fm = fmOf(r.content)
    expect(fm.type).toBe("entity")
    expect(fm.title).toBe("Accumulibacter")
    expect(fm.tags).toEqual(["microorganism", "PAO", "DPAO"])
    expect(fm.related).toEqual([
      "wiki/entities/dpao.md",
      "wiki/concepts/denitrifying-phosphorus-removal.md",
    ])
    // OKF sources entries require `resource`.
    expect(fm.sources).toEqual([
      { resource: "research-foo-2026-04-09.md" },
      { resource: "https://example.org/paper" },
    ])
    // Trust fields are never synthesized.
    expect(fm.generated).toBeUndefined()
    expect(fm.verified).toBeUndefined()
    // created/updated survive as plain extension keys, not re-labeled.
    expect(fm.created).toBe("2026-04-09")
    expect(fm.updated).toBe("2026-04-10")
    expect(r.warnings).toEqual([])
  })

  it("copies an existing generated/verified through untouched", () => {
    const resolver = { resolve: () => null }
    const content = `---
type: entity
title: Curated
generated: { by: human:author, at: 2026-04-01T00:00:00Z }
verified: { by: human:reviewer, at: 2026-04-02T00:00:00Z }
---
Body
`
    const r = transformConcept({ path: "x.md", content }, resolver)
    const fm = fmOf(r.content)
    expect(fm.generated).toEqual({ by: "human:author", at: "2026-04-01T00:00:00Z" })
    expect(fm.verified).toEqual({ by: "human:reviewer", at: "2026-04-02T00:00:00Z" })
  })

  it("passes structured (non-string) sources entries through unchanged", () => {
    const resolver = { resolve: () => null }
    const content = `---
type: entity
title: Mixed
sources:
  - plain-file.pdf
  - id: handbook
    resource: https://example.org/handbook
    title: Handbook
---
Body
`
    const r = transformConcept({ path: "x.md", content }, resolver)
    const fm = fmOf(r.content)
    expect(fm.sources).toEqual([
      { resource: "plain-file.pdf" },
      { id: "handbook", resource: "https://example.org/handbook", title: "Handbook" },
    ])
  })

  it("round-trips unknown extension keys with scalar variety", () => {
    const resolver = { resolve: () => null }
    const content = `---
type: entity
title: Roundtrip
created: 2026-04-09
origin: chat
review_count: 3
pinned: true
subtitle: "a: b — c"
tags: [污水处理, NOB优势菌]
---
Body
`
    const r = transformConcept({ path: "x.md", content }, resolver)
    const fm = fmOf(r.content)
    expect(fm.origin).toBe("chat")
    expect(fm.review_count).toBe(3)
    expect(fm.pinned).toBe(true)
    expect(fm.subtitle).toBe("a: b — c")
    expect(fm.tags).toEqual(["污水处理", "NOB优势菌"])
    // And the emitted YAML must parse back to equal values.
    const reparsed = fmOf(r.content)
    expect(reparsed).toEqual(fm)
  })

  it("fills a missing type with Concept and warns", () => {
    const r = transformConcept(
      { path: "loose.md", content: "---\ntitle: Loose\n---\nbody\n" },
      { resolve: () => null },
    )
    expect(fmOf(r.content).type).toBe("Concept")
    expect(r.warnings.join()).toContain("missing frontmatter 'type'")
  })

  it("exports unparseable frontmatter verbatim with a warning instead of dropping it", () => {
    const content = "---\nthis is not: : valid\n  malformed\n---\n# Body\n"
    const r = transformConcept({ path: "broken.md", content }, { resolve: () => null })
    expect(r.content).toBe(content)
    expect(r.warnings.join()).toContain("could not be parsed")
    expect(r.warnings.join()).toContain("exported unchanged")
  })

  it("falls back to the normalized view for repaired wikilink-list frontmatter, with a warning", () => {
    const content = "---\ntype: entity\ntitle: X\nrelated: [[a]], [[b]]\n---\nBody\n"
    const r = transformConcept({ path: "repaired.md", content }, { resolve: () => null })
    const fm = fmOf(r.content)
    expect(fm.type).toBe("entity")
    // Values match what the app itself displays for the repaired page.
    expect(fm.related).toEqual(["[[a]]", "[[b]]"])
    expect(r.warnings.join()).toContain("normalized form")
  })

  it("handles a page with no frontmatter at all", () => {
    const r = transformConcept(
      { path: "plain.md", content: "# Just a body\n" },
      { resolve: () => null },
    )
    expect(fmOf(r.content).type).toBe("Concept")
    expect(r.content).toContain("# Just a body")
  })
})

describe("rewriteWikilinks", () => {
  const linkFor = (target: string, label: string) =>
    target === "known" ? `[${label}](/entities/known.md)` : null

  it("rewrites aliased and bare wikilinks, degrading unknowns to text", () => {
    const r = rewriteWikilinks("See [[known|Known Page]] and [[ghost]].", linkFor)
    expect(r.text).toBe("See [Known Page](/entities/known.md) and ghost.")
    expect(r.unresolved).toEqual(["ghost"])
  })

  it("leaves fenced code and inline code untouched", () => {
    const input = "```\n[[known]]\n```\nUse `[[known]]` inline.\n[[known]]"
    const r = rewriteWikilinks(input, linkFor)
    expect(r.text).toBe("```\n[[known]]\n```\nUse `[[known]]` inline.\n[known](/entities/known.md)")
  })
})

describe("transformIndex", () => {
  const resolver = {
    resolve: (t: string) =>
      t === "entities/dpao" ? "entities/dpao.md" : null,
  }

  it("declares okf_version at the bundle root and uses relative links", () => {
    const r = transformIndex(
      { path: "index.md", content: "# Wiki Index\n\n- [[entities/dpao|DPAO]]\n" },
      resolver,
      true,
    )
    expect(fmOf(r.content).okf_version).toBe(OKF_VERSION)
    expect(r.content).toContain("- [DPAO](entities/dpao.md)")
    expect(r.warnings).toEqual([])
  })

  it("drops frontmatter on nested indexes with a warning", () => {
    const r = transformIndex(
      {
        path: "entities/index.md",
        content: `---\ncustom: 1\n---\n# Entities\n\n- [[entities/dpao|DPAO]]\n`,
      },
      resolver,
      false,
    )
    expect(r.content.startsWith("---")).toBe(false)
    expect(r.content).toContain("- [DPAO](dpao.md)")
    expect(r.warnings.join()).toContain("frontmatter dropped")
  })

  it("links upward from a nested index", () => {
    const r = transformIndex(
      { path: "sub/index.md", content: "# Sub\n\n- [[entities/dpao|DPAO]]\n" },
      resolver,
      false,
    )
    expect(r.content).toContain("- [DPAO](../entities/dpao.md)")
  })
})

describe("transformLog", () => {
  const resolver = {
    resolve: (t: string) =>
      t === "entities/accumulibacter" ? "entities/accumulibacter.md" : null,
  }

  it("regroups llm_wiki entries under ISO date headings, newest first", () => {
    const r = transformLog({ path: "log.md", content: LOG }, resolver)
    expect(r.warnings).toEqual([])
    const lines = r.content.split("\n")
    expect(lines[0]).toBe("# Wiki Log")
    const headings = lines.filter((l) => l.startsWith("## "))
    expect(headings).toEqual(["## 2026-04-10", "## 2026-04-09"])
    expect(r.content).toContain(
      "* **Ingest**: research-foo-2026-04-09.md — Created [Accumulibacter](/entities/accumulibacter.md) summary and 2 pages.",
    )
    expect(r.content).toContain("* **Delete**: old-source.md — Deleted 1 source file and 1 wiki page.")
  })

  it("keeps an unrecognized log verbatim with a warning", () => {
    const content = "# Wiki Log\n\n## Some other heading\n\ntext\n"
    const r = transformLog({ path: "log.md", content }, resolver)
    expect(r.content).toBe(content)
    expect(r.warnings.join()).toContain("kept as-is")
  })
})

describe("planOkfBundle", () => {
  it("produces a conformant bundle from a realistic wiki", () => {
    const plan = planOkfBundle(wikiPages())
    expect(plan.conceptCount).toBe(3)
    expect(plan.warnings.filter((w) => w.includes("missing-page")).length).toBe(1)

    const byPath = new Map(plan.files.map((f) => [f.path, f.content]))
    expect([...byPath.keys()].sort()).toEqual([
      "entities/accumulibacter.md",
      "entities/dpao.md",
      "entities/nitrospira.md",
      "index.md",
      "log.md",
    ])

    // Conformance §11.1/§11.2: every non-reserved .md has parseable
    // frontmatter with a non-empty type.
    for (const [path, content] of byPath) {
      if (path === "index.md" || path === "log.md") continue
      const parsed = parseFrontmatter(content)
      expect(parsed.frontmatter?.type, path).toBeTruthy()
    }

    // §12: bundle-root index declares the version.
    expect(fmOf(byPath.get("index.md")!).okf_version).toBe(OKF_VERSION)
    // §8: index links are relative markdown links, not wikilinks.
    expect(byPath.get("index.md")).toContain("[Accumulibacter](entities/accumulibacter.md)")
    expect(byPath.get("index.md")).not.toContain("[[")

    // §9: log headings are ISO dates.
    const logHeadings = byPath
      .get("log.md")!
      .split("\n")
      .filter((l) => l.startsWith("## "))
    expect(logHeadings.every((h) => /^## \d{4}-\d{2}-\d{2}$/.test(h))).toBe(true)

    // Body wikilinks became bundle-relative markdown links.
    expect(byPath.get("entities/accumulibacter.md")).toContain("[DPAO](/entities/dpao.md)")
    expect(byPath.get("entities/accumulibacter.md")).toContain("[nitrospira](/entities/nitrospira.md)")
    // Unresolvable target degrades to text, not a broken link.
    expect(byPath.get("entities/dpao.md")).toContain("missing-page is not written yet")
    expect(byPath.get("entities/dpao.md")).not.toContain("[[")
  })

  it("synthesizes a root index when the wiki has none", () => {
    const plan = planOkfBundle([{ path: "entities/dpao.md", content: DPAO }])
    const index = plan.files.find((f) => f.path === "index.md")
    expect(index).toBeTruthy()
    expect(fmOf(index!.content).okf_version).toBe(OKF_VERSION)
    expect(index!.content).toContain("[DPAO](entities/dpao.md)")
  })

  it("skips unsafe paths and passes non-markdown files through", () => {
    const plan = planOkfBundle([
      { path: "../escape.md", content: "---\ntype: x\n---\n" },
      { path: "assets/diagram.png", content: "PNG-BYTES" },
      { path: "assets/流程 图.png", content: "UNICODE-BYTES" },
      { path: "entities/dpao.md", content: DPAO },
    ])
    expect(plan.files.map((f) => f.path)).toEqual([
      "assets/diagram.png",
      "assets/流程 图.png",
      "entities/dpao.md",
      "index.md",
    ])
    expect(plan.files[0].content).toBe("PNG-BYTES")
    expect(plan.files[1].content).toBe("UNICODE-BYTES")
    expect(plan.warnings.join()).toContain("unsafe path")
  })

  it("skips case-insensitive output collisions", () => {
    const plan = planOkfBundle([
      { path: "Foo.md", content: "---\ntype: a\n---\n1\n" },
      { path: "foo.md", content: "---\ntype: b\n---\n2\n" },
    ])
    expect(plan.files.length).toBe(1 + 1) // one concept + synthesized index
    expect(plan.warnings.join()).toContain("collides")
  })

  it("handles CRLF content", () => {
    const plan = planOkfBundle([
      { path: "a.md", content: "---\r\ntype: note\r\n---\r\n\r\nbody [[gone]]\r\n" },
    ])
    const page = plan.files.find((f) => f.path === "a.md")!
    expect(fmOf(page.content).type).toBe("note")
  })
})

describe("synthesizeRootIndex", () => {
  it("groups concepts by directory", () => {
    const out = synthesizeRootIndex([
      { path: "entities/dpao.md", title: "DPAO" },
      { path: "overview.md", title: "Overview" },
    ])
    expect(fmOf(out).okf_version).toBe(OKF_VERSION)
    expect(out).toContain("## .\n\n* [Overview](overview.md)")
    expect(out).toContain("## entities\n\n* [DPAO](entities/dpao.md)")
  })
})
