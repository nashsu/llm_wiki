/**
 * dedup_embedding.test.ts — unit tests for #359 prefilter (R4)
 */
import { describe, it, expect, vi } from "vitest"
import {
  candidatePairs,
  clusterByPairs,
  cosineSimilarity,
  pageToEmbeddingText,
  type Page,
} from "../dedup_embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"

// Mock fetchEmbedding to produce realistic, sparse vectors.
// Strategy: numeric id suffix → topic axis (mod dim). Pages with same
// numeric suffix share a topic (e.g. p1 and q1 both on axis 1), but
// consecutive ids (p0, p1, p2, ...) land on consecutive axes → low mutual
// similarity. This mirrors real-world embeddings where distinct topics
// have distinct dominant axes.
vi.mock("../embedding", () => ({
  fetchEmbedding: vi.fn(async (text: string) => {
    const dim = 64
    const v = new Array(dim).fill(0)
    // Extract numeric portion from the input text (pageId is first line)
    const idLine = text.split("\n")[0] ?? ""
    const numMatch = idLine.match(/\d+/)
    const num = numMatch ? parseInt(numMatch[0], 10) : 0
    const topicAxis = num % dim
    v[topicAxis] = 1.0
    v[(topicAxis + 1) % dim] = 0.05
    v[(topicAxis - 1 + dim) % dim] = 0.03
    return v
  }),
}))

const testCfg: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://localhost:0/v1/embeddings",
  apiKey: "mock-key",
  model: "mock-embedder",
}

const page = (id: string, title: string, body = ""): Page => ({
  id, title, body, tags: [],
})

describe('pageToEmbeddingText', () => {
  it('concatenates title + tags + body', () => {
    const text = pageToEmbeddingText({
      id: "p1", title: "Foo", body: "bar baz", tags: ["a", "b"],
    })
    expect(text).toBe("p1\nFoo\na b\nbar baz")
  })

  it('truncates body at budget', () => {
    const longBody = "x".repeat(2000)
    const text = pageToEmbeddingText({ id: "p2", title: "T", body: longBody }, 100)
    expect(text.length).toBeLessThan(120)
    expect(text).toContain("x".repeat(100))
  })

  it('handles empty tags and body', () => {
    expect(pageToEmbeddingText({ id: "p3", title: "Solo" })).toBe("p3\nSolo")
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 5);
  });
  it('returns 0 for null vectors', () => {
    expect(cosineSimilarity(null, [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], null)).toBe(0);
  });
  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });
});

describe('candidatePairs', () => {
  it('returns empty array for empty input', async () => {
    expect(await candidatePairs([], testCfg)).toEqual([]);
  });

  it('returns empty for single page (self-exclusion)', async () => {
    expect(await candidatePairs([page('a', 'Foo')], testCfg)).toEqual([]);
  });

  it('generates symmetric, deduplicated pairs', async () => {
    // p11 and q11 share axis 11 → high sim
    const pages = [
      page('p11', 'Foo bar baz'),
      page('q11', 'completely different topic'),
      page('p12', 'yet another topic'),
      page('q12', 'totally unrelated'),
    ];
    const pairs = await candidatePairs(pages, testCfg, { threshold: 0.8 });
    expect(pairs.every(([x, y]) => x !== y)).toBe(true);
    const keys = pairs.map(([x, y]) => x < y ? `${x}|${y}` : `${y}|${x}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('respects threshold filter (higher threshold → fewer pairs)', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => page(`p${i}`, `t${i}`));
    const high = await candidatePairs(pages, testCfg, { threshold: 0.99 });
    const low  = await candidatePairs(pages, testCfg, { threshold: 0.5 });
    expect(low.length).toBeGreaterThanOrEqual(high.length);
  });

  it('respects topK (caps total pairs at topK * n)', async () => {
    // With numeric-id mock: p0..p19 → distinct axes 0..19.
    // topK=3 means each page iteration contributes AT MOST 3 NEW pairs to pairSet.
    // Worst case: each iteration adds 3 NEW pairs → max = topK * n = 60.
    const pages = Array.from({ length: 20 }, (_, i) => page(`p${i}`, `t${i}`));
    const pairs = await candidatePairs(pages, testCfg, { threshold: 0.0, topK: 3 });
    expect(pairs.length).toBeLessThanOrEqual(60);
  });

  it('scales to 1000 pages with realistic output (acceptance for #359)', async () => {
    // 1000 pages with ids p0..p999 → 64 distinct axes (15-16 pages per axis).
    // Acceptance: <3000 candidate pairs (300× reduction vs R1's N² baseline).
    const pages = Array.from({ length: 1000 }, (_, i) => page(`p${i}`, `s${i}`));
    const t0 = Date.now();
    const pairs = await candidatePairs(pages, testCfg, { threshold: 0.95, topK: 3 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5000);
    expect(pairs.length).toBeLessThan(3000);
    expect(pairs.length).toBeGreaterThan(0); // sanity: dedup actually ran
  });

  it('skips pages whose embedding returns null', async () => {
    // Override mock for this test only: make p1 and p2 fail embedding
    const { fetchEmbedding } = await import('../embedding');
    const origFetch = (fetchEmbedding as any).getMockImplementation();
    (fetchEmbedding as any).mockImplementationOnce(async () => null); // p1
    (fetchEmbedding as any).mockImplementationOnce(async () => null); // p2
    (fetchEmbedding as any).mockImplementationOnce(async () => [1, 0]); // p3 axis 0
    (fetchEmbedding as any).mockImplementationOnce(async () => [1, 0]); // p3 dup axis 0

    const pages = [
      page('p1', 'A'),
      page('p2', 'B'),
      page('p3', 'C'),
      page('p4', 'D'),
    ];
    // p3 and p4 both have id-axes → high sim → should pair
    const pairs = await candidatePairs(pages, testCfg, {
      minSuccessRatio: 0.5,
      threshold: 0.5,
    });
    // null embeddings: p1 and p2 won't contribute as SOURCE; may still appear as TARGET
    // but no pairs should reference them since no other page has a vector to compare
    expect(pairs.every(([a, b]) => a !== 'p1' && b !== 'p1' && a !== 'p2' && b !== 'p2')).toBe(true);
    // restore
    (fetchEmbedding as any).mockImplementation(origFetch);
  });

  it("throws when too few pages embed successfully", async () => {
    const { fetchEmbedding } = await import("../embedding");
    const origFetch = (fetchEmbedding as any).getMockImplementation();
    (fetchEmbedding as any).mockImplementation(async () => null);

    await expect(
      candidatePairs(
        [page("p1", "A"), page("p2", "B"), page("p3", "C")],
        testCfg,
      ),
    ).rejects.toThrow(/could not embed enough pages|embedded only/i);

    (fetchEmbedding as any).mockImplementation(origFetch);
  });

  it("throws when most pages fail to embed", async () => {
    const { fetchEmbedding } = await import("../embedding");
    const origFetch = (fetchEmbedding as any).getMockImplementation();
    (fetchEmbedding as any)
      .mockImplementationOnce(async () => [1, 0])
      .mockImplementationOnce(async () => [1, 0])
      .mockImplementation(async () => null);

    await expect(
      candidatePairs(
        [
          page("p1", "A"),
          page("p2", "B"),
          page("p3", "C"),
          page("p4", "D"),
        ],
        testCfg,
      ),
    ).rejects.toThrow(/embedded only 2\/4/i);

    (fetchEmbedding as any).mockImplementation(origFetch);
  });

  it("honors an already-aborted signal before embedding work starts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      candidatePairs(
        [page("p1", "A"), page("p2", "B")],
        testCfg,
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/i);
  });
});

describe('clusterByPairs', () => {
  it('returns empty for no pairs', () => {
    expect(clusterByPairs(['a','b'], [])).toEqual([]);
  });

  it('groups transitive duplicates', () => {
    const groups = clusterByPairs(['a','b','c'], [['a','b'], ['b','c']]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['a','b','c']);
  });

  it('keeps isolated pages separate', () => {
    const groups = clusterByPairs(['a','b','c'], [['a','b']]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['a','b']);
  });

  it('handles 10k page IDs without stack overflow (R1 review Major)', () => {
    const ids = Array.from({ length: 10000 }, (_, i) => `id${i}`);
    const pairs: Array<readonly [string, string]> = [];
    for (let i = 0; i < 5000; i++) {
      pairs.push([`id${i}`, `id${i + 1}`] as const);
    }
    expect(() => clusterByPairs(ids, pairs)).not.toThrow();
    const groups = clusterByPairs(ids, pairs);
    expect(groups.length).toBe(1);
  });
});
