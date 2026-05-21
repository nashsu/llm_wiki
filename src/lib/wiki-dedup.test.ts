/**
 * ADR 0005 stage 1: dedupKey clustering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/embedding", () => ({ searchByEmbedding: vi.fn() }))

import { searchByEmbedding } from "@/lib/embedding"
import {
  findDedupKeyClusters,
  findSemanticCandidates,
  buildDedupCandidateSets,
} from "./wiki-dedup"
import type { EmbeddingConfig } from "@/stores/wiki-store"

const mockSearch = vi.mocked(searchByEmbedding)
const CFG = { enabled: true, model: "m" } as EmbeddingConfig

describe("findDedupKeyClusters", () => {
  it("clusters case / camelCase / punctuation variants of one id", () => {
    const clusters = findDedupKeyClusters([
      "wiki/concepts/MapReduce.md",
      "wiki/concepts/map-reduce.md",
      "wiki/concepts/mapreduce.md",
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0].key).toBe("mapreduce")
    expect(clusters[0].paths).toEqual([
      "wiki/concepts/MapReduce.md",
      "wiki/concepts/map-reduce.md",
      "wiki/concepts/mapreduce.md",
    ])
  })

  it("does not cluster genuinely distinct pages", () => {
    expect(
      findDedupKeyClusters([
        "wiki/concepts/raft.md",
        "wiki/concepts/paxos.md",
        "wiki/entities/zookeeper.md",
      ]),
    ).toEqual([])
  })

  it("keeps distinct version numbers in separate buckets", () => {
    // 99.9% vs 99.99% — different concepts, no cluster.
    expect(
      findDedupKeyClusters([
        "wiki/concepts/99-9-availability.md",
        "wiki/concepts/99-99-availability.md",
      ]),
    ).toEqual([])
  })

  it("clusters a cross-folder dedupKey collision (type collision candidate)", () => {
    const clusters = findDedupKeyClusters([
      "wiki/concepts/ntp.md",
      "wiki/entities/ntp.md",
    ])
    expect(clusters).toHaveLength(1)
    expect(clusters[0].paths).toEqual(["wiki/concepts/ntp.md", "wiki/entities/ntp.md"])
  })

  it("returns no clusters for empty or single-page input", () => {
    expect(findDedupKeyClusters([])).toEqual([])
    expect(findDedupKeyClusters(["wiki/concepts/raft.md"])).toEqual([])
  })

  it("emits clusters sorted by key", () => {
    const clusters = findDedupKeyClusters([
      "wiki/concepts/x-open-xa.md",
      "wiki/concepts/xopen-xa.md",
      "wiki/concepts/Aries-IM.md",
      "wiki/concepts/aries-im.md",
    ])
    expect(clusters.map((c) => c.key)).toEqual(["ariesim", "xopenxa"])
  })
})

describe("buildDedupCandidateSets", () => {
  it("emits a dedupKey cluster that contains a seed", () => {
    const sets = buildDedupCandidateSets(
      ["wiki/concepts/mapreduce.md"],
      ["wiki/concepts/mapreduce.md", "wiki/concepts/map-reduce.md", "wiki/concepts/raft.md"],
      new Map(),
    )
    expect(sets).toEqual([["wiki/concepts/map-reduce.md", "wiki/concepts/mapreduce.md"]])
  })

  it("skips dedupKey clusters with no seed", () => {
    const sets = buildDedupCandidateSets(
      ["wiki/concepts/raft.md"],
      ["wiki/concepts/mapreduce.md", "wiki/concepts/map-reduce.md", "wiki/concepts/raft.md"],
      new Map(),
    )
    expect(sets).toEqual([])
  })

  it("emits a seed together with its vector neighbours", () => {
    const sets = buildDedupCandidateSets(
      ["wiki/concepts/gossip.md"],
      ["wiki/concepts/gossip.md", "wiki/concepts/gossip-protocol.md"],
      new Map([["wiki/concepts/gossip.md", ["wiki/concepts/gossip-protocol.md"]]]),
    )
    expect(sets).toEqual([["wiki/concepts/gossip-protocol.md", "wiki/concepts/gossip.md"]])
  })

  it("emits each distinct set once", () => {
    // The dedupKey cluster and the semantic set are identical here.
    const sets = buildDedupCandidateSets(
      ["wiki/concepts/MapReduce.md"],
      ["wiki/concepts/MapReduce.md", "wiki/concepts/mapreduce.md"],
      new Map([["wiki/concepts/MapReduce.md", ["wiki/concepts/mapreduce.md"]]]),
    )
    expect(sets).toHaveLength(1)
  })

  it("drops a seed whose neighbour list is empty", () => {
    expect(
      buildDedupCandidateSets(["wiki/concepts/raft.md"], ["wiki/concepts/raft.md"], new Map()),
    ).toEqual([])
  })
})

describe("findSemanticCandidates", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns vector hits, excluding the page itself", async () => {
    mockSearch.mockResolvedValue([
      { id: "concepts/gossip-protocol", score: 0.99 },
      { id: "concepts/anti-entropy", score: 0.81 },
      { id: "concepts/raft", score: 0.62 },
    ])
    const out = await findSemanticCandidates("/p", "concepts/gossip-protocol", "Gossip Protocol", CFG)
    expect(out.map((c) => c.pageId)).toEqual(["concepts/anti-entropy", "concepts/raft"])
  })

  it("excludes self case-insensitively", async () => {
    mockSearch.mockResolvedValue([
      { id: "Concepts/Gossip", score: 0.97 },
      { id: "concepts/anti-entropy", score: 0.7 },
    ])
    const out = await findSemanticCandidates("/p", "concepts/gossip", "Gossip", CFG)
    expect(out.map((c) => c.pageId)).toEqual(["concepts/anti-entropy"])
  })

  it("caps the result at topK", async () => {
    mockSearch.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ id: `concepts/p${i}`, score: 1 - i * 0.05 })),
    )
    const out = await findSemanticCandidates("/p", "concepts/self", "Self", CFG, 3)
    expect(out).toHaveLength(3)
  })
})
