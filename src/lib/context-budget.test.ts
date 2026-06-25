/**
 * Unit tests for computeContextBudget.
 *
 * The function is pure, so tests can pin exact integer outputs. The
 * scenarios below are picked deliberately to exercise the boundaries
 * we care about:
 *   - tiny configs (8K-class models)
 *   - mid configs (32K, 128K)
 *   - large configs (200K — the previous default + cap boundary)
 *   - huge configs (1M — the case the old 30K cap actively wasted)
 *   - degenerate inputs (0, undefined, NaN)
 */
import { describe, it, expect } from "vitest"
import { computeContextBudget } from "./context-budget"

describe("computeContextBudget", () => {
  it("falls back to 204,800 chars when input is undefined / 0 / NaN", () => {
    expect(computeContextBudget(undefined).maxCtx).toBe(204_800)
    expect(computeContextBudget(0).maxCtx).toBe(204_800)
    expect(computeContextBudget(NaN).maxCtx).toBe(204_800)
  })

  it("8K-class small model: per-page cap clamps to pageBudget so one page can fully use the budget", () => {
    const b = computeContextBudget(8_192)
    // pageBudget = 4,096 (50%); per-page floor of 5,000 would exceed
    // that, so per-page MUST clamp down to pageBudget itself.
    // Otherwise tryAddPage would slice to 5K, then reject the slice
    // for being > 4K total budget — net result: page never makes it.
    expect(b.pageBudget).toBe(4_096)
    expect(b.maxPageSize).toBe(4_096)
    expect(b.responseReserve).toBe(1_228)
    expect(b.indexBudget).toBe(409)
  })

  it("32K mid-tier: floor of 5,000 chars/page is the binding cap, not the 30% rule", () => {
    const b = computeContextBudget(32_000)
    // pageBudget = 16,000; 30% = 4,800 < 5,000 floor → maxPageSize = 5,000.
    // Pin this so a regression that drops the floor would surface as
    // a tiny per-page truncation on small-context configs.
    expect(b.pageBudget).toBe(16_000)
    expect(b.maxPageSize).toBe(5_000)
  })

  it("128K config: 30% rule kicks in, per-page = 19,200", () => {
    const b = computeContextBudget(131_072)
    expect(b.pageBudget).toBe(65_536)
    // 65,536 * 0.3 = 19,660.8 → floor = 19,660. Well above the 5K floor.
    expect(b.maxPageSize).toBe(19_660)
  })

  it("200K config (legacy default): per-page is 30,720 — NOT the old 30,000 cap", () => {
    const b = computeContextBudget(204_800)
    expect(b.pageBudget).toBe(102_400)
    expect(b.maxPageSize).toBe(30_720) // proportional, not capped at 30K
    expect(b.responseReserve).toBe(30_720)
    expect(b.indexBudget).toBe(10_240)
  })

  it("1M config: per-page is 150,000 — used to be capped at 30K, wasting 5x the budget", () => {
    const b = computeContextBudget(1_000_000)
    expect(b.pageBudget).toBe(500_000)
    // 500_000 * 0.3 = 150_000. Old code would have returned min(150K, 30K) = 30K
    // and never allowed a long page through.
    expect(b.maxPageSize).toBe(150_000)
    expect(b.responseReserve).toBe(150_000)
    expect(b.indexBudget).toBe(50_000)
  })

  it("budgets always sum to ≤ maxCtx (never over-provision)", () => {
    // Index + pages + response reserve must leave room for system
    // prompt + conversation history + user query. Anything over 100%
    // would overflow context immediately.
    for (const maxCtx of [4_000, 32_000, 128_000, 204_800, 1_000_000]) {
      const b = computeContextBudget(maxCtx)
      const sum = b.indexBudget + b.pageBudget + b.responseReserve
      expect(sum, `maxCtx=${maxCtx}: index+pages+response=${sum} > ${maxCtx}`).toBeLessThanOrEqual(maxCtx)
      // And we should leave a meaningful chunk (≥20%) for history +
      // system prompt. 100% - 5% - 50% - 15% = 30% remaining.
      expect(maxCtx - sum, `maxCtx=${maxCtx}: only ${maxCtx - sum} left for history/prompt`).toBeGreaterThanOrEqual(
        Math.floor(maxCtx * 0.2),
      )
    }
  })

  it("response reserve is exactly 15% (regression guard for the new behavior)", () => {
    // If someone bumps RESPONSE_RESERVE_FRAC, EVERY ratio elsewhere
    // shifts. Pin it at the boundary.
    expect(computeContextBudget(100_000).responseReserve).toBe(15_000)
    expect(computeContextBudget(1_000_000).responseReserve).toBe(150_000)
  })

  it("maxPageSize never exceeds pageBudget (a single page can't outgrow the entire page budget)", () => {
    for (const maxCtx of [1_000, 2_000, 5_000, 8_192, 16_000, 32_000, 100_000, 1_000_000]) {
      const b = computeContextBudget(maxCtx)
      expect(
        b.maxPageSize,
        `maxCtx=${maxCtx}: maxPageSize=${b.maxPageSize} > pageBudget=${b.pageBudget}`,
      ).toBeLessThanOrEqual(b.pageBudget)
    }
  })
})
