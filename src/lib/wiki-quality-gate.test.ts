import { describe, expect, it } from "vitest"
import {
  assessWikiPageQuality,
  buildQualityRepairPrompt,
} from "./wiki-quality-gate"

describe("wiki quality gate", () => {
  const today = new Date().toISOString().slice(0, 10)

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
        "state: active",
        "confidence: high",
        "evidence_strength: strong",
        "review_status: ai_reviewed",
        "knowledge_type: operational",
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
        "## 검증 및 최신성",
        "원본 source 기준 claim과 외부 최신성 확인이 필요한 claim을 분리하고, 공식 release 확인 전에는 최신 상태를 확정하지 않는다.",
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

  it("flags invalid quality labels and stale ingest dates", () => {
    const assessment = assessWikiPageQuality(
      "wiki/sources/dify-source.md",
      [
        "---",
        "type: source",
        "title: Dify",
        'sources: ["dify.md"]',
        "state: canonical",
        "confidence: high",
        "evidence_strength: weak",
        "review_status: ai_reviewed",
        "knowledge_type: operational",
        "created: 2024-05-10",
        "updated: 2024-05-10",
        "last_reviewed: 2024-05-10",
        "quality: gold",
        "coverage: high",
        "needs_upgrade: false",
        "source_count: 1",
        "---",
        "",
        "# Dify",
        "",
        "## 요약",
        "충분한 요약입니다. ".repeat(90),
        "## Source Coverage Matrix",
        "- 반영.",
        "## Atomic Claims",
        "- claim.",
        "## Evidence Map",
        "- raw evidence.",
        "## 운영 노트",
        "- 운영 노트.",
        "## 열린 질문",
        "- 최신 공식 문서 확인 필요.",
        "## Kevin 운영체계 적용",
        "운영 적용.",
      ].join("\n"),
      { expectedDate: today, enforceIngestDates: true },
    )

    expect(assessment.issues.map((i) => i.type)).toContain("invalid-quality-metadata")
    expect(assessment.issues.map((i) => i.type)).toContain("stale-or-invalid-metadata-date")
    expect(assessment.issues.map((i) => i.type)).toContain("missing-verification")
  })

  it("requires reviewed evidence before a page can be canonical", () => {
    const assessment = assessWikiPageQuality(
      "wiki/concepts/ops.md",
      [
        "---",
        "type: concept",
        "title: Ops",
        'sources: ["ops.md"]',
        "state: canonical",
        "confidence: high",
        "evidence_strength: moderate",
        "review_status: ai_generated",
        "knowledge_type: operational",
        "quality: canonical",
        "coverage: high",
        "needs_upgrade: true",
        "source_count: 1",
        "---",
        "",
        "# Ops",
        "",
        "## 정의",
        "충분한 정의입니다. ".repeat(90),
        "## 판단 기준",
        "판단 기준.",
        "## 적용 조건",
        "적용 조건.",
        "## 실패 모드",
        "실패 모드.",
        "## 검증 및 최신성",
        "검증 필요.",
      ].join("\n"),
    )

    const invalidIssue = assessment.issues.find((i) => i.type === "invalid-quality-metadata")
    expect(invalidIssue?.message).toContain("review_status: ai_reviewed|human_reviewed|validated")
    expect(invalidIssue?.message).toContain("needs_upgrade: false")
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
      expectedDate: today,
    })

    expect(prompt.system).toContain("---FILE: wiki/sources/codexian.md---")
    expect(prompt.system).toContain("latest data or truth verification")
    expect(prompt.system).toContain("follow-up search questions")
    expect(prompt.system).toContain("Use supplied ingest verification search results")
    expect(prompt.system).toContain(`Use created/updated/last_reviewed date exactly ${today}`)
    expect(prompt.system).toContain("Never use gold")
    expect(prompt.user).toContain("## Original raw source")
    expect(prompt.user).toContain("## Ingest verification / currentness context")
    expect(prompt.user).toContain("official result")
  })
})
