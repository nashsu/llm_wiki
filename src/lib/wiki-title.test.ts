import { describe, expect, it } from "vitest"
import {
  buildRawDocumentNamePlan,
  buildRawFolderName,
  buildResearchQueryFileName,
  buildSourceSummaryPlan,
  canonicalizeWikiTitle,
  isNoisyWikiTitle,
} from "./wiki-title"

describe("wiki title normalization", () => {
  it("removes research/log prefixes and command words", () => {
    expect(canonicalizeWikiTitle("Research: Hermes에 대해서 조사해서 최신자료 기준으로 정리해줘.")).toBe("Hermes")
    expect(canonicalizeWikiTitle("Research Log: 안드레 카파시 스킬")).toBe("안드레 카파시 스킬")
  })

  it("builds research query filenames from the canonical result title", () => {
    expect(buildResearchQueryFileName("Hermes Agent Operating Model", "2026-05-09", "123456")).toBe(
      "Hermes Agent Operating Model (20260509 123456).md",
    )
  })

  it("derives source summary paths from readable titles, not raw filenames", () => {
    const plan = buildSourceSummaryPlan(
      "OpenClaw vs Hermes-20260509.md",
      "---\ntitle: \"OpenClaw vs Hermes: 에이전트 데이터 엔진과 운영 콘솔의 비교\"\n---\n# OpenClaw vs Hermes\n",
    )

    expect(plan.path).toBe("wiki/sources/OpenClaw vs Hermes 에이전트 데이터 엔진과 운영 콘솔의 비교 소스 요약.md")
    expect(plan.titleSlug).toBe("OpenClaw vs Hermes 에이전트 데이터 엔진과 운영 콘솔의 비교")
    expect(plan.title).toBe("OpenClaw vs Hermes: 에이전트 데이터 엔진과 운영 콘솔의 비교 소스 요약")
  })

  it("flags generated log-style titles as noisy", () => {
    expect(isNoisyWikiTitle("Research: Open claw girhub repo에서 최신 공식자료 확인하고 정리해줘.")).toBe(true)
    expect(isNoisyWikiTitle("LLM Wiki API 비용 최적화 가이드")).toBe(false)
  })

  it("normalizes raw source filenames into readable unicode file stems", () => {
    const plan = buildRawDocumentNamePlan("대한민국 판례 저장소.md")

    expect(plan.title).toBe("대한민국 판례 저장소")
    expect(plan.fileName).toBe("대한민국 판례 저장소.md")
  })

  it("removes noisy deep-research prefixes and timestamps from raw imports", () => {
    const plan = buildRawDocumentNamePlan(
      "deep-research-안드레이-카파시가-만든-skill-조사해서-핵심-인사이트-정리해줘-2026-05-09-135309.md",
    )

    expect(plan.fileName).toBe("안드레이 카파시가 만든 skill 핵심 인사이트.md")
  })

  it("prefers markdown frontmatter title when naming raw imports", () => {
    const plan = buildRawDocumentNamePlan(
      "untitled.md",
      "---\ntitle: \"대한민국 법령 저장소\"\n---\n# 다른 제목\n",
    )

    expect(plan.fileName).toBe("대한민국 법령 저장소.md")
  })

  it("normalizes raw folder names with the same policy", () => {
    expect(buildRawFolderName("Deep Research - 대한민국 판례 저장소 2026-05-10")).toBe("대한민국 판례 저장소")
  })
})
