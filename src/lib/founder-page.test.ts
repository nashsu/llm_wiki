import { describe, expect, it } from "vitest"
import {
  canPublishFounderPage,
  isGeneratedFrankBrainProjection,
  requiresLocalFounderSynthesis,
  unavailableFounderResult,
  validateFounderPage,
} from "./founder-page"

const valid = {
  schema_version: "founder-page/v1",
  type: "synthesis",
  title: "Current Priorities",
  source_id: "frankbrain",
  source_slug: "current-priorities",
  content_hash: "a".repeat(64),
  evidence_refs: ["gbrain://default/evidence"],
  status: "review",
  owner: "founder",
  confidence: "0.9",
  verified_at: "2026-08-09",
  review_by: "2026-08-16",
  sensitivity: "local_only",
  contradictions: [],
  supersedes: [],
}

describe("FounderPage governance", () => {
  it("validates the versioned contract", () => {
    expect(validateFounderPage(valid, "wiki/inbox/fbrain/current-priorities.md")).toEqual({
      valid: true,
      errors: [],
    })
  })

  it("detects projection paths and metadata", () => {
    expect(isGeneratedFrankBrainProjection("wiki/frankbrain/page.md", valid)).toBe(true)
    expect(isGeneratedFrankBrainProjection("wiki/synthesis/page.md", {
      ...valid,
      projection: "true",
    })).toBe(true)
  })

  it("requires founder approval and the proposal inbox for publishing", () => {
    expect(canPublishFounderPage(valid, "wiki/synthesis/page.md", true).valid).toBe(false)
    expect(canPublishFounderPage(valid, "wiki/inbox/fbrain/page.md", false).valid).toBe(false)
    expect(canPublishFounderPage(valid, "wiki/inbox/fbrain/page.md", true).valid).toBe(true)
  })

  it("returns an explicit unavailable result without references", () => {
    expect(unavailableFounderResult()).toMatchObject({
      status: "unavailable",
      answer: "unavailable",
      grounding_source: "none",
      references: [],
      confidence: 0,
    })
  })

  it("keeps gbrain and projected founder evidence on local synthesis", () => {
    expect(requiresLocalFounderSynthesis([
      { kind: "gbrain", path: "wiki/canonical/current-priorities.md" },
    ])).toBe(true)
    expect(requiresLocalFounderSynthesis([
      { kind: "wiki", path: "wiki/frankbrain/strategy.md" },
    ])).toBe(true)
    expect(requiresLocalFounderSynthesis([
      { kind: "wiki", path: "wiki/public/product.md" },
    ])).toBe(false)
    expect(requiresLocalFounderSynthesis([
      { kind: "wiki", path: "wiki/entities/jarvis.md" },
    ], "/Users/example/FrankBrain")).toBe(true)
  })
})
