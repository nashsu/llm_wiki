import { describe, it, expect } from "vitest"
import {
  chunkForAnalysis,
  computeAnalysisChunkSize,
  computeGenerationContentBudget,
} from "./ingest"

describe("chunkForAnalysis", () => {
  it("returns input unchanged when it fits in one chunk", () => {
    const content = "a".repeat(500)
    expect(chunkForAnalysis(content, 1000, 100)).toEqual([content])
  })

  it("splits content larger than chunkSize", () => {
    const content = "a".repeat(2500)
    const chunks = chunkForAnalysis(content, 1000, 100)
    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk obeys the size cap.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000)
  })

  it("overlap preserves content at chunk boundaries", () => {
    const content = "abcdefghij".repeat(200) // 2000 chars
    const chunks = chunkForAnalysis(content, 1000, 100)
    expect(chunks.length).toBe(3)
    // Tail of chunk[0] must appear in head of chunk[1] (= the overlap).
    const tail = chunks[0].slice(-100)
    expect(chunks[1].startsWith(tail)).toBe(true)
  })

  it("eventually covers the entire input even with overlap", () => {
    const content = "x".repeat(5000)
    const chunks = chunkForAnalysis(content, 1000, 100)
    // Last chunk's end position must reach the end of the input.
    // Reconstruct by stride to verify full coverage.
    const stride = 1000 - 100
    const lastStart = (chunks.length - 1) * stride
    expect(lastStart + chunks[chunks.length - 1].length).toBeGreaterThanOrEqual(content.length)
  })

  it("handles overlap >= chunkSize defensively without infinite loop", () => {
    // chunkForAnalysis floors stride at 1 so a misconfigured overlap
    // doesn't hang. We just want this to terminate.
    const content = "a".repeat(50)
    const chunks = chunkForAnalysis(content, 10, 100)
    expect(chunks.length).toBeGreaterThan(0)
  })
})

describe("computeAnalysisChunkSize", () => {
  it("uses default 200k context when maxContextSize is undefined", () => {
    // 200_000 - 12_000 overhead - 16_000 response = 172_000
    expect(computeAnalysisChunkSize(undefined)).toBe(172_000)
  })

  it("uses default for zero/negative maxContextSize", () => {
    expect(computeAnalysisChunkSize(0)).toBe(172_000)
    expect(computeAnalysisChunkSize(-5000)).toBe(172_000)
  })

  it("scales linearly with the model's context window", () => {
    // 100_000 - 12_000 - 16_000 = 72_000
    expect(computeAnalysisChunkSize(100_000)).toBe(72_000)
    // 1_000_000 - 12_000 - 16_000 = 972_000
    expect(computeAnalysisChunkSize(1_000_000)).toBe(972_000)
  })

  it("floors at the minimum chunk size for tiny configs", () => {
    // Tiny context (e.g. 16k chars) would compute negative budget; floor kicks in.
    expect(computeAnalysisChunkSize(16_000)).toBe(10_000)
    expect(computeAnalysisChunkSize(1_000)).toBe(10_000)
  })
})

describe("computeGenerationContentBudget", () => {
  it("reserves more space than analysis (8192 vs 4096 tokens)", () => {
    // For the same context window, generation budget is smaller because
    // it reserves more response tokens.
    const ctx = 200_000
    expect(computeGenerationContentBudget(ctx))
      .toBeLessThan(computeAnalysisChunkSize(ctx))
  })

  it("default 200k context yields 156k budget", () => {
    // 200_000 - 12_000 overhead - 32_000 response = 156_000
    expect(computeGenerationContentBudget(undefined)).toBe(156_000)
  })

  it("floors at the minimum for tiny configs", () => {
    expect(computeGenerationContentBudget(20_000)).toBe(10_000)
  })
})
