import { describe, expect, it } from "vitest"
import {
  buildDeterministicIngestLogEntry,
  findMissingWikiReferences,
  missingReferencesToReviewItems,
  type WikiPageSnapshot,
} from "./ingest-integrity"

function page(relativePath: string, title: string, body = ""): WikiPageSnapshot {
  return {
    relativePath,
    content: [
      "---",
      `title: ${title}`,
      "related: []",
      "---",
      "",
      body,
    ].join("\n"),
  }
}

describe("findMissingWikiReferences", () => {
  it("flags wikilinks and related entries that do not exist after ingest", () => {
    const pages = [
      page("concepts/persistent-wiki.md", "Persistent Wiki"),
      page("sources/LLM Wiki 개인 지식베이스 구축 입문 가이드.md", "LLM Wiki 개인 지식베이스 구축 입문 가이드", [
        "See [[persistent-wiki]] and [[knowledge-gardening]].",
      ].join("\n")),
      {
        relativePath: "log.md",
        content: [
          "---",
          "title: 위키 로그",
          "---",
          "",
          "- 신규 개념 생성: [[pilot-execution-guide]]",
        ].join("\n"),
      },
      {
        relativePath: "concepts/llm-wiki-concept.md",
        content: [
          "---",
          "title: LLM Wiki 운영 워크플로",
          "related: [persistent-wiki, editor-p]",
          "---",
          "",
          "Body.",
        ].join("\n"),
      },
    ]

    expect(findMissingWikiReferences(pages, [
      "sources/LLM Wiki 개인 지식베이스 구축 입문 가이드.md",
      "log.md",
      "concepts/llm-wiki-concept.md",
    ])).toEqual([
      {
        target: "editor-p",
        pages: ["concepts/llm-wiki-concept.md"],
      },
      {
        target: "knowledge-gardening",
        pages: ["sources/LLM Wiki 개인 지식베이스 구축 입문 가이드.md"],
      },
      {
        target: "pilot-execution-guide",
        pages: ["log.md"],
      },
    ])
  })

  it("flags title-only links because the app resolver navigates by file path or slug", () => {
    const pages = [
      page("concepts/rotary-position-embedding.md", "Rotary Position Embedding"),
      page("sources/rope.md", "RoPE Source", "See [[Rotary Position Embedding]]."),
    ]

    expect(findMissingWikiReferences(pages, ["sources/rope.md"])).toEqual([
      {
        target: "Rotary Position Embedding",
        pages: ["sources/rope.md"],
      },
    ])
  })
})

describe("missingReferencesToReviewItems", () => {
  it("turns missing targets into missing-page review items", () => {
    const items = missingReferencesToReviewItems(
      [{ target: "editor-p", pages: ["sources/a.md", "log.md"] }],
      "/project/raw/sources/a.md",
    )

    expect(items).toMatchObject([
      {
        type: "missing-page",
        title: "Missing wiki page: editor-p",
        sourcePath: "/project/raw/sources/a.md",
        affectedPages: ["wiki/sources/a.md", "wiki/log.md"],
        options: [
          { label: "Create Page", action: "Create Page" },
          { label: "Skip", action: "Skip" },
        ],
      },
    ])
  })
})

describe("buildDeterministicIngestLogEntry", () => {
  it("lists only actual non-log files written", () => {
    const entry = buildDeterministicIngestLogEntry(
      "source.md",
      ["wiki/log.md", "wiki/index.md", "wiki/concepts/a.md"],
      "2026-05-09",
    )

    expect(entry).toContain("## [2026-05-09] ingest | source")
    expect(entry).toContain("- Files written: 2")
    expect(entry).toContain("  - `wiki/concepts/a.md`")
    expect(entry).toContain("  - `wiki/index.md`")
    expect(entry).not.toContain("  - `wiki/log.md`")
  })
})
