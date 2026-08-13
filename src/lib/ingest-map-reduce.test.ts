/**
 * Proves analyzeLongSourceInChunksMapReduce actually runs chunk analysis
 * concurrently (not just that it's correct) — a mocked streamChat with a
 * fixed artificial delay makes wall-clock time a direct, deterministic
 * measurement of concurrency, with no real LLM/network involved.
 */
import { describe, it, expect } from "vitest"
import { analyzeLongSourceInChunksMapReduce } from "./ingest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage } from "@/lib/llm-client"

const FAKE_LLM_CONFIG = { provider: "custom", model: "fake", maxContextSize: 60_000 } as LlmConfig
const CALL_DELAY_MS = 300

function paragraph(seed: number): string {
  return `Paragraph ${seed}. `.repeat(200) + "\n\n"
}

// ~180k chars of distinct paragraphs — long enough to produce several
// chunks (need >4 to actually exercise multi-batch concurrency at
// LONG_SOURCE_MAP_CONCURRENCY=4) at a modest sourceBudget.
const LONG_CONTENT = Array.from({ length: 70 }, (_, i) => paragraph(i)).join("")

function makeDelayedStreamFn(callLog: number[]) {
  return async (
    _llmConfig: LlmConfig,
    messages: ChatMessage[],
    handlers: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void },
  ) => {
    const start = Date.now()
    await new Promise((resolve) => setTimeout(resolve, CALL_DELAY_MS))
    callLog.push(Date.now() - start)
    const systemContent = messages[0].content
    const isReduce = typeof systemContent === "string" && systemContent.includes("merging independent chunk analyses")
    handlers.onToken(
      isReduce
        ? "## Final Global Digest\nmerged digest content"
        : "## Chunk Analysis\nsummary for this chunk",
    )
    handlers.onDone()
  }
}

describe("analyzeLongSourceInChunksMapReduce", () => {
  it("returns chunked:false and passes content through unchanged when short", async () => {
    const callLog: number[] = []
    const result = await analyzeLongSourceInChunksMapReduce(
      FAKE_LLM_CONFIG,
      "purpose",
      "schema",
      "index",
      "short.md",
      undefined,
      "short content",
      60_000,
      undefined,
      undefined,
      makeDelayedStreamFn(callLog),
    )
    expect(result.chunked).toBe(false)
    expect(result.sourceContext).toBe("short content")
    expect(callLog.length).toBe(0)
  })

  it("analyzes chunks concurrently — wall time is batched, not N times the per-call delay", async () => {
    const callLog: number[] = []
    const progress: Array<[number, number]> = []
    const t0 = Date.now()
    const result = await analyzeLongSourceInChunksMapReduce(
      FAKE_LLM_CONFIG,
      "purpose",
      "schema",
      "index",
      "book.pdf",
      undefined,
      LONG_CONTENT,
      60_000,
      undefined,
      (done, total) => progress.push([done, total]),
      makeDelayedStreamFn(callLog),
    )
    const elapsedMs = Date.now() - t0

    // Correctness: real chunking happened, reduce phase ran, digest present.
    expect(result.chunked).toBe(true)
    expect(result.analysis).toContain("merged digest content")
    expect(result.sourceContext).toContain("map-reduce")
    const chunkCount = callLog.length - 1 // last call is the reduce call
    expect(chunkCount).toBeGreaterThan(4) // otherwise this test isn't exercising concurrency at all
    expect(progress[progress.length - 1]).toEqual([chunkCount, chunkCount])

    // Concurrency proof: sequential (refine-style) would cost
    // chunkCount * CALL_DELAY_MS + one reduce call. Map-reduce at
    // concurrency 4 costs ceil(chunkCount/4) batches + one reduce call.
    const sequentialWouldBeMs = (chunkCount + 1) * CALL_DELAY_MS
    const batches = Math.ceil(chunkCount / 4)
    const mapReduceExpectedMs = (batches + 1) * CALL_DELAY_MS
    console.log(`[map-reduce test] chunks=${chunkCount} elapsed=${elapsedMs}ms sequential-would-be=${sequentialWouldBeMs}ms map-reduce-expected=${mapReduceExpectedMs}ms`)

    expect(elapsedMs).toBeLessThan(sequentialWouldBeMs * 0.7) // well under sequential, not just marginally
    expect(elapsedMs).toBeLessThan(mapReduceExpectedMs + 500) // sanity margin for scheduler jitter
  })
})
