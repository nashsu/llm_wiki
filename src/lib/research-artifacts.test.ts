import { describe, expect, it } from "vitest"
import {
  buildPrimaryResearchPage,
  buildResearchRecordPage,
  buildResearchSavePlan,
  cleanResearchSynthesis,
  classifyResearchArtifact,
} from "./research-artifacts"
import type { WebSearchResult } from "./web-search"

const results: WebSearchResult[] = [
  { title: "One", url: "https://example.com/one", snippet: "Alpha", source: "example.com" },
  { title: "Two", url: "https://example.com/two", snippet: "Beta", source: "example.com" },
]

describe("research artifact classification", () => {
  it("classifies explicit versus research as comparison", () => {
    const out = classifyResearchArtifact({
      topic: "OpenClaw vs Hermes 비교 분석",
      synthesis: "| 구분 | OpenClaw | Hermes |\n| --- | --- | --- |\n| 역할 | 데이터 | 운영 |",
      webResults: results,
    })

    expect(out.type).toBe("comparison")
  })

  it("classifies reusable multi-source research as synthesis", () => {
    const out = classifyResearchArtifact({
      topic: "Hermes에 대해서 조사해서 최신자료 기준으로 정리해줘.",
      synthesis: "## 요약\nHermes 운영 모델과 핵심 전략을 종합한다.",
      webResults: results,
    })

    expect(out.type).toBe("synthesis")
  })

  it("does not classify follow-up comparison-data mentions as comparison", () => {
    const out = classifyResearchArtifact({
      topic: "안드레이 카파시 (Andrej Karpathy)가 만든 skill 조사해서 핵심 인싸이트 정리해줘.",
      synthesis: [
        "# 안드레 카파시 스킬",
        "카파시 스킬의 핵심 원칙을 종합한다.",
        "## 추가 조사가 필요한 사항",
        "- 실제 기업 환경에서 카파시 스킬 도입 전후의 버그 발생률 비교 데이터 확보.",
      ].join("\n"),
      webResults: results,
    })

    expect(out.type).toBe("synthesis")
  })

  it("keeps unresolved single-source follow-up as query", () => {
    const out = classifyResearchArtifact({
      topic: "Hermes v0.8 이후 MCP 연동 사례가 있는지 추가 조사해줘?",
      synthesis: "추가 조사가 필요하다.",
      webResults: [results[0]],
    })

    expect(out.type).toBe("query")
  })
})

describe("research save plan", () => {
  it("saves a query record and a primary synthesis artifact separately", () => {
    const plan = buildResearchSavePlan({
      topic: "Hermes에 대해서 조사해서 최신자료 기준으로 정리해줘.",
      synthesis: [
        "---",
        "title: Hermes Agent Operating Model",
        "---",
        "# Hermes Agent Operating Model",
        "Hermes는 [[obsidian]]과 연결된다.",
      ].join("\n"),
      webResults: results,
      now: new Date("2026-05-09T12:34:56.000Z"),
    })

    expect(plan.primaryType).toBe("synthesis")
    expect(plan.queryRecordPath).toBe(
      "wiki/queries/Hermes Agent Operating Model (20260509 123456).md",
    )
    expect(plan.primaryPath).toBe("wiki/synthesis/Hermes Agent Operating Model.md")
    expect(plan.related).toEqual(["obsidian"])
  })

  it("uses comparison folder for comparison artifacts", () => {
    const plan = buildResearchSavePlan({
      topic: "OpenClaw vs Hermes",
      synthesis: "# OpenClaw vs Hermes\n비교 결론",
      webResults: results,
      now: new Date("2026-05-09T12:34:56.000Z"),
    })

    expect(plan.primaryType).toBe("comparison")
    expect(plan.primaryPath).toBe("wiki/comparisons/OpenClaw vs Hermes.md")
  })

  it("strips thinking and model-emitted frontmatter before page construction", () => {
    const cleaned = cleanResearchSynthesis("<think>hidden</think>\n---\ntitle: X\n---\n# X\nBody")
    const page = buildPrimaryResearchPage({
      type: "synthesis",
      title: "X",
      date: "2026-05-09",
      content: cleaned,
      queryRecordFileName: "deep-research-x.md",
      references: "1. Source",
      related: [],
    })

    expect(page).toContain("type: synthesis")
    expect(page).toContain("quality: draft")
    expect(page).toContain("state: draft")
    expect(page).toContain("evidence_strength: moderate")
    expect(page).toContain("review_status: ai_generated")
    expect(page).toContain("knowledge_type: strategic")
    expect(page).toContain("coverage: medium")
    expect(page).toContain("needs_upgrade: true")
    expect(page).toContain("freshness_required: true")
    expect(page).toContain("source_count: 1")
    expect(page).toContain("## Verification & Freshness")
    expect(page).not.toContain("<think>")
    expect(page).not.toContain("title: X\n---\n# X")
  })

  it("strips loose metadata lines when the model omits frontmatter fences", () => {
    const cleaned = cleanResearchSynthesis(
      "title: Hermes tags: [ai-agent] related: [obsidian] created: 2026-05-09\n# Hermes\nBody",
    )

    expect(cleaned).toBe("# Hermes\nBody")
  })

  it("uses the canonical result title for the query log instead of the prompt text", () => {
    const page = buildResearchRecordPage({
      topic: "안드레이 카파시 (Andrej Karpathy)가 만든 skill 조사해서 핵심 인싸이트 정리해줘.",
      title: "안드레 카파시 스킬",
      date: "2026-05-09",
      content: "# 안드레 카파시 스킬\n핵심 내용.",
      references: "1. Source",
    })

    expect(page).toContain('title: "안드레 카파시 스킬"')
    expect(page).toContain('original_query: "안드레이 카파시 (Andrej Karpathy)가 만든 skill 조사해서 핵심 인싸이트 정리해줘."')
    expect(page).toContain("# 안드레 카파시 스킬")
    expect(page).toContain("## Original Query")
    expect(page).toContain("quality: draft")
    expect(page).toContain("state: draft")
    expect(page).toContain("evidence_strength: moderate")
    expect(page).toContain("review_status: ai_generated")
    expect(page).toContain("knowledge_type: experimental")
    expect(page).toContain("retention: ephemeral")
    expect(page).toContain("coverage: medium")
    expect(page).toContain("needs_upgrade: true")
    expect(page).toContain("freshness_required: true")
    expect(page).toContain("source_count: 1")
    expect(page).toContain("## Evidence / Source Trace")
    expect(page).toContain("조사해서 핵심 인싸이트 정리해줘")
  })
})
