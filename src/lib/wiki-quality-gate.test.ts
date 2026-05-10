import { describe, expect, it } from "vitest"
import {
  assessWikiPageQuality,
  buildQualityRepairPrompt,
} from "./wiki-quality-gate"

describe("wiki quality gate", () => {
  it("flags thin source summaries that miss evidence and quality metadata", () => {
    const assessment = assessWikiPageQuality(
      "wiki/sources/codexian.md",
      [
        "---",
        "type: source",
        "title: Codexian",
        'sources: ["codexian.md"]',
        "confidence: high",
        "---",
        "",
        "# Codexian",
        "",
        "## 요약",
        "짧은 요약.",
      ].join("\n"),
    )

    expect(assessment.shouldRepair).toBe(true)
    expect(assessment.issues.map((i) => i.type)).toContain("missing-quality-metadata")
    expect(assessment.issues.map((i) => i.type)).toContain("source-coverage-gap")
    expect(assessment.issues.map((i) => i.type)).toContain("missing-operating-implication")
  })

  it("accepts a source page with coverage, evidence, freshness, and quality metadata", () => {
    const assessment = assessWikiPageQuality(
      "wiki/sources/codexian.md",
      [
        "---",
        "type: source",
        "title: Codexian",
        'sources: ["codexian.md"]',
        "confidence: high",
        "quality: reviewed",
        "coverage: high",
        "needs_upgrade: false",
        "source_count: 1",
        "---",
        "",
        "# Codexian",
        "",
        "## 요약",
        "충분한 요약입니다. ".repeat(90),
        "## Source Coverage Matrix",
        "| section | reflected |",
        "| --- | --- |",
        "| Memory Map | yes |",
        "## Atomic Claims",
        "- Codexian wraps Codex CLI inside Obsidian.",
        "## Evidence Map",
        "| claim | source |",
        "| --- | --- |",
        "| CLI wrapper | codexian.md |",
        "## 오래 유지할 개념",
        "- [[memory-map]]",
        "## 관련 엔티티",
        "- [[codexian]]",
        "## Kevin 운영체계 적용",
        "AI Native Solo Business OS 실행 엔진 계층에 두고, Vault 안의 source trace와 실행 권한 경계를 함께 관리한다.",
        "## 운영 노트",
        "Review mode first를 기본 운영 원칙으로 두고, Auto/Yolo 권한은 백업과 diff 검토가 가능한 실험에서만 사용한다.",
        "## 열린 질문",
        "최신 release 확인은 별도 검색으로 검증하고, 공식 저장소와 manifest 기준이 다르면 canonical claim로 승격하지 않는다.",
      ].join("\n"),
    )

    expect(assessment.issues).toEqual([])
    expect(assessment.shouldRepair).toBe(false)
  })

  it("builds a repair prompt that keeps verification inside ingest", () => {
    const prompt = buildQualityRepairPrompt({
      relativePath: "wiki/sources/codexian.md",
      content: "# Codexian\n\n짧음",
      sourceFileName: "codexian.md",
      sourceContent: "raw",
      analysis: "analysis",
      verificationContext: "## Ingest Verification Search Results\n[1] official result",
      issues: [{ type: "missing-verification", message: "needs freshness check" }],
    })

    expect(prompt.system).toContain("---FILE: wiki/sources/codexian.md---")
    expect(prompt.system).toContain("latest data or truth verification")
    expect(prompt.system).toContain("follow-up search questions")
    expect(prompt.system).toContain("Use supplied ingest verification search results")
    expect(prompt.user).toContain("## Original raw source")
    expect(prompt.user).toContain("## Ingest verification / currentness context")
    expect(prompt.user).toContain("official result")
  })
})
