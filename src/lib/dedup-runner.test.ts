/**
 * Integration test for the Dedup pass (ADR 0005) — runDedupPass.
 * Every component (clustering, recall, detection, merge) is unit-
 * tested elsewhere; this pins the wiring: pre-filter → detect →
 * auto-merge vs Review routing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}))
vi.mock("@/lib/llm-client", () => ({ streamChat: vi.fn() }))
vi.mock("@/lib/embedding", () => ({ searchByEmbedding: vi.fn() }))
vi.mock("@/lib/dedup-storage", () => ({ loadNotDuplicates: vi.fn() }))

import { listDirectory, readFile, writeFile, deleteFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { searchByEmbedding } from "@/lib/embedding"
import { loadNotDuplicates } from "@/lib/dedup-storage"
import { runDedupPass } from "./dedup-runner"
import type { LlmConfig, EmbeddingConfig } from "@/stores/wiki-store"

const mockList = vi.mocked(listDirectory)
const mockRead = vi.mocked(readFile)
const mockWrite = vi.mocked(writeFile)
const mockDelete = vi.mocked(deleteFile)
const mockStream = vi.mocked(streamChat)
const mockSearch = vi.mocked(searchByEmbedding)
const mockNotDup = vi.mocked(loadNotDuplicates)

const LLM = {} as LlmConfig
const EMB = { enabled: false } as EmbeddingConfig

const page = (title: string, body: string) =>
  `---\ntype: concept\ntitle: ${title}\n---\n\n# ${title}\n\n${body}`

let disk: Map<string, string>

beforeEach(() => {
  vi.clearAllMocks()
  disk = new Map([
    ["/p/wiki/concepts/map-reduce.md", page("MapReduce", "A programming model for batch processing of large data.")],
    ["/p/wiki/concepts/mapreduce.md", page("MapReduce", "The MapReduce paradigm splits work into a map step and a reduce step.")],
  ])
  mockList.mockImplementation(async () =>
    [...disk.keys()].map((p) => ({ name: p.slice(p.lastIndexOf("/") + 1), path: p, is_dir: false })) as never,
  )
  mockRead.mockImplementation(async (p: string) => {
    const c = disk.get(p)
    if (c === undefined) throw new Error(`missing: ${p}`)
    return c
  })
  mockWrite.mockImplementation(async (p: string, c: string) => {
    disk.set(p, c)
  })
  mockDelete.mockImplementation(async (p: string) => {
    disk.delete(p)
  })
  mockSearch.mockResolvedValue([]) // embeddings off → dedupKey pre-filter only
  mockNotDup.mockResolvedValue([])
})

/** Drive streamChat: detector vs merger by system-prompt content. */
function mockLlm(detectorJson: string) {
  mockStream.mockImplementation((async (
    _cfg: unknown,
    messages: Array<{ content: string }>,
    cb: { onToken: (t: string) => void; onDone: () => void },
  ) => {
    const system = messages[0].content
    const isMerger = system.includes("Merge them into a single coherent")
    cb.onToken(isMerger ? page("MapReduce", "Unified description of the MapReduce model.") : detectorJson)
    cb.onDone()
  }) as never)
}

describe("runDedupPass", () => {
  it("auto-merges a confident, non-contradictory duplicate group", async () => {
    mockLlm(
      JSON.stringify({
        groups: [
          {
            slugs: ["map-reduce", "mapreduce"],
            canonicalSlug: "map-reduce",
            reason: "same concept",
            confidence: "high",
            contradictory: false,
          },
        ],
      }),
    )

    const result = await runDedupPass("/p", ["wiki/concepts/map-reduce.md"], LLM, EMB)

    expect(result.merged).toHaveLength(1)
    expect(result.merged[0].canonicalPath).toBe("wiki/concepts/map-reduce.md")
    expect(result.merged[0].deletedPaths).toEqual(["wiki/concepts/mapreduce.md"])
    expect(result.reviews).toEqual([])
    // The loser is gone from disk.
    expect(disk.has("/p/wiki/concepts/mapreduce.md")).toBe(false)
  })

  it("routes a contradictory group to a Review instead of merging", async () => {
    mockLlm(
      JSON.stringify({
        groups: [
          {
            slugs: ["map-reduce", "mapreduce"],
            canonicalSlug: "map-reduce",
            reason: "same name but conflicting definitions",
            confidence: "high",
            contradictory: true,
          },
        ],
      }),
    )

    const result = await runDedupPass("/p", ["wiki/concepts/map-reduce.md"], LLM, EMB)

    expect(result.merged).toEqual([])
    expect(result.reviews).toHaveLength(1)
    expect(result.reviews[0].type).toBe("duplicate")
    expect(result.reviews[0].affectedPages).toEqual([
      "wiki/concepts/map-reduce.md",
      "wiki/concepts/mapreduce.md",
    ])
    // Nothing deleted — both pages survive for the human.
    expect(disk.has("/p/wiki/concepts/mapreduce.md")).toBe(true)
  })

  it("does nothing when the seed has no duplicates", async () => {
    mockLlm(JSON.stringify({ groups: [] }))
    const result = await runDedupPass("/p", ["wiki/concepts/map-reduce.md"], LLM, EMB)
    expect(result.merged).toEqual([])
    expect(result.reviews).toEqual([])
  })
})
