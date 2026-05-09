import { describe, expect, it } from "vitest"
import {
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
      "hermes-agent-operating-model-2026-05-09-123456.md",
    )
  })

  it("derives source summary paths from readable titles, not raw filenames", () => {
    const plan = buildSourceSummaryPlan(
      "OpenClaw vs Hermes-20260509.md",
      "---\ntitle: \"OpenClaw vs Hermes: 에이전트 데이터 엔진과 운영 콘솔의 비교\"\n---\n# OpenClaw vs Hermes\n",
    )

    expect(plan.path).toBe("wiki/sources/openclaw-vs-hermes-에이전트-데이터-엔진과-운영-콘솔의-비교-source.md")
    expect(plan.titleSlug).toBe("openclaw-vs-hermes-에이전트-데이터-엔진과-운영-콘솔의-비교")
    expect(plan.title).toBe("OpenClaw vs Hermes: 에이전트 데이터 엔진과 운영 콘솔의 비교")
  })

  it("flags generated log-style titles as noisy", () => {
    expect(isNoisyWikiTitle("Research: Open claw girhub repo에서 최신 공식자료 확인하고 정리해줘.")).toBe(true)
    expect(isNoisyWikiTitle("LLM Wiki API 비용 최적화 가이드")).toBe(false)
  })
})
