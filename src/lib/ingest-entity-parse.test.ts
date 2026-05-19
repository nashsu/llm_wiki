import { describe, it, expect } from "vitest"
import { dedupAndBatchEntities } from "./ingest"

// Note: parseEntityListFromAnalysis was removed when the parser moved
// to `./analysis` as `parseAnalysisOutput`. Tests for that parser live
// in `./analysis.test.ts`.

describe("dedupAndBatchEntities", () => {
  it("returns empty array for empty input", () => {
    expect(dedupAndBatchEntities([], 10)).toEqual([])
  })

  it("dedupes case-insensitively, keeping the first occurrence's casing", () => {
    const items = [
      { name: "Activity Based Costing", type: "concept" as const },
      { name: "activity based costing", type: "concept" as const },
      { name: "ACTIVITY BASED COSTING", type: "concept" as const },
    ]
    const batches = dedupAndBatchEntities(items, 10)
    expect(batches).toEqual([[{ name: "Activity Based Costing", type: "concept" }]])
  })

  it("splits into batches of the requested size", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      name: `Entity ${i}`,
      type: "entity" as const,
    }))
    const batches = dedupAndBatchEntities(items, 10)
    expect(batches.length).toBe(3)
    expect(batches[0].length).toBe(10)
    expect(batches[1].length).toBe(10)
    expect(batches[2].length).toBe(5)
  })

  it("preserves entity/concept type in batches", () => {
    const items = [
      { name: "A", type: "entity" as const },
      { name: "B", type: "concept" as const },
    ]
    const batches = dedupAndBatchEntities(items, 10)
    expect(batches[0]).toEqual([
      { name: "A", type: "entity" },
      { name: "B", type: "concept" },
    ])
  })

  it("throws on batchSize <= 0", () => {
    expect(() => dedupAndBatchEntities([{ name: "x", type: "entity" }], 0)).toThrow()
    expect(() => dedupAndBatchEntities([{ name: "x", type: "entity" }], -1)).toThrow()
  })

  it("returns one batch when item count equals batch size", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      name: `E${i}`,
      type: "entity" as const,
    }))
    expect(dedupAndBatchEntities(items, 20).length).toBe(1)
  })

  it("preserves extra fields like chunkIndex (generic over input type)", () => {
    // Ingest pipeline attaches chunkIndex to each entity before batching;
    // the generic signature on dedupAndBatchEntities means downstream
    // batches still carry chunkIndex through, no widening.
    const items = [
      { name: "FIFO", type: "concept" as const, chunkIndex: 0 },
      { name: "LIFO", type: "concept" as const, chunkIndex: 1 },
    ]
    const batches = dedupAndBatchEntities(items, 10)
    expect(batches[0][0].chunkIndex).toBe(0)
    expect(batches[0][1].chunkIndex).toBe(1)
  })
})
