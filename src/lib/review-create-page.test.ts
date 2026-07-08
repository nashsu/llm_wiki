import { describe, expect, it } from "vitest"
import type { ReviewItem } from "@/stores/review-store"
import {
  buildReviewPageContent,
  collectReviewProvenance,
  collectReviewSourceIdentities,
  createReviewPageDrafts,
} from "./review-create-page"

function review(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "review-1",
    type: "missing-page",
    title: "Missing page",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...overrides,
  }
}

describe("createReviewPageDrafts", () => {
  it("creates one entity page per missing entity named in Chinese review text", () => {
    const drafts = createReviewPageDrafts(
      review({
        title: "核心测试项实体页缺失：CallMethod、StartFunc、Print",
        description: "缺少 CallMethod、StartFunc、Print 等实体页面。",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "CallMethod", pageType: "entity", dir: "entities" },
      { title: "StartFunc", pageType: "entity", dir: "entities" },
      { title: "Print", pageType: "entity", dir: "entities" },
    ])
  })

  it("keeps non-missing review creation as a single query page", () => {
    const drafts = createReviewPageDrafts(
      review({
        type: "suggestion",
        title: "Create: Policy version gap",
        description: "Review the policy changes.",
      }),
      "Create Page",
    )

    expect(drafts).toEqual([
      { title: "Policy version gap", pageType: "query", dir: "queries" },
    ])
  })
})

describe("buildReviewPageContent", () => {
  const draft = { title: "鲁巴亚矿区复产时间矛盾", pageType: "query" as const, dir: "queries" }

  it("writes sources from the review item's source identity", () => {
    const content = buildReviewPageContent(
      draft,
      review({ type: "contradiction", title: "鲁巴亚矿区复产时间矛盾", description: "两处复产时间相差一年。" }),
      "2026-07-02",
      ["20260630-稀美资源-小范围交流.docx"],
    )

    expect(content).toContain('sources: ["20260630-稀美资源-小范围交流.docx"]')
    expect(content).toContain("type: query")
    expect(content).toContain('title: "鲁巴亚矿区复产时间矛盾"')
    expect(content).toContain("# 鲁巴亚矿区复产时间矛盾\n\n两处复产时间相差一年。")
  })

  it("writes multiple deduped source identities so cross-source contradictions stay verifiable", () => {
    const content = buildReviewPageContent(
      draft,
      review({}),
      "2026-07-02",
      ["a-纪要.docx", "b-周报.md", "a-纪要.docx"],
    )

    expect(content).toContain('sources: ["a-纪要.docx", "b-周报.md"]')
  })

  it("fills related with slugs derived from affectedPages", () => {
    const content = buildReviewPageContent(
      draft,
      review({
        affectedPages: ["wiki/sources/20260630-稀美资源-小范围交流-updated.md", "wiki/entities/稀美资源.md"],
      }),
      "2026-07-02",
      [],
    )

    expect(content).toContain('related: ["20260630-稀美资源-小范围交流-updated", "稀美资源"]')
  })

  it("dedupes related slugs and unwraps wikilink-shaped entries", () => {
    const content = buildReviewPageContent(
      draft,
      review({
        affectedPages: ["wiki/entities/foo.md", "wiki/sources/foo.md", "[[rubin-dram-reduction]]"],
      }),
      "2026-07-02",
      [],
    )

    expect(content).toContain('related: ["foo", "rubin-dram-reduction"]')
  })

  it("omits sources line and keeps empty related when nothing is known", () => {
    const content = buildReviewPageContent(draft, review({}), "2026-07-02", [])

    expect(content).not.toContain("sources:")
    expect(content).toContain("related: []")
  })

  it("escapes double quotes in the title", () => {
    const content = buildReviewPageContent(
      { ...draft, title: 'He said "no"' },
      review({}),
      "2026-07-02",
      [],
    )

    expect(content).toContain('title: "He said \\"no\\""')
  })

  it("collectReviewSourceIdentities unions own source with affected pages' sources", async () => {
    const pages: Record<string, string> = {
      "/p/wiki/concepts/rubin-dram-reduction.md":
        '---\ntype: concept\ntitle: "x"\nsources: ["260601-另一篇纪要.docx"]\ntags: []\nrelated: []\n---\n\n# x\n',
    }
    const readFile = async (path: string) => {
      const content = pages[path]
      if (content === undefined) throw new Error("not found")
      return content
    }

    const ids = await collectReviewSourceIdentities(
      "/p",
      review({
        sourcePath: "/p/raw/sources/260607-久谦论坛-调研周报.md",
        affectedPages: ["wiki/concepts/rubin-dram-reduction.md", "wiki/gone/missing.md"],
      }),
      readFile,
    )

    expect(ids).toEqual(["260607-久谦论坛-调研周报.md", "260601-另一篇纪要.docx"])
  })

  it("collectReviewSourceIdentities drops non-raw sourcePath instead of faking an identity", async () => {
    const ids = await collectReviewSourceIdentities(
      "/p",
      review({ sourcePath: "/p/wiki/queries/research-x.md" }),
      async () => { throw new Error("not found") },
    )

    expect(ids).toEqual([])
  })

  it("collectReviewProvenance reports the wiki research page as a web-derived source", async () => {
    const provenance = await collectReviewProvenance(
      "/p",
      review({ sourcePath: "/p/wiki/queries/research-金刚石散热.md" }),
      async () => { throw new Error("not found") },
    )

    expect(provenance.sourceIdentities).toEqual([])
    expect(provenance.wikiSourcePage).toBe("wiki/queries/research-金刚石散热.md")
  })

  it("collectReviewProvenance classifies missing pages and pages without sources", async () => {
    const pages: Record<string, string> = {
      "/p/wiki/concepts/exists-no-sources.md":
        '---\ntype: concept\ntitle: "x"\ntags: []\nrelated: []\n---\n\n# x\n',
      "/p/wiki/concepts/exists-with-sources.md":
        '---\ntype: concept\ntitle: "y"\nsources: ["a.docx"]\ntags: []\nrelated: []\n---\n\n# y\n',
    }
    const readFile = async (path: string) => {
      const content = pages[path]
      if (content === undefined) throw new Error("not found")
      return content
    }

    const provenance = await collectReviewProvenance(
      "/p",
      review({
        affectedPages: [
          "wiki/concepts/exists-with-sources.md",
          "wiki/concepts/exists-no-sources.md",
          "wiki/queries/invented-slug.md",
        ],
      }),
      readFile,
    )

    expect(provenance.sourceIdentities).toEqual(["a.docx"])
    expect(provenance.pagesWithoutSources).toEqual(["wiki/concepts/exists-no-sources.md"])
    expect(provenance.missingPages).toEqual(["wiki/queries/invented-slug.md"])
    expect(provenance.wikiSourcePage).toBeNull()
  })

  it("escapes backslashes so YAML double-quoted scalars stay valid", () => {
    const content = buildReviewPageContent(
      { ...draft, title: "C:\\temp 报告\\" },
      review({}),
      "2026-07-02",
      ["dir\\file.docx"],
    )

    expect(content).toContain('title: "C:\\\\temp 报告\\\\"')
    expect(content).toContain('sources: ["dir\\\\file.docx"]')
  })
})

