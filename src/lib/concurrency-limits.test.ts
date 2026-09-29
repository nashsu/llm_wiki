import { describe, expect, it } from "vitest"
import { clampUserConcurrency } from "./concurrency-limits"

describe("clampUserConcurrency", () => {
  it("allows values through 64 and clamps invalid values", () => {
    expect(clampUserConcurrency(64)).toBe(64)
    expect(clampUserConcurrency(100)).toBe(64)
    expect(clampUserConcurrency(0)).toBe(1)
    expect(clampUserConcurrency(2.9)).toBe(2)
    expect(clampUserConcurrency(Number.NaN, 4)).toBe(4)
  })
})
