import { describe, it, expect, beforeEach } from "vitest"
import {
  buildAnalysisPrompt,
  extractVerificationSearchQueries,
  buildGenerationPrompt,
  makeComparisonPagePath,
  shouldForceComparisonPage,
} from "./ingest"
import { prepareIngestSurface } from "./wiki-operational-surface"
import { useWikiStore } from "@/stores/wiki-store"

beforeEach(() => {
  useWikiStore.getState().setOutputLanguage("auto")
})

describe("buildAnalysisPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildAnalysisPrompt("purpose", "index", "english source content")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("uses user setting even when source is in a different language", () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    const prompt = buildAnalysisPrompt("", "", "这段内容是中文")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Chinese")
  })

  it("auto mode falls back to detecting source content language", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildAnalysisPrompt("", "", "これは日本語の文章です")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
  })

  it("auto mode with empty source defaults to English", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
  })

  it("contains structural analysis sections without Codex memory classification", () => {
    const prompt = buildAnalysisPrompt("", "", "")
    expect(prompt).toContain("## Key Entities")
    expect(prompt).toContain("## Key Concepts")
    expect(prompt).toContain("## Main Arguments & Findings")
    expect(prompt).toContain("## Source Coverage Matrix")
    expect(prompt).toContain("## Atomic Claims & Evidence")
    expect(prompt).toContain("## Verification & Freshness Plan")
    expect(prompt).toContain("SEARCH: query 1 | query 2 | query 3")
    expect(prompt).toContain("## Kevin / OS Implications")
    expect(prompt).toContain("## Recommendations")
    expect(prompt).not.toContain("Codexian Memory")
  })
})

describe("buildGenerationPrompt language directive", () => {
  it("injects the user's explicit language setting", () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    const prompt = buildGenerationPrompt("schema", "purpose", "index", "source.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("honors Vietnamese setting", () => {
    useWikiStore.getState().setOutputLanguage("Vietnamese")
    const prompt = buildGenerationPrompt("", "", "", "file.pdf")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Vietnamese")
  })

  it("auto mode detects from source content", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const prompt = buildGenerationPrompt("", "", "", "file.pdf", undefined, "这是中文源文档内容")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("includes the source filename in output instructions", () => {
    const prompt = buildGenerationPrompt("", "", "", "my-paper.pdf")
    expect(prompt).toContain("my-paper.pdf")
  })

  it("can disable source-summary generation for deep research query records", () => {
    const prompt = buildGenerationPrompt(
      "",
      "",
      "",
      "deep-research-karpathy.md",
      undefined,
      "딥리서치 기록",
      { skipSourceSummary: true },
    )
    expect(prompt).toContain("Do NOT generate a source summary page in wiki/sources/")
    expect(prompt).not.toContain("A source summary page at **wiki/sources/deep-research-karpathy.md**")
  })

  it("can pin a canonical source-summary title for query-only deep research", () => {
    const prompt = buildGenerationPrompt(
      "",
      "",
      "",
      "deep-research-karpathy.md",
      undefined,
      "딥리서치 기록",
      { sourceSummaryTitle: "안드레 카파시 스킬" },
    )
    expect(prompt).toContain("A source summary page at **wiki/sources/안드레 카파시 스킬 소스 요약.md**")
    expect(prompt).toContain('use frontmatter title and H1 exactly: "안드레 카파시 스킬 소스 요약"')
    expect(prompt).toContain("Do not use the original filename, raw research question, or command text as the page title")
  })

  it("does not generate Codex memory page types or profile review guardrails", () => {
    const prompt = buildGenerationPrompt("", "", "", "session.md")
    expect(prompt).toContain("source | entity | concept | comparison | synthesis | query | decision")
    expect(prompt).not.toContain("workflow | session | profile")
    expect(prompt).not.toContain("durable profile")
    expect(prompt).not.toContain("profile memory")
  })

  it("respects user setting regardless of source content language", () => {
    useWikiStore.getState().setOutputLanguage("English")
    const prompt = buildGenerationPrompt("", "", "", "x.pdf", undefined, "私は日本語の文章を書きます")
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("OUTPUT LANGUAGE: Japanese")
  })

  it("requires a comparison page for explicitly comparative sources", () => {
    const prompt = buildGenerationPrompt("", "", "", "OpenClaw vs Hermes.md")
    expect(prompt).toContain("A comparison page in wiki/comparisons/ is REQUIRED")
    expect(prompt).toContain("wiki/comparisons/OpenClaw vs Hermes.md")
    expect(prompt).toContain("type: comparison")
  })

  it("requires high-quality wiki sections and thin-page guardrails", () => {
    const prompt = buildGenerationPrompt("", "", "", "important-source.md")
    expect(prompt).toContain("## Quality Contract")
    expect(prompt).toContain("## Source Coverage Matrix")
    expect(prompt).toContain("## Atomic Claims")
    expect(prompt).toContain("## Evidence Map")
    expect(prompt).toContain("## 검증 및 최신성")
    expect(prompt).toContain("## Kevin 운영체계 적용")
    expect(prompt).toContain("Thin page guard")
    expect(prompt).toContain("Verification and freshness")
    expect(prompt).toContain("Treat the raw source as primary evidence")
    expect(prompt).toContain("Ingest Verification Search Results")
    expect(prompt).toContain("do not postpone those checks to Deep Research")
    expect(prompt).toContain("Never claim latest/current status")
    expect(prompt).toContain("Do not set `coverage: high` with `needs_upgrade: false`")
    expect(prompt).toContain("`wiki/index.md` must link only to existing pages")
    expect(prompt).toContain("compact human index")
    expect(prompt).toContain("must not list `retention: ephemeral`")
    expect(prompt).toContain(".llm-wiki/health.json")
    expect(prompt).toContain("needs_upgrade: true")
    expect(prompt).toContain("quality — seed | draft | reviewed | canonical")
    expect(prompt).toContain("state — seed | draft | active | canonical | deprecated | archived")
    expect(prompt).toContain("evidence_strength — weak | moderate | strong")
    expect(prompt).toContain("review_status — ai_generated | ai_reviewed | human_reviewed | validated")
    expect(prompt).toContain("knowledge_type — conceptual | operational | experimental | strategic")
    expect(prompt).toContain("retention — ephemeral | reusable | promote | archive")
    expect(prompt).toContain("Never write gold")
  })
})

describe("ingest verification query extraction", () => {
  it("extracts machine-readable verification search queries from analysis", () => {
    const analysis = [
      "## Verification & Freshness Plan",
      "- 확인 필요",
      "SEARCH: Codex CLI latest release official docs | Claude Code MCP skills current docs | Hermes memory architecture source verification",
    ].join("\n")

    expect(extractVerificationSearchQueries(analysis)).toEqual([
      "Codex CLI latest release official docs",
      "Claude Code MCP skills current docs",
    ])
  })
})

describe("comparison source detection", () => {
  it("detects comparison intent from filename", () => {
    expect(shouldForceComparisonPage("OpenClaw vs Hermes.md")).toBe(true)
    expect(makeComparisonPagePath("OpenClaw vs Hermes.md")).toBe(
      "wiki/comparisons/OpenClaw vs Hermes.md",
    )
  })

  it("detects comparison intent from frontmatter tags and tables", () => {
    const source = [
      "---",
      "tags: [ai-agent, comparison]",
      "---",
      "",
      "# 도구 비교",
      "",
      "| 구분 | A | B |",
      "| --- | --- | --- |",
      "| 강점 | 데이터 | 실행 |",
    ].join("\n")
    expect(shouldForceComparisonPage("agent-tools.md", source)).toBe(true)
  })

  it("does not force comparison for incidental comparison words only", () => {
    const source = "RLHF datasets include many paired comparisons, but this note is not a tool-vs-tool analysis."
    expect(shouldForceComparisonPage("rlhf-survey.md", source)).toBe(false)
  })
})

describe("analysis + generation prompt consistency", () => {
  // Both stages MUST declare the same target language — otherwise the wiki
  // files generated in stage 2 may disagree with the analysis from stage 1.
  it("both stages declare the same language for a given setting", () => {
    useWikiStore.getState().setOutputLanguage("Korean")
    const analysis = buildAnalysisPrompt("", "", "")
    const generation = buildGenerationPrompt("", "", "", "f.pdf")
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("both stages in auto mode agree on detected language from source", () => {
    useWikiStore.getState().setOutputLanguage("auto")
    const korean = "이것은 한국어 문장입니다"
    const analysis = buildAnalysisPrompt("", "", korean)
    const generation = buildGenerationPrompt("", "", "", "f.pdf", undefined, korean)
    expect(analysis).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
    expect(generation).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })
})


describe("ingest operational surface", () => {
  it("caps bootstrap docs deterministically and records excluded surfaces without content", () => {
    const hugeSchema = Array.from({ length: 2000 }, (_, index) => `contract rule ${index}`).join("\n")
    const first = prepareIngestSurface({
      purpose: "# Purpose\n\nShort purpose.",
      schema: hugeSchema,
      index: "# Index\n\n- [[Canonical Page]]",
      overview: "# Overview\n\nCurrent snapshot.",
    }, new Date("2026-05-12T00:00:00.000Z"))
    const second = prepareIngestSurface({
      purpose: "# Purpose\n\nShort purpose.",
      schema: hugeSchema,
      index: "# Index\n\n- [[Canonical Page]]",
      overview: "# Overview\n\nCurrent snapshot.",
    }, new Date("2026-05-12T00:00:00.000Z"))

    expect(first.docs.schema.truncated).toBe(true)
    expect(first.docs.schema.content).toBe(second.docs.schema.content)
    expect(first.snapshot.docs.find((doc) => doc.id === "schema")?.truncated).toBe(true)
    expect(first.snapshot.excludedSections).toContain(".llm-wiki/log-archive/*")
    expect(JSON.stringify(first.snapshot)).not.toContain("contract rule 1999")
  })
})
