/**
 * Real embedding-endpoint tests — covers what mock tests CANNOT:
 *
 *  1. The HTTP response actually parses into `number[]` with the
 *     expected shape.
 *  2. The endpoint returns semantically-meaningful vectors — similar
 *     sentences really do land closer than unrelated ones. If the
 *     mocked pipeline is green but this suite fails, the bug is in
 *     the server / model / response parsing, not the control flow.
 *  3. The `looksLikeOversizeError` heuristic keywords match the
 *     actual phrasing a real server returns on oversize input (the
 *     mock tests use a synthetic body — a heuristic-miss regression
 *     would only show up here).
 *  4. The auto-halve loop actually recovers from real oversize
 *     responses end-to-end (plugin-http / fetch / body-parse edge
 *     cases, not just the retry arithmetic).
 *
 * Gated behind `RUN_LLM_TESTS=1` AND an explicit `EMBEDDING_ENDPOINT`
 * env. We deliberately DON'T default to a known host — tests must
 * target the user's own endpoint (LM Studio / Ollama / a hosted
 * service) so the cost stays local.
 *
 * Tauri `invoke` is stubbed: LanceDB isn't reachable under Node, and
 * the Rust side has its own 15-test suite. We only exercise the
 * TypeScript HTTP layer + the semantic contract here.
 */
import { describe, it, expect, vi, beforeAll } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

// A scriptable `invoke` stub so individual tests can (a) capture what
// embedPage tries to write to LanceDB, and (b) swap in an in-memory
// implementation of vector_search_chunks so we can exercise
// searchByEmbedding end-to-end without a real LanceDB instance.
const mockInvoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import {
  embedPage,
  fetchEmbedding,
  looksLikeOversizeError,
  getLastEmbeddingError,
  searchByEmbedding,
} from "./embedding"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1" &&
  !!process.env.EMBEDDING_ENDPOINT &&
  !!process.env.EMBEDDING_MODEL

const cfg = {
  enabled: true,
  endpoint: process.env.EMBEDDING_ENDPOINT ?? "",
  apiKey: process.env.EMBEDDING_API_KEY ?? "",
  model: process.env.EMBEDDING_MODEL ?? "",
}

/** Cosine similarity — defined here (not imported) so the ranking
 *  logic and the test's idea of "similar" stay independent. */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`dim mismatch: ${a.length} vs ${b.length}`)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const TEST_TIMEOUT_MS = 2 * 60 * 1000

describe("real-embedding endpoint contract", () => {
  it.skipIf(!ENABLED)(
    "returns a finite-number vector of consistent dim for short input",
    async () => {
      const v1 = await fetchEmbedding("hello world", cfg)
      expect(v1, `fetchEmbedding failed: ${getLastEmbeddingError()}`).not.toBeNull()
      expect(Array.isArray(v1)).toBe(true)
      expect(v1!.length).toBeGreaterThan(0)
      // Every element must be a finite number — NaN / Infinity in the
      // returned vector would poison LanceDB's distance math.
      for (const x of v1!) {
        expect(typeof x).toBe("number")
        expect(Number.isFinite(x)).toBe(true)
      }

      // Two more calls to pin dim consistency — a regression that
      // flipped between two endpoints or two models would show up as
      // length drift here.
      const v2 = await fetchEmbedding("another sentence", cfg)
      const v3 = await fetchEmbedding("a third one", cfg)
      expect(v2!.length).toBe(v1!.length)
      expect(v3!.length).toBe(v1!.length)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!ENABLED)(
    "embeds the same text twice to near-identical vectors (determinism)",
    async () => {
      const text = "Rotary positional embeddings in Transformers."
      const a = (await fetchEmbedding(text, cfg))!
      const b = (await fetchEmbedding(text, cfg))!
      const sim = cosineSim(a, b)
      // Most servers are deterministic (sim ≈ 1.0). Some add a tiny
      // bit of quantization noise. Anything below 0.99 means the
      // endpoint is non-deterministic or the pipeline is corrupting
      // the response — either way, search ranking becomes unstable.
      expect(sim).toBeGreaterThan(0.99)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!ENABLED)(
    "embeds semantically-similar sentences to closer vectors than unrelated ones",
    async () => {
      // A ~ B (both about RoPE / positional encoding in Transformers)
      // C: an unrelated dessert topic.
      const A = "Rotary positional embeddings are a Transformer position-encoding scheme."
      const B = "RoPE is a rotary positional embedding method commonly used in LLM attention."
      const C = "Chocolate ice cream is a classic dessert flavor made from cream, sugar, and cocoa."

      const [vA, vB, vC] = await Promise.all([
        fetchEmbedding(A, cfg),
        fetchEmbedding(B, cfg),
        fetchEmbedding(C, cfg),
      ])
      expect(vA).not.toBeNull()
      expect(vB).not.toBeNull()
      expect(vC).not.toBeNull()

      const simAB = cosineSim(vA!, vB!)
      const simAC = cosineSim(vA!, vC!)
      const simBC = cosineSim(vB!, vC!)

      // eslint-disable-next-line no-console
      console.log(
        `[real-embedding] similarity — A~B: ${simAB.toFixed(4)}, A~C: ${simAC.toFixed(4)}, B~C: ${simBC.toFixed(4)}`,
      )

      // The margin (0.05) is conservative: even weaker embedding
      // models should comfortably separate "RoPE" from "ice cream".
      // If this fails, the endpoint is almost certainly returning
      // a near-constant vector or the model id is wrong.
      expect(simAB).toBeGreaterThan(simAC + 0.05)
      expect(simAB).toBeGreaterThan(simBC + 0.05)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!ENABLED)(
    "oversize phrase heuristic matches what the real server returns on oversize input",
    async () => {
      // Blast the endpoint with a deliberately-huge input via raw
      // fetch (bypassing fetchEmbedding's auto-halve). If the server
      // accepts it, we have nothing to validate — skip. If it rejects,
      // the error body must match `looksLikeOversizeError`, otherwise
      // the heuristic is missing a phrase used by this server.
      const huge = "a".repeat(500_000)
      const resp = await fetch(cfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model, input: huge }),
      })

      if (resp.ok) {
        // eslint-disable-next-line no-console
        console.log(
          `[real-embedding] endpoint accepted 500k-char input (context is large); skipping oversize-phrase assertion`,
        )
        return
      }

      const body = await resp.text()
      // eslint-disable-next-line no-console
      console.log(`[real-embedding] oversize response: HTTP ${resp.status} — ${body.slice(0, 200)}`)

      expect(
        looksLikeOversizeError(resp.status, body),
        `Heuristic missed the real server's oversize phrasing. status=${resp.status} body=${body.slice(0, 300)}. Add the missing phrase to looksLikeOversizeError.`,
      ).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!ENABLED)(
    "auto-halve recovers or surfaces the specific error on the real endpoint (best-effort — many large-context servers silently truncate)",
    async () => {
      const bigText = "The quick brown fox jumps over the lazy dog. ".repeat(5_000)
      const v = await fetchEmbedding(bigText, cfg)

      if (v !== null) {
        expect(Number.isFinite(v[0])).toBe(true)
        expect(getLastEmbeddingError()).toBeNull()
        // eslint-disable-next-line no-console
        console.log(
          `[real-embedding] NOTE: endpoint accepted ~225k-char input without rejecting — real halving path was NOT exercised against this server. ` +
            `See the "fake small-context server" test below for the end-to-end halving proof.`,
        )
        return
      }

      const err = getLastEmbeddingError()!
      // eslint-disable-next-line no-console
      console.log(`[real-embedding] auto-halve gave up: ${err}`)
      expect(
        err,
        "fetchEmbedding returned null on oversize input but error isn't the oversize-specific message — looksLikeOversizeError missed the server's phrasing",
      ).toContain("Endpoint rejected input even at")
    },
    TEST_TIMEOUT_MS,
  )
})

// ── Fake small-context HTTP server — guarantees the halving path ───
//
// The real embedding endpoint (qwen3-embedding-0.6b on LM Studio)
// silently truncates multi-megabyte inputs, which means the halving
// retry loop is NEVER exercised end-to-end against it. This block
// spins up a tiny local HTTP server that rejects inputs longer than
// a configured threshold with a llama.cpp-style error body, so we
// can prove the full HTTP → parse → looksLikeOversizeError → halve
// → retry → success cycle actually works over real TCP. Unlike the
// mocked tests (which swap out getHttpFetch entirely), this exercises
// the same plugin-http / globalThis.fetch code path production uses.

interface FakeServerHandle {
  url: string
  requestCount: () => number
  requestSizes: () => number[]
  close: () => Promise<void>
}

/**
 * Starts a local HTTP server on 127.0.0.1 that behaves like an
 * OpenAI-compatible /v1/embeddings endpoint with a small context:
 *
 *   - input.length > maxInputChars → HTTP 400 with the error body
 *     `{"error":"input length N exceeds maximum context M"}` (matches
 *     the phrasing looksLikeOversizeError is designed to catch).
 *   - otherwise → HTTP 200 with a deterministic vector of the given
 *     dimension (value = sin(i) so it's not all-zeros).
 */
async function startFakeEmbeddingServer(
  maxInputChars: number,
  dim = 8,
): Promise<FakeServerHandle> {
  let server: Server | null = null
  const sizes: number[] = []
  const url = await new Promise<string>((resolve, reject) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
            input: string
          }
          sizes.push(body.input.length)
          if (body.input.length > maxInputChars) {
            res.statusCode = 400
            res.setHeader("Content-Type", "application/json")
            res.end(
              JSON.stringify({
                error: `input length ${body.input.length} exceeds maximum context ${maxInputChars}`,
              }),
            )
            return
          }
          const vec = Array.from({ length: dim }, (_, i) => Math.sin(i + 1) * 0.1)
          res.statusCode = 200
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ data: [{ embedding: vec }] }))
        } catch (err) {
          res.statusCode = 500
          res.end(String(err))
        }
      })
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as AddressInfo
      resolve(`http://127.0.0.1:${addr.port}/v1/embeddings`)
    })
  })
  return {
    url,
    requestCount: () => sizes.length,
    requestSizes: () => [...sizes],
    close: () =>
      new Promise<void>((resolve) => {
        if (server) server.close(() => resolve())
        else resolve()
      }),
  }
}

describe("fetchEmbedding against a fake small-context server (real TCP)", () => {
  it("halves an oversize input and eventually succeeds", async () => {
    const server = await startFakeEmbeddingServer(/* maxInputChars */ 200)
    try {
      const smallCfg = {
        enabled: true,
        endpoint: server.url,
        apiKey: "",
        model: "fake-embed",
      }
      // 800 chars of "a" → must halve 800 → 400 → 200 (3 attempts:
      // first 2 rejected, third accepted at the boundary). Proves:
      //   (a) looksLikeOversizeError matched the server's phrasing
      //   (b) the request body is re-serialized cleanly on each retry
      //   (c) the response parser correctly handles the error body
      //       on rejects AND the success body on acceptance
      const v = await fetchEmbedding("a".repeat(800), smallCfg)
      expect(v, `halving failed: ${getLastEmbeddingError()}`).not.toBeNull()
      expect(v!.length).toBe(8)
      expect(getLastEmbeddingError()).toBeNull()
      expect(server.requestSizes()).toEqual([800, 400, 200])
    } finally {
      await server.close()
    }
  })

  it("surfaces the 'rejected input even at N chars' error when every halving round fails", async () => {
    // max 50 chars — below the 64-char halving floor, so the
    // halving loop will retry 2048 → 1024 → 512 → 256 (exhausting
    // the 3-retry budget) and give up with the specific oversize
    // error message, NOT the generic API-error message.
    const server = await startFakeEmbeddingServer(/* maxInputChars */ 50)
    try {
      const smallCfg = {
        enabled: true,
        endpoint: server.url,
        apiKey: "",
        model: "fake-embed",
      }
      const v = await fetchEmbedding("a".repeat(2048), smallCfg)
      expect(v).toBeNull()
      expect(server.requestSizes()).toEqual([2048, 1024, 512, 256])

      const err = getLastEmbeddingError()!
      expect(err).toContain("Endpoint rejected input even at 256 chars")
      expect(err).toContain("Lower Settings → Embedding → Max Chunk Chars")
    } finally {
      await server.close()
    }
  })

  it("stops halving at the 64-char floor and reports the specific error (128 → 64, no further)", async () => {
    // Server rejects everything over 0 chars, so every attempt fails.
    // Input 128 → halve to 64 → 64 is NOT > 64 so loop exits. Exactly
    // 2 server hits.
    const server = await startFakeEmbeddingServer(/* maxInputChars */ 0)
    try {
      const smallCfg = {
        enabled: true,
        endpoint: server.url,
        apiKey: "",
        model: "fake-embed",
      }
      const v = await fetchEmbedding("a".repeat(128), smallCfg)
      expect(v).toBeNull()
      expect(server.requestSizes()).toEqual([128, 64])
      const err = getLastEmbeddingError()!
      expect(err).toContain("Endpoint rejected input even at 64 chars")
    } finally {
      await server.close()
    }
  })
})

// ── Multi-page RAG pipeline — real chunking + embedding + retrieval ──
//
// What this block actually proves:
//
//   The earlier tests pin the HTTP contract and pairwise similarity on
//   synthetic strings. These tests build 4 ground-truth wiki pages
//   (frontmatter, headings, code, CJK, a table), run each through the
//   REAL embedPage pipeline (chunker → enrichment → fetchEmbedding →
//   upsert payload), capture the resulting vectors, then drive
//   searchByEmbedding against an in-memory LanceDB stand-in and assert
//   that semantic queries pick the right page. If any stage in that
//   chain regresses, a query stops routing to the correct page and
//   this suite fires — whereas the mocked tests would stay green.
//
// LanceDB is stubbed (not reachable under Node), but the Rust side has
// its own 15-test suite; we're concerned with the TypeScript pipeline
// here.

interface StoredChunk {
  chunk_id: string
  page_id: string
  chunk_index: number
  chunk_text: string
  heading_path: string
  embedding: number[]
}

/** Cosine score identical to LanceDB's default `cosine` metric. */
function cosineScore(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Deterministic fixture set with clear semantic boundaries. Each page
// is purposely ≥ 1500 chars so the chunker emits ≥ 2 chunks, giving
// the tail-sum blending a chance to kick in.
const FIXTURES: Array<{ id: string; title: string; content: string }> = [
  {
    id: "rope",
    title: "RoPE 旋转位置编码",
    content: `---
title: "RoPE 旋转位置编码"
type: concept
---

# RoPE 旋转位置编码

Rotary positional embeddings (RoPE) are a relative position-encoding
scheme for Transformer attention. Instead of adding an absolute
positional vector to token embeddings, RoPE rotates the query and key
vectors in the complex plane by an angle that depends on the token's
position. Two tokens separated by the same distance therefore land at
the same relative rotation, giving the attention score a clean
translation-equivariance property.

## 数学原理

Given a query vector \`q\` at position \`m\` and a key vector \`k\` at
position \`n\`, RoPE rotates each pair of dimensions by an angle
proportional to the position index. The dot product between the
rotated vectors depends only on the relative offset \`m - n\`, which
is why RoPE generalizes better to longer contexts than additive
absolute encodings.

\`\`\`python
# 2D rotation applied to each adjacent pair of dims
theta_i = base ** (-2 * i / d)
q_rot = q * cos(m * theta) + rotate_half(q) * sin(m * theta)
\`\`\`

## 与 Flash Attention 的关系

RoPE 只改变 Q 和 K 的旋转,不影响 Value,所以它可以和 Flash Attention
kernel 无缝叠加。这两项技术共同支撑了大部分现代长上下文模型的推理流程。`,
  },
  {
    id: "flash-attention",
    title: "Flash Attention",
    content: `---
title: "Flash Attention"
type: concept
---

# Flash Attention

Flash Attention is a memory-efficient exact attention algorithm that
reorganizes the attention computation to minimize traffic between
GPU HBM and SRAM. The standard attention kernel materializes the full
N×N attention matrix in HBM, which dominates memory bandwidth and
caps the practical context length. Flash Attention instead computes
attention in a tiled, fused fashion: it streams blocks of queries and
keys through fast on-chip SRAM, accumulating the softmax-weighted
outputs incrementally without ever writing the full attention matrix
to HBM.

## Why it matters

The win is not asymptotic — it is still O(N²) in FLOPs — but the
constant factor on memory movement drops by an order of magnitude,
which turns "run out of memory at 4k tokens" into "comfortably train
at 64k". This memory-bandwidth reduction is the single biggest
practical enabler of long-context LLM training and inference on
commodity H100 / A100 hardware.

## IO-aware tiling details

The tiling block size is chosen so that a tile of Q, K, and V fits
into SRAM simultaneously. The softmax is made numerically stable
across tiles via an online running-max trick, so accuracy matches the
standard implementation exactly.

| 变体            | 用途                                    |
|-----------------|----------------------------------------|
| FlashAttn v1    | 推理 + 训练,float16                     |
| FlashAttn v2    | 更细的 warp-level 切分, 2x 吞吐         |
| FlashAttn v3    | Hopper H100 TMA + async softmax         |`,
  },
  {
    id: "ice-cream",
    title: "Chocolate Ice Cream",
    content: `---
title: "Chocolate Ice Cream"
type: recipe
---

# Chocolate Ice Cream

Chocolate ice cream is a popular frozen dessert made by churning a
custard base of heavy cream, milk, sugar, egg yolks, and cocoa or
melted dark chocolate. The churning incorporates air while freezing
the water content into very small ice crystals, producing the
characteristic smooth, scoopable texture.

## A classic home recipe

You can make a traditional French-style chocolate ice cream at home
with a stand mixer and an ice cream maker. Start by heating the
cream, milk, and half the sugar over medium heat until the sugar
dissolves. Whisk the yolks with the remaining sugar until pale, then
temper in the hot cream and return to the pot to cook into a custard.
Stir in cocoa powder and melted dark chocolate off the heat, then
chill the base thoroughly before churning.

## Serving suggestions

Serve in chilled glass bowls with whipped cream, toasted almonds, or
fresh berries. A pinch of flaky salt on top brings out the cocoa
notes. Pairs well with espresso, hot fudge, or a simple shortbread
cookie on the side.`,
  },
  {
    id: "tea-ceremony-ja",
    title: "日本茶道",
    content: `---
title: "日本茶道"
type: culture
---

# 日本茶道 (Japanese Tea Ceremony)

日本茶道,也称"茶の湯",是以准备和奉上抹茶 (matcha) 为中心的传统仪式。
它融合了禅宗哲学、陶瓷艺术、书道和插花 (ikebana),强调"和敬清寂"四个
核心精神:和谐、尊重、纯净、寂静。

## 仪式流程

客人进入茶室前,会先在露地 (roji,茶庭) 中净手、净口;主人则按照严格的
顺序清洁器具、点茶、奉茶。一场正式的茶事 (chaji) 会持续约四小时,
包含怀石料理、浓茶、薄茶等多个阶段,每一个动作都有精确的规范。

## 茶具与流派

主要流派有里千家、表千家、武者小路千家三大千家,各自在手法与道具上略
有差异。常用器具包括茶碗 (chawan)、茶筅 (chasen)、茶杓 (chashaku) 和
枣 (natsume)。`,
  },
]

describe("real-embedding RAG pipeline — multi-page retrieval", () => {
  const CHUNK_STORE: StoredChunk[] = []
  const PROJECT_PATH = "/tmp/real-llm-rag"
  let beforeAllError: Error | null = null

  beforeAll(async () => {
    if (!ENABLED) return
    try {
      mockInvoke.mockReset()
      // Default handler: upsert captures into our in-memory store,
      // search delegates to cosine-sim over that store. No other
      // Tauri commands are called by the pipeline.
      mockInvoke.mockImplementation(async (cmd, args) => {
        if (cmd === "vector_upsert_chunks") {
          const payload = args as {
            pageId: string
            chunks: Array<{
              chunk_index: number
              chunk_text: string
              heading_path: string
              embedding: number[]
            }>
          }
          // Delete existing chunks for this page, then append. Mirrors
          // the Rust side's delete-then-add semantics.
          for (let i = CHUNK_STORE.length - 1; i >= 0; i--) {
            if (CHUNK_STORE[i].page_id === payload.pageId) CHUNK_STORE.splice(i, 1)
          }
          for (const c of payload.chunks) {
            CHUNK_STORE.push({
              chunk_id: `${payload.pageId}#${c.chunk_index}`,
              page_id: payload.pageId,
              chunk_index: c.chunk_index,
              chunk_text: c.chunk_text,
              heading_path: c.heading_path,
              embedding: c.embedding,
            })
          }
          return undefined
        }
        if (cmd === "vector_search_chunks") {
          const { queryEmbedding, topK } = args as {
            queryEmbedding: number[]
            topK: number
          }
          return CHUNK_STORE.map((c) => ({
            chunk_id: c.chunk_id,
            page_id: c.page_id,
            chunk_index: c.chunk_index,
            chunk_text: c.chunk_text,
            heading_path: c.heading_path,
            score: cosineScore(queryEmbedding, c.embedding),
          }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
        }
        return undefined
      })

      // Embed each fixture page — this exercises chunker + enrichment +
      // fetchEmbedding + the upsert payload construction with REAL
      // vectors. All four pages go through the same default config, so
      // the chunker tuning is what the production code uses.
      for (const page of FIXTURES) {
        await embedPage(PROJECT_PATH, page.id, page.title, page.content, cfg)
      }
    } catch (err) {
      beforeAllError = err instanceof Error ? err : new Error(String(err))
    }
  }, 3 * 60 * 1000)

  // ── Contract tests on the captured upsert payloads ─────────────
  it.skipIf(!ENABLED)("embedded every fixture page with ≥ 2 chunks and valid vectors", () => {
    if (beforeAllError) throw beforeAllError

    // Every fixture must contribute at least 2 chunks to the store,
    // proving the chunker actually split long sections.
    for (const page of FIXTURES) {
      const pageChunks = CHUNK_STORE.filter((c) => c.page_id === page.id)
      expect(pageChunks.length, `page "${page.id}" produced too few chunks`).toBeGreaterThanOrEqual(2)

      // Chunk indexes must be contiguous 0..N-1.
      const idxs = pageChunks.map((c) => c.chunk_index).sort((a, b) => a - b)
      expect(idxs).toEqual(idxs.map((_, i) => i))

      // Every chunk has a real embedding vector of consistent dim,
      // every component finite. A regression that dropped Math.fround
      // or corrupted the response would show up as NaN here.
      const dim = pageChunks[0].embedding.length
      expect(dim).toBeGreaterThan(0)
      for (const c of pageChunks) {
        expect(c.embedding.length).toBe(dim)
        for (const x of c.embedding) {
          expect(Number.isFinite(x)).toBe(true)
        }
      }
    }

    // Every chunk should carry SOME heading breadcrumb — fixture
    // pages all have H1/H2/H3 structure, and the preamble that sits
    // directly under the H1 still inherits "# Title".
    const noHeading = CHUNK_STORE.filter((c) => c.heading_path.length === 0)
    expect(noHeading, `chunks missing heading path: ${noHeading.map((c) => c.chunk_id).join(", ")}`).toHaveLength(0)
  })

  // ── Semantic retrieval queries — the actual RAG quality test ────

  /**
   * For each query, drive `searchByEmbedding` (which calls the real
   * embedding endpoint for the query, then our in-memory search mock
   * for the chunk scan) and assert the expected page ranks first.
   */
  const queries: Array<{ q: string; expectedTop: string; lang: string }> = [
    { q: "positional encoding in transformer attention", expectedTop: "rope", lang: "en" },
    { q: "how to reduce attention memory and avoid OOM at long context", expectedTop: "flash-attention", lang: "en" },
    { q: "homemade dessert with heavy cream and cocoa", expectedTop: "ice-cream", lang: "en" },
    { q: "抹茶 仪式 禅宗", expectedTop: "tea-ceremony-ja", lang: "zh" },
    { q: "旋转位置编码如何注入位置信息", expectedTop: "rope", lang: "zh" },
  ]

  for (const { q, expectedTop, lang } of queries) {
    it.skipIf(!ENABLED)(
      `query ranks "${expectedTop}" first: [${lang}] "${q}"`,
      async () => {
        if (beforeAllError) throw beforeAllError

        const out = await searchByEmbedding(PROJECT_PATH, q, cfg, 3)
        const ordered = out.map((p) => `${p.id}(${p.score.toFixed(3)})`).join(" > ")
        // eslint-disable-next-line no-console
        console.log(`[RAG] "${q}" → ${ordered}`)

        expect(out.length).toBeGreaterThan(0)
        expect(
          out[0].id,
          `expected "${expectedTop}" at rank 1, got ranking: ${ordered}`,
        ).toBe(expectedTop)

        // The winning page must be meaningfully ahead of the runner-up,
        // not a coin-flip tie. 5% of the top score is a modest margin
        // that still catches "barely winning by noise".
        if (out.length >= 2) {
          const gap = out[0].score - out[1].score
          expect(
            gap,
            `top-1 score gap too small (${gap.toFixed(4)}) — ${ordered}`,
          ).toBeGreaterThan(out[0].score * 0.05)
        }

        // The winning page should expose matched chunks with the
        // highest-similarity chunk actually coming from the expected
        // page — i.e. the retrieval isn't winning because of blended
        // tail noise.
        expect(out[0].matchedChunks, "winning page missing matchedChunks").toBeTruthy()
        expect(out[0].matchedChunks![0].score).toBeGreaterThan(0.3)
      },
      TEST_TIMEOUT_MS,
    )
  }

  it.skipIf(!ENABLED)(
    "heading-path enrichment: query naming the H2 of a chunk routes to that chunk",
    async () => {
      if (beforeAllError) throw beforeAllError
      // "IO-aware tiling" is the exact H2 inside flash-attention. The
      // text of that section's body is short-ish; without the heading
      // being prefixed into the embedded input, retrieval would likely
      // miss it. Asserting this specific chunk wins its page verifies
      // the `enrichChunkForEmbedding` contribution end-to-end.
      const out = await searchByEmbedding(PROJECT_PATH, "IO-aware tiling block size SRAM", cfg, 3)
      expect(out[0].id).toBe("flash-attention")
      const topChunk = out[0].matchedChunks![0]
      expect(
        topChunk.headingPath,
        `top chunk's heading path doesn't name IO-aware tiling: ${topChunk.headingPath}`,
      ).toContain("IO-aware")
    },
    TEST_TIMEOUT_MS,
  )

  // ── Precision / exclusion — "what should NOT rank highly" ──────

  /**
   * For each query, the fixture set includes obviously-unrelated
   * pages whose raw cosine similarity should be clearly lower than
   * the on-topic page. This doesn't re-check the winner (already
   * tested above); it pins *how far behind* the wrong pages land.
   *
   * If retrieval regresses into near-random ordering — e.g. a
   * title-prefix dominates the vector so everything scores ≈ 0.8 —
   * the winner might still be right but the margin collapses, and
   * these thresholds fire.
   */
  const precisionCases: Array<{
    q: string
    expectedTop: string
    mustBeBelow: Record<string, number>
  }> = [
    {
      q: "positional encoding in transformer attention",
      expectedTop: "rope",
      // Ice cream and tea ceremony have nothing to do with Transformers.
      // Past real runs scored them 0.22 / 0.30 respectively — 0.5 is a
      // conservative ceiling that still catches a serious regression.
      mustBeBelow: { "ice-cream": 0.5, "tea-ceremony-ja": 0.5 },
    },
    {
      q: "homemade dessert with heavy cream and cocoa",
      expectedTop: "ice-cream",
      // RoPE / Flash Attention should be the bottom here.
      mustBeBelow: { rope: 0.5, "flash-attention": 0.5 },
    },
    {
      q: "抹茶 仪式 禅宗",
      expectedTop: "tea-ceremony-ja",
      mustBeBelow: { rope: 0.5, "flash-attention": 0.5 },
    },
  ]

  for (const { q, expectedTop, mustBeBelow } of precisionCases) {
    it.skipIf(!ENABLED)(
      `precision: "${q}" ranks ${expectedTop} first and keeps unrelated pages below thresholds`,
      async () => {
        if (beforeAllError) throw beforeAllError
        // Fetch all pages (topK large enough to see every page_id) so
        // we can assert on both the winner and the tail.
        const out = await searchByEmbedding(PROJECT_PATH, q, cfg, 10)
        expect(out[0].id).toBe(expectedTop)

        const byId = new Map(out.map((p) => [p.id, p.score]))
        for (const [id, ceiling] of Object.entries(mustBeBelow)) {
          const score = byId.get(id)
          expect(
            score,
            `"${id}" missing from search output for query "${q}" — expected to appear with a low score`,
          ).toBeDefined()
          expect(
            score!,
            `"${id}" scored ${score?.toFixed(3)} for query "${q}", above the ${ceiling} ceiling. Full ordering: ${out
              .map((p) => `${p.id}(${p.score.toFixed(3)})`)
              .join(" > ")}`,
          ).toBeLessThan(ceiling)
        }
      },
      TEST_TIMEOUT_MS,
    )
  }

  it.skipIf(!ENABLED)(
    "out-of-domain query: top score is lower than in-domain queries (confidence signal)",
    async () => {
      if (beforeAllError) throw beforeAllError
      // No fixture page discusses JVM garbage collection. The top
      // match still has to be something (retrieval always returns
      // the most-similar page available), but its BLENDED score
      // should be noticeably lower than an in-domain query's top
      // score — otherwise the UI has no signal for "I'm not sure
      // anything here is a match."
      const inDomain = await searchByEmbedding(
        PROJECT_PATH,
        "positional encoding in transformer attention",
        cfg,
        3,
      )
      const outOfDomain = await searchByEmbedding(
        PROJECT_PATH,
        "JVM generational garbage collector tuning G1 vs ZGC",
        cfg,
        3,
      )
      // eslint-disable-next-line no-console
      console.log(
        `[RAG] in-domain top=${inDomain[0].score.toFixed(3)} (${inDomain[0].id}), ` +
          `out-of-domain top=${outOfDomain[0].score.toFixed(3)} (${outOfDomain[0].id})`,
      )
      expect(
        outOfDomain[0].score,
        `out-of-domain query's top score (${outOfDomain[0].score.toFixed(3)}) should be lower than in-domain (${inDomain[0].score.toFixed(3)}). If they tie, retrieval has no confidence signal.`,
      ).toBeLessThan(inDomain[0].score - 0.2)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!ENABLED)(
    "exact title query ranks the named page first with a very high score",
    async () => {
      if (beforeAllError) throw beforeAllError
      const out = await searchByEmbedding(PROJECT_PATH, "Flash Attention", cfg, 3)
      expect(out[0].id).toBe("flash-attention")
      // An exact title match should comfortably clear 0.8. Lower
      // would indicate a regression in title-prefix enrichment.
      expect(out[0].score).toBeGreaterThan(0.8)
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!ENABLED)("topK cutoff: requesting 2 returns exactly 2 pages (not more, not fewer)", async () => {
    if (beforeAllError) throw beforeAllError
    const out = await searchByEmbedding(PROJECT_PATH, "attention memory", cfg, 2)
    expect(out).toHaveLength(2)
  })

  it.skipIf(!ENABLED)(
    "topK larger than corpus returns every page exactly once (no duplicates, no synthetic padding)",
    async () => {
      if (beforeAllError) throw beforeAllError
      const out = await searchByEmbedding(PROJECT_PATH, "knowledge", cfg, 100)
      // 4 fixture pages → exactly 4 results, no dup page_ids.
      expect(out).toHaveLength(FIXTURES.length)
      const ids = out.map((p) => p.id).sort()
      expect(ids).toEqual(FIXTURES.map((f) => f.id).sort())
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!ENABLED)(
    "re-embedding the same pageId replaces its chunks (no accumulation / duplication)",
    async () => {
      if (beforeAllError) throw beforeAllError

      // Use a scratch pageId that isn't one of the canonical FIXTURES
      // so we don't contaminate state for other tests in this block.
      const scratchId = "scratch-replace-test"
      const original = `# Original\n\n${"Original body about Transformer decoders. ".repeat(20)}`
      const updated = `# Updated\n\n${"Updated body about kangaroo migration patterns across Australia. ".repeat(20)}`

      try {
        // First ingest.
        await embedPage(PROJECT_PATH, scratchId, "Original", original, cfg)
        const firstCount = CHUNK_STORE.filter((c) => c.page_id === scratchId).length
        expect(firstCount, "first ingest produced zero chunks").toBeGreaterThan(0)
        const originalSample = CHUNK_STORE.find((c) => c.page_id === scratchId)!.chunk_text
        expect(originalSample).toContain("Original body about Transformer")

        // Re-ingest with completely different content under the SAME id.
        await embedPage(PROJECT_PATH, scratchId, "Updated", updated, cfg)
        const afterChunks = CHUNK_STORE.filter((c) => c.page_id === scratchId)

        // If delete-then-append regressed to pure append, we'd see
        // firstCount + newCount chunks. The contract is: only the
        // updated content remains.
        expect(
          afterChunks.some((c) => c.chunk_text.includes("Original body about Transformer")),
          "old chunks not purged — saw Original content after re-embed, indicating append semantics instead of replace",
        ).toBe(false)
        expect(
          afterChunks.some((c) => c.chunk_text.includes("kangaroo migration")),
          "new content missing from store after re-embed",
        ).toBe(true)

        // Retrieval signal: a query that matched the OLD content must
        // no longer rank the scratch page first.
        const oldQueryOut = await searchByEmbedding(
          PROJECT_PATH,
          "Transformer decoder body",
          cfg,
          FIXTURES.length + 1,
        )
        const scratchRank = oldQueryOut.findIndex((p) => p.id === scratchId)
        if (scratchRank >= 0) {
          expect(
            oldQueryOut[scratchRank].score,
            `scratch page still scored high (${oldQueryOut[scratchRank].score}) for old-content query — replace semantics likely broken`,
          ).toBeLessThan(0.6)
        }
      } finally {
        // Always clean up so a failure mid-test doesn't leak state
        // into the "empty query" test at the end of the describe.
        for (let i = CHUNK_STORE.length - 1; i >= 0; i--) {
          if (CHUNK_STORE[i].page_id === scratchId) CHUNK_STORE.splice(i, 1)
        }
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!ENABLED)(
    "empty / whitespace-only query: does not crash; returns an array with only finite scores",
    async () => {
      if (beforeAllError) throw beforeAllError
      // The UI gates search on a non-empty trimmed query, but the
      // library MUST NOT crash on degenerate input. A regression
      // here would be a runtime error, not just a bad ranking.
      const emptyOut = await searchByEmbedding(PROJECT_PATH, "", cfg, 5)
      const whitespaceOut = await searchByEmbedding(PROJECT_PATH, "   \n\t", cfg, 5)

      // Contract: return type is always Array (never undefined/null),
      // so callers can `.map` / `.length` without guards.
      expect(Array.isArray(emptyOut), "empty query returned non-array").toBe(true)
      expect(Array.isArray(whitespaceOut), "whitespace query returned non-array").toBe(true)

      for (const [label, out] of [
        ["empty", emptyOut],
        ["whitespace", whitespaceOut],
      ] as const) {
        for (const p of out) {
          expect(Number.isFinite(p.score), `${label}: NaN/Infinity score leaked into ${p.id}`).toBe(true)
          expect(typeof p.id, `${label}: non-string page id`).toBe("string")
          expect(p.id.length, `${label}: empty page id`).toBeGreaterThan(0)
        }
      }
    },
    TEST_TIMEOUT_MS,
  )
})
