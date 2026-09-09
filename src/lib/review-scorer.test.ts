import { describe, it, expect } from "vitest"
import { buildScoringPrompt, parseScoresResponse, scoreToTier } from "@/lib/review-scorer"
import type { ReviewItem } from "@/stores/review-store"

function item(partial: Partial<ReviewItem> & { id: string; title: string }): ReviewItem {
  return {
    type: "suggestion",
    description: "",
    options: [],
    resolved: false,
    createdAt: 0,
    ...partial,
  }
}

describe("review-scorer scoreToTier", () => {
  it("maps boundaries to keep/maybe/drop", () => {
    expect(scoreToTier(80)).toBe("keep")
    expect(scoreToTier(100)).toBe("keep")
    expect(scoreToTier(79)).toBe("maybe")
    expect(scoreToTier(40)).toBe("maybe")
    expect(scoreToTier(39)).toBe("drop")
    expect(scoreToTier(0)).toBe("drop")
  })
})

describe("buildScoringPrompt", () => {
  it("includes every id, type, title and truncated description", () => {
    const longDesc = "建议对照权威框架".repeat(100) // 700 chars, must be truncated
    const items = [
      item({ id: "r-1", type: "suggestion", title: "补 OWASP 对照", description: longDesc }),
      item({ id: "r-2", type: "contradiction", title: "A vs B 矛盾", description: "两处说法不一" }),
    ]
    const prompt = buildScoringPrompt(items)
    expect(prompt).toContain("id=r-1 [suggestion] 补 OWASP 对照")
    expect(prompt).toContain("id=r-2 [contradiction] A vs B 矛盾")
    expect(prompt).toContain("score 80-100")
    // The 700-char description is truncated to ≤160 chars: the full
    // repeated text must NOT appear verbatim in the prompt.
    expect(prompt).not.toContain(longDesc)
    expect(prompt).toContain("建议对照权威框架".repeat(10)) // leading chars survive
  })
})

describe("parseScoresResponse", () => {
  const batchIds = new Set(["r-1", "r-2", "r-3"])

  it("parses valid scores and drops out-of-batch / invalid entries", () => {
    const raw = JSON.stringify({
      scores: [
        { id: "r-1", score: 92, tier: "keep", reason: "real gap" },
        { id: "r-2", score: 30, tier: "drop", reason: "noise" },
        { id: "r-unknown", score: 50, tier: "maybe", reason: "not in batch" },
        { id: "r-3", score: 999, tier: "maybe", reason: "clamped" },
      ],
    })
    const out = parseScoresResponse(raw, batchIds)
    expect(out).toHaveLength(3)
    const r1 = out.find((s) => s.id === "r-1")!
    expect(r1.score).toBe(92)
    expect(r1.tier).toBe("keep")
    const r3 = out.find((s) => s.id === "r-3")!
    expect(r3.score).toBe(100) // clamped
  })

  it("tolerates markdown fences and trailing text", () => {
    const raw = "```json\n" + JSON.stringify({ scores: [{ id: "r-1", score: 55, tier: "maybe", reason: "ok" }] }) + "\n```"
    const out = parseScoresResponse(raw, batchIds)
    expect(out).toHaveLength(1)
    expect(out[0].tier).toBe("maybe")
  })

  it("returns [] on garbage / missing scores array", () => {
    expect(parseScoresResponse("not json at all", batchIds)).toEqual([])
    expect(parseScoresResponse(JSON.stringify({ nope: true }), batchIds)).toEqual([])
    expect(parseScoresResponse("", batchIds)).toEqual([])
  })

  it("falls back tier to scoreToTier when tier is missing or invalid", () => {
    const raw = JSON.stringify({
      scores: [
        { id: "r-1", score: 10, reason: "no tier" },
        { id: "r-2", score: 90, tier: "bogus", reason: "bad tier" },
      ],
    })
    const out = parseScoresResponse(raw, batchIds)
    expect(out.find((s) => s.id === "r-1")!.tier).toBe("drop")
    expect(out.find((s) => s.id === "r-2")!.tier).toBe("keep")
  })
})
