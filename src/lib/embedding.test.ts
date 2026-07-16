/**
 * Unit-level tests for embedding.ts, focused on the pure / mockable
 * pieces: auto-halve retry heuristics and the chunk→page aggregation
 * contract inside `searchByEmbedding`.
 *
 * The actual Rust HTTP/vectorstore commands are mocked here. Rust owns
 * the provider transport; this file pins the TypeScript orchestration
 * contract around chunking, invoke payloads, and page-level aggregation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// Module-level mock for the Tauri invoke boundary so we can script the
// chunk-search response without touching real LanceDB.
const mockInvoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
const mockEmbeddingFetchInvoke = vi.fn<(args?: unknown) => Promise<unknown>>()
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) =>
    cmd === "embedding_fetch" ? mockEmbeddingFetchInvoke(args) : mockInvoke(cmd, args),
}))

// In-test responder used by the `embedding_fetch` invoke shim below.
const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()

// readFile / listDirectory aren't exercised in this file's cases; stub.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import {
  searchByEmbedding,
  fetchEmbedding,
  embedPage,
  embedAllPages,
  getLastEmbeddingError,
  legacyVectorRowCount,
  dropLegacyVectorTable,
  getEmbeddingCount,
  removePageEmbedding,
  resetEmbeddingOptimizeAccountingForTests,
  extractEmbeddingTitle,
  type PageSearchResult,
} from "./embedding"

const cfg = {
  enabled: true,
  endpoint: "http://localhost:1234/v1/embeddings",
  apiKey: "",
  model: "test-embed",
}

/** Build an embedding-shaped JSON Response. */
function okResponse(embedding: number[]): Response {
  return new Response(JSON.stringify({ data: [{ embedding }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

/** Build an HTTP-error Response that looks like an oversize rejection. */
function oversizeErrorResponse(status = 400): Response {
  return new Response(
    JSON.stringify({ error: "input length 3200 exceeds maximum context 512" }),
    { status, statusText: "Bad Request" },
  )
}

function genericErrorResponse(status: number, body: string): Response {
  return new Response(body, { status, statusText: "Error" })
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockEmbeddingFetchInvoke.mockReset()
  mockHttpFetch.mockReset()
  mockEmbeddingFetchInvoke.mockImplementation((args) => {
    const input = args as { text: string; cfg: typeof cfg; maxRetries?: number }
    return fetchEmbeddingViaMockHttp(input.text, input.cfg, input.maxRetries ?? 3)
  })
  resetEmbeddingOptimizeAccountingForTests()
})

async function fetchEmbeddingViaMockHttp(
  text: string,
  config: typeof cfg & {
    outputDimensionality?: number
    extraHeaders?: Record<string, string>
  },
  maxRetries: number,
): Promise<number[]> {
  const isGoogle = isGoogleEmbeddingConfigForTest(config)
  const isDoubaoVision = config.model.toLowerCase().includes("doubao-embedding-vision")
  const endpoint = isGoogle ? googleEndpointForTest(config) : volcengineEndpointForTest(config)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(isLocalEndpointForTest(endpoint) ? { Origin: "http://localhost" } : {}),
  }
  if (config.apiKey) {
    if (isGoogle) headers["x-goog-api-key"] = config.apiKey
    else headers.Authorization = `Bearer ${config.apiKey}`
  }
  for (const [name, value] of Object.entries(config.extraHeaders ?? {})) {
    const trimmed = name.trim()
    const lower = trimmed.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(trimmed)) continue
    if (["authorization", "content-type", "host", "content-length", "origin", "x-goog-api-key"].includes(lower)) continue
    if (!String(value).trim()) continue
    headers[trimmed] = String(value).trim()
  }

  let current = text
  let attempts = 0
  while (attempts <= maxRetries) {
    attempts += 1
    const body = isGoogle
      ? googleBodyForTest(config.model, current, config.outputDimensionality)
      : isDoubaoVision
        ? { model: config.model, encoding_format: "float", input: [{ type: "text", text: current }] }
        : { model: config.model, input: current }
    let response: Response
    try {
      const maybeResponse = await mockHttpFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
      if (!maybeResponse) throw new TypeError("Failed to fetch")
      response = maybeResponse
    } catch {
      throw new Error(`Network error reaching ${endpoint}. Check endpoint URL, API key, and connectivity.`)
    }
    const textBody = await response.text()
    if (response.ok) {
      const data = JSON.parse(textBody)
      const embedding = isGoogle
        ? data?.embedding?.values
        : isDoubaoVision
          ? data?.data?.embedding
          : data?.data?.[0]?.embedding
      if (Array.isArray(embedding) && embedding.length > 0 && embedding.every((v) => typeof v === "number" && Number.isFinite(v))) {
        return embedding
      }
      const expected = isGoogle ? "embedding.values" : isDoubaoVision ? "data.embedding" : "data[0].embedding"
      throw new Error(`Embedding response missing ${expected}`)
    }
    if (looksLikeOversizeForTest(response.status, textBody) && current.length > 64 && attempts <= maxRetries) {
      current = current.slice(0, Math.floor(current.length / 2))
      continue
    }
    if (looksLikeOversizeForTest(response.status, textBody)) {
      throw new Error(`Endpoint rejected input even at ${current.length} chars — server context smaller than expected. Lower Settings → Embedding → Max Chunk Chars.`)
    }
    throw new Error(`API ${response.status} ${response.statusText}${textBody ? ` — ${textBody.slice(0, 200)}` : ""} at ${endpoint}`)
  }
  throw new Error(`Embedding endpoint rejected every size down to ${current.length} chars`)
}

function looksLikeOversizeForTest(status: number, body: string): boolean {
  const lower = body.toLowerCase()
  return status === 413
    || lower.includes("too long")
    || lower.includes("maximum context")
    || lower.includes("max_tokens")
    || lower.includes("max tokens")
    || lower.includes("context length")
    || lower.includes("token limit")
    || lower.includes("exceeds")
    || lower.includes("input length")
}

function isGoogleEmbeddingConfigForTest(config: { endpoint: string }): boolean {
  const endpoint = config.endpoint.toLowerCase()
  return endpoint.includes("generativelanguage.googleapis.com") || endpoint.includes(":embedcontent")
}

function isLocalEndpointForTest(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "::1"
      || /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  } catch {
    return false
  }
}

function isVolcengineEndpointForTest(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return host === "volces.com" || host.endsWith(".volces.com") || host.includes("volcengine")
  } catch {
    return false
  }
}

function volcengineEndpointForTest(config: { endpoint: string; model: string }): string {
  if (!isVolcengineEndpointForTest(config.endpoint)) return config.endpoint
  const suffix = config.model.toLowerCase().includes("doubao-embedding-vision") ? "/embeddings/multimodal" : "/embeddings"
  return appendEndpointPathForTest(config.endpoint, suffix)
}

function appendEndpointPathForTest(endpoint: string, suffix: string): string {
  const cleanSuffix = suffix.replace(/^\/+/, "")
  const url = new URL(endpoint)
  const path = url.pathname.replace(/\/+$/, "")
  const lower = path.toLowerCase()
  const lowerSuffix = `/${cleanSuffix.toLowerCase()}`
  if (lower.endsWith(lowerSuffix)) {
    url.pathname = path || "/"
  } else if (lower.endsWith("/embeddings/multimodal") && lowerSuffix === "/embeddings") {
    url.pathname = path.slice(0, -"/multimodal".length) || "/"
  } else if (lower.endsWith("/embeddings") && lowerSuffix === "/embeddings/multimodal") {
    url.pathname = `${path}/multimodal`
  } else {
    url.pathname = `${path}/${cleanSuffix}`.replace(/\/{2,}/g, "/")
  }
  return url.toString()
}

function googleEndpointForTest(config: { endpoint: string; model: string }): string {
  const raw = stripGoogleKeyForTest(config.endpoint.trim()).replace(/\/+$/, "")
  if (/:batchEmbedContents(\?|$)/i.test(raw)) return raw.replace(/:batchEmbedContents/i, ":embedContent")
  if (/:embedContent(\?|$)/i.test(raw)) return raw
  const model = config.model.startsWith("models/") ? config.model.slice("models/".length) : config.model
  if (/\/models\/[^/?]+$/i.test(raw)) return `${raw}:embedContent`
  return `${raw}/models/${encodeURIComponent(model)}:embedContent`
}

function stripGoogleKeyForTest(endpoint: string): string {
  if (!endpoint.includes("?")) return endpoint
  const url = new URL(endpoint)
  url.searchParams.delete("key")
  return url.toString()
}

function googleBodyForTest(model: string, text: string, outputDimensionality?: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.startsWith("models/") ? model : `models/${model}`,
    content: { parts: [{ text }] },
  }
  if (typeof outputDimensionality === "number" && Number.isFinite(outputDimensionality) && outputDimensionality > 0) {
    body.output_dimensionality = Math.floor(outputDimensionality)
  }
  return body
}

// ── searchByEmbedding — chunk→page aggregation ─────────────────────

describe("searchByEmbedding — aggregation", () => {
  it("returns [] when embedding call fails (null vector)", async () => {
    mockHttpFetch.mockResolvedValue(genericErrorResponse(401, "Unauthorized"))
    const out = await searchByEmbedding("/tmp/p", "hello", cfg, 5)
    expect(out).toEqual([])
  })

  it("returns [] when no chunks come back from LanceDB", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.1, 0.2, 0.3]))
    mockInvoke.mockResolvedValueOnce([] /* vector_search_chunks result */)
    const out = await searchByEmbedding("/tmp/p", "hello", cfg, 5)
    expect(out).toEqual([])
  })

  it("groups chunks by page and ranks by max-pool score", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.1, 0.2, 0.3]))
    // Three pages: A has two chunks (strong + weak), B has one strong,
    // C has one weak. Expected order: A (top 0.9 + blended tail) > B
    // (0.88) > C (0.2).
    mockInvoke.mockResolvedValueOnce([
      { chunk_id: "A#0", page_id: "A", chunk_index: 0, chunk_text: "a0", heading_path: "## X", score: 0.9 },
      { chunk_id: "A#1", page_id: "A", chunk_index: 1, chunk_text: "a1", heading_path: "## Y", score: 0.5 },
      { chunk_id: "B#0", page_id: "B", chunk_index: 0, chunk_text: "b0", heading_path: "", score: 0.88 },
      { chunk_id: "C#0", page_id: "C", chunk_index: 0, chunk_text: "c0", heading_path: "", score: 0.2 },
    ])
    const out = await searchByEmbedding("/tmp/p", "q", cfg, 10)
    expect(out.map((p) => p.id)).toEqual(["A", "B", "C"])
    // A's score: 0.9 + min(0.5 * 0.3, 1 - 0.9) = 0.9 + min(0.15, 0.1) = 1.0
    expect(out[0].score).toBeCloseTo(1.0, 5)
    // B's score: 0.88 + 0 = 0.88
    expect(out[1].score).toBeCloseTo(0.88, 5)
    // C's score: 0.2 + 0 = 0.2
    expect(out[2].score).toBeCloseTo(0.2, 5)
  })

  it("caps tail contribution so the blended score cannot exceed 1.0", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.1, 0.2, 0.3]))
    // Page X: one chunk at 0.6, four chunks at 0.4 each (tail sum = 1.6).
    //   top=0.6, tail_weighted = 0.3 * 1.6 = 0.48
    //   UNCAPPED blended = 0.6 + 0.48 = 1.08   (would exceed 1.0)
    //   CAPPED   blended = 0.6 + min(0.48, 1-0.6=0.4) = 1.0
    // Page Y: single 0.95 chunk. blended = 0.95.
    mockInvoke.mockResolvedValueOnce([
      { chunk_id: "X#0", page_id: "X", chunk_index: 0, chunk_text: "", heading_path: "", score: 0.6 },
      { chunk_id: "X#1", page_id: "X", chunk_index: 1, chunk_text: "", heading_path: "", score: 0.4 },
      { chunk_id: "X#2", page_id: "X", chunk_index: 2, chunk_text: "", heading_path: "", score: 0.4 },
      { chunk_id: "X#3", page_id: "X", chunk_index: 3, chunk_text: "", heading_path: "", score: 0.4 },
      { chunk_id: "X#4", page_id: "X", chunk_index: 4, chunk_text: "", heading_path: "", score: 0.4 },
      { chunk_id: "Y#0", page_id: "Y", chunk_index: 0, chunk_text: "", heading_path: "", score: 0.95 },
    ])
    const out: PageSearchResult[] = await searchByEmbedding("/tmp/p", "q", cfg, 10)

    // Order must be X then Y (X at the exact cap of 1.0 beats Y at 0.95).
    expect(out.map((p) => p.id)).toEqual(["X", "Y"])
    // Exact pinned score: if the cap regressed (e.g. uncapped sum),
    // X would land at 1.08 and this assertion would fail loudly.
    expect(out[0].score).toBeCloseTo(1.0, 10)
    expect(out[1].score).toBeCloseTo(0.95, 10)
  })

  it("applies the tail contribution below the cap when weighted tail < (1 - top)", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.1]))
    // top=0.5, tail=[0.1, 0.1]. weighted = 0.3 * 0.2 = 0.06.
    // cap room = 1 - 0.5 = 0.5. min(0.06, 0.5) = 0.06.
    // blended = 0.56 — below the cap, so tail contribution passes through.
    mockInvoke.mockResolvedValueOnce([
      { chunk_id: "P#0", page_id: "P", chunk_index: 0, chunk_text: "", heading_path: "", score: 0.5 },
      { chunk_id: "P#1", page_id: "P", chunk_index: 1, chunk_text: "", heading_path: "", score: 0.1 },
      { chunk_id: "P#2", page_id: "P", chunk_index: 2, chunk_text: "", heading_path: "", score: 0.1 },
    ])
    const out = await searchByEmbedding("/tmp/p", "q", cfg, 10)
    expect(out[0].score).toBeCloseTo(0.56, 10)
  })

  it("over-fetches topK × 3 chunks with a floor of 30 so the page-grouping has enough candidates", async () => {
    // mockImplementation returns a FRESH Response per call — Response
    // bodies are single-use and mockResolvedValue would fail on the
    // second searchByEmbedding call below.
    mockHttpFetch.mockImplementation(async () => okResponse([0.1]))
    mockInvoke.mockResolvedValueOnce([])
    await searchByEmbedding("/tmp/p", "q", cfg, 3)
    // topK=3 → max(9, 30) = 30
    const searchCall = mockInvoke.mock.calls.find((c) => c[0] === "vector_search_chunks")!
    expect((searchCall[1] as { topK: number }).topK).toBe(30)

    mockInvoke.mockReset()
    mockInvoke.mockResolvedValueOnce([])
    await searchByEmbedding("/tmp/p", "q", cfg, 20)
    // topK=20 → max(60, 30) = 60
    const searchCall2 = mockInvoke.mock.calls.find((c) => c[0] === "vector_search_chunks")!
    expect((searchCall2[1] as { topK: number }).topK).toBe(60)
  })

  it("returns [] when the LanceDB search command throws (doesn't leak the error)", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.1]))
    mockInvoke.mockRejectedValueOnce(new Error("lancedb: could not open table"))
    const out = await searchByEmbedding("/tmp/p", "q", cfg, 5)
    expect(out).toEqual([])
  })

  it("sorts matchedChunks by score descending regardless of server return order", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.1]))
    // Feed chunks in unsorted order; matchedChunks must still be sorted.
    mockInvoke.mockResolvedValueOnce([
      { chunk_id: "A#0", page_id: "A", chunk_index: 0, chunk_text: "low", heading_path: "", score: 0.3 },
      { chunk_id: "A#1", page_id: "A", chunk_index: 1, chunk_text: "high", heading_path: "", score: 0.9 },
      { chunk_id: "A#2", page_id: "A", chunk_index: 2, chunk_text: "mid", heading_path: "", score: 0.5 },
    ])
    const out = await searchByEmbedding("/tmp/p", "q", cfg, 5)
    expect(out[0].matchedChunks!.map((c) => c.text)).toEqual(["high", "mid", "low"])
  })

  it("attaches up to 3 matched chunks with metadata", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.1, 0.2, 0.3]))
    mockInvoke.mockResolvedValueOnce([
      { chunk_id: "A#0", page_id: "A", chunk_index: 0, chunk_text: "first", heading_path: "## Intro", score: 0.9 },
      { chunk_id: "A#1", page_id: "A", chunk_index: 1, chunk_text: "second", heading_path: "## Body", score: 0.6 },
      { chunk_id: "A#2", page_id: "A", chunk_index: 2, chunk_text: "third", heading_path: "## Body", score: 0.4 },
      { chunk_id: "A#3", page_id: "A", chunk_index: 3, chunk_text: "fourth", heading_path: "## Body", score: 0.3 },
    ])
    const out = await searchByEmbedding("/tmp/p", "q", cfg, 10)
    const a = out[0]
    expect(a.matchedChunks).toHaveLength(3)
    expect(a.matchedChunks![0].text).toBe("first")
    expect(a.matchedChunks![0].headingPath).toBe("## Intro")
    expect(a.matchedChunks![0].score).toBeCloseTo(0.9, 5)
  })

  it("respects the topK cutoff", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.1, 0.2, 0.3]))
    mockInvoke.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({
        chunk_id: `${i}#0`,
        page_id: `page-${i}`,
        chunk_index: 0,
        chunk_text: "",
        heading_path: "",
        score: 1 - i * 0.05,
      })),
    )
    const out = await searchByEmbedding("/tmp/p", "q", cfg, 3)
    expect(out).toHaveLength(3)
    // Should be the three highest-scoring page ids.
    expect(out.map((p) => p.id)).toEqual(["page-0", "page-1", "page-2"])
  })
})

describe("fetchEmbedding — provider wire formats", () => {
  it("does not route OpenAI text-embedding models through Gemini", async () => {
    mockHttpFetch.mockResolvedValueOnce(okResponse([0.1, 0.2]))

    const out = await fetchEmbedding("hi", {
      enabled: true,
      endpoint: "https://api.openai.com/v1/embeddings",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    })

    expect(out).toEqual([0.1, 0.2])
    const [url, opts] = mockHttpFetch.mock.calls[0]
    const headers = opts?.headers as Record<string, string>
    expect(url).toBe("https://api.openai.com/v1/embeddings")
    expect(headers.Authorization).toBe("Bearer sk-test")
    expect(headers.Origin).toBeUndefined()
    expect(headers["x-goog-api-key"]).toBeUndefined()
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "text-embedding-3-small",
      input: "hi",
    })
  })

  it("does not route LM Studio text-embedding models through Gemini", async () => {
    mockHttpFetch.mockResolvedValueOnce(okResponse([0.3, 0.4]))

    const out = await fetchEmbedding("hi", {
      enabled: true,
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      apiKey: "",
      model: "text-embedding-qwen3-embedding-0.6b",
    })

    expect(out).toEqual([0.3, 0.4])
    const [url, opts] = mockHttpFetch.mock.calls[0]
    const headers = opts?.headers as Record<string, string>
    expect(url).toBe("http://127.0.0.1:1234/v1/embeddings")
    expect(headers.Authorization).toBeUndefined()
    expect(headers.Origin).toBe("http://localhost")
    expect(headers["x-goog-api-key"]).toBeUndefined()
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "text-embedding-qwen3-embedding-0.6b",
      input: "hi",
    })
  })

  it("sends Origin override for LAN embedding endpoints", async () => {
    mockHttpFetch.mockResolvedValueOnce(okResponse([0.3, 0.4]))

    const out = await fetchEmbedding("hi", {
      enabled: true,
      endpoint: "http://192.168.1.20:11434/v1/embeddings",
      apiKey: "",
      model: "nomic-embed-text",
    })

    expect(out).toEqual([0.3, 0.4])
    const [, opts] = mockHttpFetch.mock.calls[0]
    const headers = opts?.headers as Record<string, string>
    expect(headers.Origin).toBe("http://localhost")
  })

  it("sends safe custom embedding headers on OpenAI-compatible endpoints", async () => {
    mockHttpFetch.mockResolvedValueOnce(okResponse([0.5, 0.6]))

    const out = await fetchEmbedding("hi", {
      enabled: true,
      endpoint: "https://gateway.example.com/v1/embeddings",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      extraHeaders: {
        "X-Model-Provider-Id": " siliconflow ",
        "X-Empty": "",
        "Bad Header": "nope",
        Authorization: "Bearer attacker",
        "Content-Type": "text/plain",
        Host: "evil.example.com",
        "Content-Length": "999",
        Origin: "http://tauri.localhost",
        "x-goog-api-key": "wrong-google-key",
      },
    })

    expect(out).toEqual([0.5, 0.6])
    const [, opts] = mockHttpFetch.mock.calls[0]
    const headers = opts?.headers as Record<string, string>
    expect(headers["X-Model-Provider-Id"]).toBe("siliconflow")
    expect(headers.Authorization).toBe("Bearer sk-test")
    expect(headers["Content-Type"]).toBe("application/json")
    expect(headers.Origin).toBeUndefined()
    expect(headers.Host).toBeUndefined()
    expect(headers["Content-Length"]).toBeUndefined()
    expect(headers["x-goog-api-key"]).toBeUndefined()
    expect(headers["Bad Header"]).toBeUndefined()
    expect(headers["X-Empty"]).toBeUndefined()
  })

  it("does not auto-append /embeddings for generic OpenAI-compatible custom endpoints", async () => {
    mockHttpFetch.mockResolvedValueOnce(okResponse([0.5, 0.6]))

    const out = await fetchEmbedding("hi", {
      enabled: true,
      endpoint: "https://gateway.example.com/v1",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    })

    expect(out).toEqual([0.5, 0.6])
    const [url, opts] = mockHttpFetch.mock.calls[0]
    expect(url).toBe("https://gateway.example.com/v1")
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "text-embedding-3-small",
      input: "hi",
    })
  })

  it("auto-appends /embeddings for Volcengine OpenAI-compatible base endpoints only", async () => {
    mockHttpFetch.mockResolvedValueOnce(okResponse([0.1, 0.2]))

    const out = await fetchEmbedding("hi", {
      enabled: true,
      endpoint: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-key",
      model: "doubao-embedding-text-240715",
    })

    expect(out).toEqual([0.1, 0.2])
    const [url, opts] = mockHttpFetch.mock.calls[0]
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/embeddings")
    expect((opts?.headers as Record<string, string>).Authorization).toBe("Bearer ark-key")
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "doubao-embedding-text-240715",
      input: "hi",
    })
  })

  it("does not infer Volcengine from a custom endpoint path or query string", async () => {
    mockHttpFetch.mockResolvedValueOnce(okResponse([0.2, 0.3]))

    await fetchEmbedding("hi", {
      enabled: true,
      endpoint: "https://gateway.example.com/proxy/volcengine?upstream=volces.com",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    })

    expect(mockHttpFetch.mock.calls[0][0]).toBe(
      "https://gateway.example.com/proxy/volcengine?upstream=volces.com",
    )
  })

  it("uses Volcengine Doubao multimodal embedding request and response shape", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { embedding: [0.7, 0.8] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "ark-key",
      model: "doubao-embedding-vision",
    })

    expect(out).toEqual([0.7, 0.8])
    const [url, opts] = mockHttpFetch.mock.calls[0]
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal")
    expect((opts?.headers as Record<string, string>).Authorization).toBe("Bearer ark-key")
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "doubao-embedding-vision",
      encoding_format: "float",
      input: [{ type: "text", text: "hello" }],
    })
  })

  it("uses Doubao multimodal wire shape for proxied vision models without rewriting custom endpoints", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { embedding: [0.4, 0.5] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://gateway.example.com/ark/embeddings/multimodal",
      apiKey: "proxy-key",
      model: "doubao-embedding-vision",
    })

    expect(out).toEqual([0.4, 0.5])
    const [url, opts] = mockHttpFetch.mock.calls[0]
    expect(url).toBe("https://gateway.example.com/ark/embeddings/multimodal")
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "doubao-embedding-vision",
      encoding_format: "float",
      input: [{ type: "text", text: "hello" }],
    })
  })

  it("preserves query parameters when building Volcengine embedding endpoints", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { embedding: [0.9] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings?trace=1",
      apiKey: "ark-key",
      model: "doubao-embedding-vision",
    })

    expect(mockHttpFetch.mock.calls[0][0]).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal?trace=1",
    )
  })

  it("does not duplicate existing Volcengine embedding suffixes", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(okResponse([0.1]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { embedding: [0.2] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(okResponse([0.3]))

    await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings",
      apiKey: "ark-key",
      model: "doubao-embedding-text-240715",
    })
    await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
      apiKey: "ark-key",
      model: "doubao-embedding-vision",
    })
    await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
      apiKey: "ark-key",
      model: "doubao-embedding-text-240715",
    })

    expect(mockHttpFetch.mock.calls.map((call) => call[0])).toEqual([
      "https://ark.cn-beijing.volces.com/api/v3/embeddings",
      "https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal",
      "https://ark.cn-beijing.volces.com/api/v3/embeddings",
    ])
  })

  it("reports the Doubao multimodal response shape when the vector is missing", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3",
      apiKey: "ark-key",
      model: "doubao-embedding-vision",
    })

    expect(out).toBeNull()
    expect(getLastEmbeddingError()).toContain("missing data.embedding")
  })

  it("does not let custom headers override the Gemini API key header", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [0.7, 0.8] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "real-google-key",
      model: "gemini-embedding-001",
      extraHeaders: {
        "x-goog-api-key": "wrong-google-key",
        "X-Trace-Id": "trace-1",
      },
    })

    expect(out).toEqual([0.7, 0.8])
    const [, opts] = mockHttpFetch.mock.calls[0]
    const headers = opts?.headers as Record<string, string>
    expect(headers["x-goog-api-key"]).toBe("real-google-key")
    expect(headers.Origin).toBeUndefined()
    expect(headers["X-Trace-Id"]).toBe("trace-1")
  })

  it("supports Gemini native embedContent endpoint and response shape", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-key",
      model: "gemini-embedding-001",
    })

    expect(out).toEqual([0.1, 0.2, 0.3])
    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockHttpFetch.mock.calls[0]
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent")
    expect((opts?.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key")
    expect((opts?.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "hello" }] },
    })
  })

  it("accepts a full Gemini model embedContent endpoint", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [1, 2] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
      apiKey: "g-key",
      model: "text-embedding-004",
    })

    expect(out).toEqual([1, 2])
    expect(mockHttpFetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
    )
  })

  it("preserves non-key query parameters on pasted Gemini endpoints", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [1] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=url-key&other=foo",
      apiKey: "header-key",
      model: "gemini-embedding-2",
    })

    expect(mockHttpFetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?other=foo",
    )
  })

  it("routes custom embedContent proxy endpoints through Gemini format", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [0.7] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://proxy.example.com/google/models/gemini-embedding-2:embedContent",
      apiKey: "g-key",
      model: "gemini-embedding-2",
    })

    expect(out).toEqual([0.7])
    const [url, opts] = mockHttpFetch.mock.calls[0]
    expect(url).toBe("https://proxy.example.com/google/models/gemini-embedding-2:embedContent")
    expect((opts?.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key")
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "models/gemini-embedding-2",
      content: { parts: [{ text: "hello" }] },
    })
  })

  it("trims trailing slashes before building Gemini embedContent endpoint", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [0.8] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta///",
      apiKey: "g-key",
      model: "gemini-embedding-2",
    })

    expect(mockHttpFetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    )
  })

  it("sends Gemini output_dimensionality when configured", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [0.1, 0.2] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("What is the meaning of life?", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-key",
      model: "gemini-embedding-2",
      outputDimensionality: 768,
    })

    expect(out).toEqual([0.1, 0.2])
    const [, opts] = mockHttpFetch.mock.calls[0]
    expect(JSON.parse(String(opts?.body))).toEqual({
      model: "models/gemini-embedding-2",
      content: { parts: [{ text: "What is the meaning of life?" }] },
      output_dimensionality: 768,
    })
  })

  it("omits invalid Gemini output_dimensionality values", async () => {
    const values = [0, -1, Number.NaN]
    for (const value of values) {
      mockHttpFetch.mockReset()
      mockHttpFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding: { values: [0.1] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )

      await fetchEmbedding("hello", {
        enabled: true,
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g-key",
        model: "gemini-embedding-2",
        outputDimensionality: value,
      })

      expect(JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))).toEqual({
        model: "models/gemini-embedding-2",
        content: { parts: [{ text: "hello" }] },
      })
    }
  })

  it("floors fractional Gemini output_dimensionality values", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [0.1] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-key",
      model: "gemini-embedding-2",
      outputDimensionality: 1.5,
    })

    expect(JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))).toEqual({
      model: "models/gemini-embedding-2",
      content: { parts: [{ text: "hello" }] },
      output_dimensionality: 1,
    })
  })

  it("normalizes a pasted Gemini batch endpoint to single embedContent", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [0.4] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents",
      apiKey: "g-key",
      model: "gemini-embedding-2",
    })

    expect(out).toEqual([0.4])
    expect(mockHttpFetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
    )
  })

  it("strips pasted Gemini key query parameters from the endpoint", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [0.5] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=url-key",
      apiKey: "header-key",
      model: "gemini-embedding-2",
    })

    expect(out).toEqual([0.5])
    const [url, opts] = mockHttpFetch.mock.calls[0]
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent")
    expect((opts?.headers as Record<string, string>)["x-goog-api-key"]).toBe("header-key")
  })

  it("rejects empty Gemini embedding vectors", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-key",
      model: "gemini-embedding-2",
    })

    expect(out).toBeNull()
    expect(getLastEmbeddingError()).toContain("missing embedding.values")
  })

  it("rejects Gemini embedding vectors with NaN or Infinity values", async () => {
    const values = [[Number.NaN], [Number.POSITIVE_INFINITY]]
    for (const vector of values) {
      mockHttpFetch.mockReset()
      mockHttpFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding: { values: vector } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )

      const out = await fetchEmbedding("hello", {
        enabled: true,
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "g-key",
        model: "gemini-embedding-2",
      })

      expect(out).toBeNull()
      expect(getLastEmbeddingError()).toContain("missing embedding.values")
    }
  })

  it("rejects Gemini embedding vectors with mixed value types", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: [1, "x"] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-key",
      model: "gemini-embedding-2",
    })

    expect(out).toBeNull()
    expect(getLastEmbeddingError()).toContain("missing embedding.values")
  })

  it("surfaces Gemini auth errors with HTTP status", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
        status: 403,
        statusText: "Forbidden",
      }),
    )

    const out = await fetchEmbedding("hello", {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "bad-key",
      model: "gemini-embedding-2",
    })

    expect(out).toBeNull()
    expect(getLastEmbeddingError()).toContain("API 403 Forbidden")
    expect(getLastEmbeddingError()).toContain("API key not valid")
  })

  it("auto-halves Gemini requests after an oversize error", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "input length exceeds context" } }), {
          status: 400,
          statusText: "Bad Request",
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ embedding: { values: [0.1] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )

    const out = await fetchEmbedding("a".repeat(200), {
      enabled: true,
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-key",
      model: "gemini-embedding-2",
    })

    expect(out).toEqual([0.1])
    const firstBody = JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))
    const secondBody = JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body))
    expect(firstBody.content.parts[0].text).toHaveLength(200)
    expect(secondBody.content.parts[0].text).toHaveLength(100)
  })
})

// ── fetchEmbedding auto-halve — via embedPage/searchByEmbedding ─────

describe("fetchEmbedding (via searchByEmbedding) — auto-halve", () => {
  it("retries after an oversize 400 with halved text and succeeds", async () => {
    const responses = [oversizeErrorResponse(400), okResponse([0.1, 0.2])]
    let call = 0
    mockHttpFetch.mockImplementation(async () => responses[call++] ?? okResponse([0]))
    mockInvoke.mockResolvedValueOnce([
      { chunk_id: "P#0", page_id: "P", chunk_index: 0, chunk_text: "", heading_path: "", score: 0.5 },
    ])

    const out = await searchByEmbedding("/tmp/p", "a".repeat(2000), cfg, 5)
    expect(out.map((p) => p.id)).toEqual(["P"])
    // First call with 2000 chars, second with 1000 chars.
    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse((mockHttpFetch.mock.calls[0][1] as RequestInit).body as string)
    const secondBody = JSON.parse((mockHttpFetch.mock.calls[1][1] as RequestInit).body as string)
    expect(firstBody.input.length).toBe(2000)
    expect(secondBody.input.length).toBe(1000)
  })

  it("recognises HTTP 413 as oversize and halves", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(new Response("", { status: 413, statusText: "Payload Too Large" }))
      .mockResolvedValueOnce(okResponse([0.1]))
    mockInvoke.mockResolvedValueOnce([
      { chunk_id: "P#0", page_id: "P", chunk_index: 0, chunk_text: "", heading_path: "", score: 0.5 },
    ])
    await searchByEmbedding("/tmp/p", "a".repeat(500), cfg, 5)
    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
  })

  it("does NOT halve on auth errors (401) — retries there would be pointless", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401, statusText: "Unauthorized" }),
    )
    const out = await searchByEmbedding("/tmp/p", "hello", cfg, 5)
    expect(out).toEqual([])
    expect(mockHttpFetch).toHaveBeenCalledTimes(1)
    // Pin the full "API <status> <statusText> — <body>" shape so a
    // regression that dropped the statusText or body text is caught.
    const err = getLastEmbeddingError()!
    expect(err).toContain("API 401 Unauthorized")
    expect(err).toContain("Invalid API key")
    expect(err).toContain(cfg.endpoint)
  })

  it("gives up after 3 halvings and surfaces the 'rejected at N chars' message", async () => {
    // A fresh Response instance per call — `mockResolvedValue` returns
    // the same object repeatedly and Response bodies can only be
    // consumed once, which would mask the real retry count.
    mockHttpFetch.mockImplementation(async () => oversizeErrorResponse(400))
    const out = await searchByEmbedding("/tmp/p", "a".repeat(2000), cfg, 5)
    expect(out).toEqual([])
    // 2000 → 1000 → 500 → 250: 4 attempts (initial + 3 halvings).
    expect(mockHttpFetch).toHaveBeenCalledTimes(4)
    // Pin the distinctive prefix — loosely matching /chars/ would pass
    // for BOTH the exhausted-retry case and the 64-char-floor case,
    // which are different bug signatures.
    const err = getLastEmbeddingError()!
    expect(err).toContain("Endpoint rejected input even at")
    expect(err).toContain("250 chars")
    expect(err).toContain("Lower Settings → Embedding → Max Chunk Chars")
  })

  it("halving floor: 128-char input stops after 2 attempts (128 → 64; 64 is not > 64 so no further halving)", async () => {
    mockHttpFetch.mockImplementation(async () => oversizeErrorResponse(400))
    await searchByEmbedding("/tmp/p", "a".repeat(128), cfg, 5)
    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    const lens = mockHttpFetch.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string).input.length,
    )
    expect(lens).toEqual([128, 64])
  })

  it("halving floor: 130-char input produces 3 attempts (130 → 65 is > 64 so halves once more to 32)", async () => {
    mockHttpFetch.mockImplementation(async () => oversizeErrorResponse(400))
    await searchByEmbedding("/tmp/p", "a".repeat(130), cfg, 5)
    expect(mockHttpFetch).toHaveBeenCalledTimes(3)
    const lens = mockHttpFetch.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string).input.length,
    )
    expect(lens).toEqual([130, 65, 32])
  })

  it("recognizes a variety of oversize error phrases (not just 'exceeds maximum context')", async () => {
    // Table-driven: every phrase that looksLikeOversizeError treats as
    // oversize must trigger the halve path. If a regression changes
    // the phrase list, the matching case stops halving (1 call instead
    // of 2) and this test catches it.
    const phrases = [
      "this input is too long for the model",
      "context length 512 surpassed",
      "token limit hit",
      "max_tokens exceeded for this request",
      "max tokens 2048 is less than input",
      "input length 3200 is over budget",
    ]
    for (const phrase of phrases) {
      mockHttpFetch.mockReset()
      mockHttpFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: phrase }), { status: 400, statusText: "Bad Request" }),
        )
        .mockResolvedValueOnce(okResponse([0.1]))
      mockInvoke.mockReset()
      mockInvoke.mockResolvedValueOnce([
        { chunk_id: "P#0", page_id: "P", chunk_index: 0, chunk_text: "", heading_path: "", score: 0.5 },
      ])
      await searchByEmbedding("/tmp/p", "a".repeat(500), cfg, 5)
      // Exactly 2 fetches = initial rejected + halved succeeded.
      expect(mockHttpFetch, `phrase="${phrase}"`).toHaveBeenCalledTimes(2)
    }
  })

  it("surfaces a 'Network error' message when the fetch itself throws a TypeError", async () => {
    mockHttpFetch.mockImplementationOnce(async () => {
      throw new TypeError("Load failed")
    })
    const out = await searchByEmbedding("/tmp/p", "q", cfg, 5)
    expect(out).toEqual([])
    const err = getLastEmbeddingError()!
    expect(err).toContain("Network error reaching")
    expect(err).toContain(cfg.endpoint)
  })

  it("returns null + surfaces a descriptive error when 200 response is missing data[0].embedding", async () => {
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ wrong_field: [1, 2] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const out = await searchByEmbedding("/tmp/p", "q", cfg, 5)
    expect(out).toEqual([])
    const err = getLastEmbeddingError()!
    expect(err).toContain("missing data[0].embedding")
  })

  it("clears lastEmbeddingError after a successful fetch following a failure", async () => {
    // First call fails with 401 (sets lastEmbeddingError).
    mockHttpFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401, statusText: "Unauthorized" }),
    )
    await searchByEmbedding("/tmp/p", "q", cfg, 5)
    expect(getLastEmbeddingError()).toContain("API 401")

    // Second call succeeds → last error must clear.
    mockHttpFetch.mockResolvedValueOnce(okResponse([0.1]))
    mockInvoke.mockResolvedValueOnce([
      { chunk_id: "P#0", page_id: "P", chunk_index: 0, chunk_text: "", heading_path: "", score: 0.5 },
    ])
    await searchByEmbedding("/tmp/p", "q", cfg, 5)
    expect(getLastEmbeddingError()).toBeNull()
  })

  it("does not let a concurrent success erase a later failure", async () => {
    mockEmbeddingFetchInvoke.mockImplementation(async (args) => {
      const { text } = args as { text: string }
      if (text === "fails") {
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error("concurrent embedding failed")
      }
      await new Promise((resolve) => setTimeout(resolve, 15))
      return [0.1]
    })
    await Promise.all([
      fetchEmbedding("fails", cfg),
      fetchEmbedding("succeeds", cfg),
    ])
    expect(getLastEmbeddingError()).toContain("concurrent embedding failed")

    mockEmbeddingFetchInvoke.mockResolvedValueOnce([0.2])
    await fetchEmbedding("later sequential success", cfg)
    expect(getLastEmbeddingError()).toBeNull()
  })
})

// ── embedPage — replaces page's chunks in LanceDB ──────────────────

describe("embedPage", () => {
  it("chunks the page, embeds each, and upserts", async () => {
    // Fresh Response per call — Response body streams can't be
    // double-consumed.
    mockHttpFetch.mockImplementation(async () => okResponse([0.1, 0.2, 0.3]))

    // Short page (60 chars of body) → exactly one chunk under default opts.
    await embedPage(
      "/tmp/p",
      "rope",
      "RoPE",
      "# RoPE\n\nRotary positional embeddings are a positional-encoding scheme.",
      cfg,
    )

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const [cmd, args] = mockInvoke.mock.calls[0]
    expect(cmd).toBe("vector_upsert_chunks")
    // TS→Rust conversion happens at the Tauri boundary — from the TS
    // side the arg object keeps its camelCase keys.
    const payload = args as {
      pageId: string
      chunks: Array<{ chunk_index: number; chunk_text: string; heading_path: string; embedding: number[] }>
    }
    expect(payload.pageId).toBe("rope")
    // Exact count — short body should produce exactly one chunk.
    expect(payload.chunks).toHaveLength(1)
    expect(payload.chunks[0].chunk_index).toBe(0)
    expect(payload.chunks[0].chunk_text).toContain("Rotary positional embeddings")
    // Math.fround(0.1) / 0.2 / 0.3 are the exact f32 representations
    // the Rust side will see. Assert the EXACT rounded value so a
    // regression that removed Math.fround is caught.
    const emb = payload.chunks[0].embedding
    expect(emb).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)])
    // Also confirm f32 rounding actually drifted the representation
    // (sanity check that we're not comparing to the f64 inputs).
    expect(emb[0]).not.toBe(0.1)
  })

  it("optimizes periodically for incremental page embeddings", async () => {
    mockHttpFetch.mockImplementation(async () => okResponse([0.1, 0.2, 0.3]))

    for (let i = 0; i < 20; i++) {
      await embedPage("/tmp/incremental", `page-${i}`, `Page ${i}`, "body text", cfg)
    }

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands.filter((command) => command === "vector_upsert_chunks")).toHaveLength(20)
    expect(commands.filter((command) => command === "vector_optimize_chunks")).toHaveLength(1)
    expect(commands[commands.length - 1]).toBe("vector_optimize_chunks")
  })

  it("does not optimize before the incremental threshold is reached", async () => {
    mockHttpFetch.mockImplementation(async () => okResponse([0.1, 0.2, 0.3]))

    for (let i = 0; i < 19; i++) {
      await embedPage("/tmp/incremental-under-threshold", `page-${i}`, `Page ${i}`, "body text", cfg)
    }

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands.filter((command) => command === "vector_upsert_chunks")).toHaveLength(19)
    expect(commands).not.toContain("vector_optimize_chunks")
  })

  it("tracks incremental optimization thresholds per project", async () => {
    mockHttpFetch.mockImplementation(async () => okResponse([0.1, 0.2, 0.3]))

    for (let i = 0; i < 19; i++) {
      await embedPage("/tmp/project-a", `page-${i}`, `Page ${i}`, "body text", cfg)
    }
    await embedPage("/tmp/project-b", "page-b", "Page B", "body text", cfg)

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands.filter((command) => command === "vector_upsert_chunks")).toHaveLength(20)
    expect(commands).not.toContain("vector_optimize_chunks")
  })

  it("keeps successful chunks even when some fail, preserving original chunk_index gaps", async () => {
    // Two 1100-char paragraphs under default opts produce exactly 3
    // chunks after packing + merging + overlap. Fail the middle embed
    // (call index 1) — upsert must receive 2 rows at indexes 0 and 2,
    // proving the failed chunk's index is preserved (NOT backfilled
    // to [0, 1]) so a re-embed later can update the gap directly.
    const para = "a".repeat(1100)
    const content = `${para}\n\n${para}`
    let call = 0
    mockHttpFetch.mockImplementation(async () => {
      const i = call++
      // 404 Not Found — not an oversize phrase, so fetchEmbedding
      // returns null immediately without halving/retrying.
      if (i === 1) return new Response("not found", { status: 404, statusText: "Not Found" })
      return okResponse([0.5])
    })

    await embedPage("/tmp/p", "page", "Page", content, cfg)

    // Exactly 3 embed attempts (one per chunk), 2 successes, 1 upsert.
    expect(mockHttpFetch).toHaveBeenCalledTimes(3)
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const payload = mockInvoke.mock.calls[0][1] as {
      chunks: Array<{ chunk_index: number }>
    }
    expect(payload.chunks.map((c) => c.chunk_index)).toEqual([0, 2])
  })

  it("skips LanceDB call when all chunks fail to embed", async () => {
    mockHttpFetch.mockImplementation(async () => genericErrorResponse(500, "internal"))
    await embedPage("/tmp/p", "rope", "RoPE", "# RoPE\n\nbody text", cfg)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("no-ops when embedding is disabled in config", async () => {
    const disabled = { ...cfg, enabled: false }
    await embedPage("/tmp/p", "rope", "RoPE", "body", disabled)
    expect(mockHttpFetch).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("no-ops when the content produces zero chunks (empty page)", async () => {
    await embedPage("/tmp/p", "rope", "RoPE", "   ", cfg)
    expect(mockHttpFetch).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("passes page title + heading path + chunk text joined by blank lines to the embed request", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.5]))

    await embedPage(
      "/tmp/p",
      "attention",
      "Attention Mechanism",
      "## Intro\n\nCore concept of Transformers.",
      cfg,
    )

    const body = JSON.parse((mockHttpFetch.mock.calls[0][1] as RequestInit).body as string)
    // Exact shape: title + \n\n + heading path + \n\n + chunk text.
    // A regression that drops the heading-path prefix (the most
    // important context signal for short chunks) would be caught here.
    expect(body.input).toBe(
      "Attention Mechanism\n\n## Intro\n\n## Intro\n\nCore concept of Transformers.",
    )
  })

  it("omits the heading-path prefix when the chunk is preamble (empty headingPath)", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.5]))
    await embedPage(
      "/tmp/p",
      "rope",
      "RoPE",
      "Preamble sentence before any heading.",
      cfg,
    )
    const body = JSON.parse((mockHttpFetch.mock.calls[0][1] as RequestInit).body as string)
    // No empty blank line between title and body — enrichment must
    // skip empty parts rather than emit `"RoPE\n\n\n\nPreamble..."`.
    expect(body.input).toBe("RoPE\n\nPreamble sentence before any heading.")
  })

  it("omits the title prefix when pageTitle is empty/whitespace", async () => {
    mockHttpFetch.mockResolvedValue(okResponse([0.5]))
    await embedPage("/tmp/p", "rope", "   ", "## H\n\nbody text.", cfg)
    const body = JSON.parse((mockHttpFetch.mock.calls[0][1] as RequestInit).body as string)
    // Must NOT start with "\n\n" (would indicate an empty title was
    // joined in). Must start with the heading path.
    expect(body.input.startsWith("## H")).toBe(true)
  })

  it("no-ops when cfg.model is empty (uninitialized embedding config)", async () => {
    const noModel = { ...cfg, model: "" }
    await embedPage("/tmp/p", "rope", "RoPE", "some body text", noModel)
    expect(mockHttpFetch).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("honors cfg.maxChunkChars: smaller value produces more chunks", async () => {
    // Wiring check for the Settings → Embedding chunk-size knob.
    // Input is a single paragraph of exactly 2000 chars. With the
    // default targetChars=1000 we expect ~2 chunks; with maxChunkChars
    // forced to 400 we should see noticeably more (roughly 5 pieces
    // before merging). If the draft → cfg → chunker plumbing breaks,
    // BOTH calls would produce the same chunk count and this fires.
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    const content = "a".repeat(2000)

    mockInvoke.mockClear()
    await embedPage("/tmp/p", "p", "P", content, { ...cfg })
    const defaultChunks = (
      mockInvoke.mock.calls[0][1] as { chunks: unknown[] }
    ).chunks.length

    mockInvoke.mockClear()
    await embedPage("/tmp/p", "p", "P", content, {
      ...cfg,
      maxChunkChars: 400,
    })
    const smallChunks = (
      mockInvoke.mock.calls[0][1] as { chunks: unknown[] }
    ).chunks.length

    expect(
      smallChunks,
      `expected more chunks at maxChunkChars=400 than at default 1000; got small=${smallChunks} default=${defaultChunks}`,
    ).toBeGreaterThan(defaultChunks)
  })

  it("honors cfg.overlapChunkChars: larger overlap produces longer subsequent chunks", async () => {
    // Wiring check for the overlap knob. Same input, only difference
    // is overlapChunkChars. Non-first chunks under overlap=200 must
    // be meaningfully longer than their overlap=0 counterparts —
    // the overlap injection is literally prepended text.
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))
    const content = `${"ab ".repeat(400)}\n\n${"cd ".repeat(400)}`

    mockInvoke.mockClear()
    await embedPage("/tmp/p", "p", "P", content, { ...cfg, overlapChunkChars: 0 })
    const zeroOverlap = (
      mockInvoke.mock.calls[0][1] as { chunks: Array<{ chunk_text: string }> }
    ).chunks

    mockInvoke.mockClear()
    await embedPage("/tmp/p", "p", "P", content, { ...cfg, overlapChunkChars: 200 })
    const bigOverlap = (
      mockInvoke.mock.calls[0][1] as { chunks: Array<{ chunk_text: string }> }
    ).chunks

    expect(zeroOverlap.length).toBeGreaterThanOrEqual(2)
    expect(bigOverlap).toHaveLength(zeroOverlap.length)

    // The first chunk is identical (no prepending); chunks 1..N have
    // the overlap prefix from the previous chunk's tail added.
    expect(bigOverlap[0].chunk_text).toBe(zeroOverlap[0].chunk_text)
    for (let i = 1; i < bigOverlap.length; i++) {
      const delta = bigOverlap[i].chunk_text.length - zeroOverlap[i].chunk_text.length
      expect(
        delta,
        `chunk[${i}] overlap delta=${delta} (zero=${zeroOverlap[i].chunk_text.length}, big=${bigOverlap[i].chunk_text.length}) — cfg.overlapChunkChars plumbing is probably broken`,
      ).toBeGreaterThanOrEqual(100)
    }
  })
})

// ── embedAllPages — walk wiki tree, skip structural pages ───────────

describe("embedAllPages", () => {
  // Helpers to mock the fs commands that embedding.ts reads from.
  // The mock factory created vi.fn() instances at module load (see the
  // top-level vi.mock("@/commands/fs", ...)); we grab references here
  // via dynamic import so per-test setup can script them.
  let listDirectoryMock: ReturnType<typeof vi.fn>
  let readFileMock: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    const fs = await import("@/commands/fs")
    listDirectoryMock = fs.listDirectory as ReturnType<typeof vi.fn>
    readFileMock = fs.readFile as ReturnType<typeof vi.fn>
    listDirectoryMock.mockReset()
    readFileMock.mockReset()
    // Default: every upsert succeeds. Each embed returns a shared
    // vector via mockHttpFetch — set per-test.
    mockInvoke.mockResolvedValue(undefined)
  })

  const makeTree = () => [
    { name: "rope.md", path: "/proj/wiki/rope.md", is_dir: false },
    { name: "index.md", path: "/proj/wiki/index.md", is_dir: false }, // skip
    { name: "log.md", path: "/proj/wiki/log.md", is_dir: false }, // skip
    { name: "overview.md", path: "/proj/wiki/overview.md", is_dir: false }, // skip
    { name: "purpose.md", path: "/proj/wiki/purpose.md", is_dir: false }, // skip
    { name: "schema.md", path: "/proj/wiki/schema.md", is_dir: false }, // skip
    { name: "notes.txt", path: "/proj/wiki/notes.txt", is_dir: false }, // non-md
    {
      name: "sub",
      path: "/proj/wiki/sub",
      is_dir: true,
      children: [
        { name: "attention.md", path: "/proj/wiki/sub/attention.md", is_dir: false },
      ],
    },
  ]

  it("bounds embedding requests by the configured global concurrency", async () => {
    listDirectoryMock.mockResolvedValueOnce(Array.from({ length: 6 }, (_, index) => ({
      name: `page-${index}.md`,
      path: `/proj/wiki/page-${index}.md`,
      is_dir: false,
    })))
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    let active = 0
    let peak = 0
    mockEmbeddingFetchInvoke.mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return [0.5]
    })

    await expect(embedAllPages("/proj", { ...cfg, concurrency: 3 })).resolves.toBe(6)
    expect(peak).toBe(3)
  })

  it("uses OpenAI-compatible batch requests and preserves chunk order", async () => {
    listDirectoryMock.mockResolvedValueOnce([])
    const batchCalls: Array<{ texts: string[] }> = []
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "embedding_fetch_batch") {
        const input = args as { texts: string[] }
        batchCalls.push(input)
        return input.texts.map((_, index) => [index + 0.25])
      }
      return undefined
    })
    const content = Array.from(
      { length: 8 },
      (_, index) => `## Section ${index}\n\n${`content-${index} `.repeat(40)}`,
    ).join("\n\n")

    await expect(embedPage("/proj", "batched", "Batched", content, {
      ...cfg,
      maxChunkChars: 240,
      overlapChunkChars: 0,
      batchSize: 4,
      concurrency: 2,
    })).resolves.toBe(true)
    expect(batchCalls.length).toBeGreaterThan(0)
    expect(batchCalls.every((call) => call.texts.length <= 4)).toBe(true)
    const upsert = mockInvoke.mock.calls.find((call) => call[0] === "vector_upsert_chunks")
    const chunks = (upsert?.[1] as { chunks: Array<{ chunk_index: number }> }).chunks
    expect(chunks.map((chunk) => chunk.chunk_index)).toEqual(
      [...chunks].map((chunk) => chunk.chunk_index).sort((a, b) => a - b),
    )
  })

  it("embeds chunks from one page concurrently without exceeding the limit", async () => {
    let active = 0
    let peak = 0
    mockEmbeddingFetchInvoke.mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return [0.5]
    })
    const content = Array.from(
      { length: 8 },
      (_, index) => `## Section ${index}\n\n${`content-${index} `.repeat(40)}`,
    ).join("\n\n")

    await expect(embedPage("/proj", "concurrent", "Concurrent", content, {
      ...cfg,
      maxChunkChars: 240,
      overlapChunkChars: 0,
      concurrency: 3,
      batchSize: 1,
    })).resolves.toBe(true)
    expect(peak).toBe(3)
  })

  it("indexes every non-structural .md file, recursing into subdirs", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    const count = await embedAllPages("/proj", cfg)

    // 2 non-structural pages: rope.md and sub/attention.md.
    expect(count).toBe(2)
    // 2 upsert invokes, one per indexed page — other commands may
    // appear if the production code adds helpers later, but this
    // filter pins the exact pageIds.
    const upsertCalls = mockInvoke.mock.calls.filter((c) => c[0] === "vector_upsert_chunks")
    expect(upsertCalls).toHaveLength(2)
    const pageIds = upsertCalls.map((c) => (c[1] as { pageId: string }).pageId).sort()
    expect(pageIds).toEqual(["attention", "rope"])
  })

  it("clears the chunk table before a forced rebuild", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    const count = await embedAllPages(
      "/proj",
      cfg,
      undefined,
      { clearExisting: true },
    )

    expect(count).toBe(2)
    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands[0]).toBe("vector_clear_chunks")
    expect(commands.filter((cmd) => cmd === "vector_upsert_chunks")).toHaveLength(2)
  })

  it("does not clear the chunk table during ordinary embedAllPages runs", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    await embedAllPages("/proj", cfg)

    expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain("vector_clear_chunks")
    expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain("vector_drop_legacy")
  })

  it("optimizes the chunk table after ordinary batch indexing succeeds", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    await embedAllPages("/proj", cfg)

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands.filter((command) => command === "vector_upsert_chunks")).toHaveLength(2)
    expect(commands[commands.length - 1]).toBe("vector_optimize_chunks")
    expect(commands).not.toContain("vector_drop_legacy")
  })

  it("optimizes the chunk table after a forced rebuild succeeds", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    await embedAllPages("/proj", cfg, undefined, { clearExisting: true })

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands[0]).toBe("vector_clear_chunks")
    expect(commands.filter((command) => command === "vector_upsert_chunks")).toHaveLength(2)
    expect(commands).toContain("vector_optimize_chunks")
    expect(commands.indexOf("vector_optimize_chunks")).toBeGreaterThan(commands.lastIndexOf("vector_upsert_chunks"))
    expect(commands.indexOf("vector_drop_legacy")).toBeGreaterThan(commands.indexOf("vector_optimize_chunks"))
  })

  it("does not fail indexing when chunk table optimization fails", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockImplementation(async (command) => {
      if (command === "vector_optimize_chunks") {
        throw new Error("lancedb optimize failed")
      }
      return undefined
    })

    await expect(embedAllPages("/proj", cfg)).resolves.toBe(2)
    expect(mockInvoke.mock.calls.map((call) => call[0])).toContain("vector_optimize_chunks")
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("LanceDB chunk optimization failed"),
    )
    warn.mockRestore()
  })

  it("does not fail forced rebuild when chunk table optimization fails", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockImplementation(async (command) => {
      if (command === "vector_optimize_chunks") {
        throw new Error("lancedb optimize failed")
      }
      return undefined
    })

    await expect(embedAllPages("/proj", cfg, undefined, { clearExisting: true })).resolves.toBe(2)
    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands[0]).toBe("vector_clear_chunks")
    expect(commands).toContain("vector_optimize_chunks")
    expect(commands).toContain("vector_drop_legacy")
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("LanceDB chunk optimization failed"),
    )
    warn.mockRestore()
  })

  it("drops the legacy per-page table after a successful forced rebuild", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    await expect(embedAllPages("/proj", cfg, undefined, { clearExisting: true })).resolves.toBe(2)

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands).toContain("vector_clear_chunks")
    expect(commands).toContain("vector_drop_legacy")
    expect(commands.indexOf("vector_drop_legacy")).toBeGreaterThan(commands.lastIndexOf("vector_upsert_chunks"))
  })

  it("does not fail a successful forced rebuild when legacy table cleanup fails", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockImplementation(async (command) => {
      if (command === "vector_drop_legacy") {
        throw new Error("legacy table locked")
      }
      return undefined
    })

    await expect(embedAllPages("/proj", cfg, undefined, { clearExisting: true })).resolves.toBe(2)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Legacy vector table cleanup failed"),
    )
    warn.mockRestore()
  })

  it("updates successful pages without clearing existing chunks when some pages fail", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "a.md", path: "/proj/wiki/a.md", is_dir: false },
      { name: "b.md", path: "/proj/wiki/b.md", is_dir: false },
    ])
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch
      .mockResolvedValueOnce(okResponse([0.5]))
      .mockResolvedValueOnce(genericErrorResponse(500, "embedding server down"))

    let message = ""
    try {
      await embedAllPages(
        "/proj",
        cfg,
        undefined,
        { clearExisting: true },
      )
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("1 of 2 pages could not be embedded")
    expect(message).toContain("1 successful page(s) were updated")
    expect(message).not.toContain("Re-index failed: Re-index failed")

    expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain("vector_clear_chunks")
    expect(mockInvoke.mock.calls.map((call) => call[0])).toContain("vector_upsert_chunks")
    expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain("vector_drop_legacy")
  })

  it("does not clear existing chunks when forced rebuild cannot embed any page", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockResolvedValue(genericErrorResponse(500, "embedding server down"))

    await expect(embedAllPages(
      "/proj",
      cfg,
      undefined,
      { clearExisting: true },
    )).rejects.toThrow("2 of 2 pages could not be embedded")

    expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain("vector_clear_chunks")
    expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain("vector_upsert_chunks")
    expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain("vector_drop_legacy")
  })

  it("skips empty content pages during forced rebuild without treating them as failures", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "empty.md", path: "/proj/wiki/empty.md", is_dir: false },
      { name: "body.md", path: "/proj/wiki/body.md", is_dir: false },
    ])
    readFileMock
      .mockResolvedValueOnce("---\ntitle: Empty Stub\n---\n")
      .mockResolvedValueOnce("# Body\n\nThis page has content.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    const count = await embedAllPages(
      "/proj",
      cfg,
      undefined,
      { clearExisting: true },
    )

    expect(count).toBe(1)
    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands[0]).toBe("vector_clear_chunks")
    expect(commands).toContain("vector_drop_legacy")
    const upserts = mockInvoke.mock.calls.filter((call) => call[0] === "vector_upsert_chunks")
    expect(upserts).toHaveLength(1)
    expect((upserts[0][1] as { pageId: string }).pageId).toBe("body")
    expect(commands.indexOf("vector_drop_legacy")).toBeGreaterThan(commands.lastIndexOf("vector_upsert_chunks"))
  })

  it("does not clear existing chunks when a forced rebuild page only embeds partially", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "partial.md", path: "/proj/wiki/partial.md", is_dir: false },
    ])
    readFileMock.mockResolvedValueOnce(`${"First chunk body. ".repeat(20)}\n\n${"Second chunk body. ".repeat(20)}`)
    const smallChunks = { ...cfg, maxChunkChars: 220, overlapChunkChars: 0 }
    mockHttpFetch
      .mockResolvedValueOnce(okResponse([0.5]))
      .mockResolvedValueOnce(genericErrorResponse(500, "embedding server down"))

    let message = ""
    try {
      await embedAllPages(
        "/proj",
        smallChunks,
        undefined,
        { clearExisting: true },
      )
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("chunks failed to embed")
    expect(message).toContain("Check endpoint URL")

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands).not.toContain("vector_clear_chunks")
    expect(commands).not.toContain("vector_upsert_chunks")
    expect(commands).not.toContain("vector_drop_legacy")
  })

  it("surfaces an incomplete-index warning when forced rebuild write fails after clearing", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "a.md", path: "/proj/wiki/a.md", is_dir: false },
      { name: "b.md", path: "/proj/wiki/b.md", is_dir: false },
    ])
    readFileMock.mockResolvedValue("# Title\n\nBody.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))
    let upsertCount = 0
    mockInvoke.mockImplementation(async (command) => {
      if (command === "vector_upsert_chunks") {
        upsertCount++
        if (upsertCount === 2) throw new Error("lancedb write failed")
      }
      return undefined
    })

    await expect(embedAllPages(
      "/proj",
      cfg,
      undefined,
      { clearExisting: true },
    )).rejects.toThrow("rebuilt index may be incomplete")

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands[0]).toBe("vector_clear_chunks")
    expect(commands.filter((command) => command === "vector_upsert_chunks")).toHaveLength(2)
    expect(commands).not.toContain("vector_drop_legacy")
  })

  it("clears stale chunks when forced rebuild has no content pages in a readable wiki tree", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "index.md", path: "/proj/wiki/index.md", is_dir: false },
      { name: "log.md", path: "/proj/wiki/log.md", is_dir: false },
    ])
    mockInvoke.mockImplementation(async (command) => {
      if (command === "vector_count_chunks") return 0
      return undefined
    })

    const out = await embedAllPages(
      "/proj",
      cfg,
      undefined,
      { clearExisting: true },
    )

    expect(out).toBe(0)
    expect(mockInvoke.mock.calls.map((call) => call[0])).toContain("vector_clear_chunks")
    expect(mockInvoke.mock.calls.map((call) => call[0])).toContain("vector_drop_legacy")
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("does not clear existing chunks when all content pages are empty", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "empty.md", path: "/proj/wiki/empty.md", is_dir: false },
    ])
    readFileMock.mockResolvedValueOnce("---\ntitle: Empty Stub\n---\n")
    mockInvoke.mockImplementation(async (command) => {
      if (command === "vector_count_chunks") return 5
      return undefined
    })

    await expect(embedAllPages(
      "/proj",
      cfg,
      undefined,
      { clearExisting: true },
    )).rejects.toThrow("Existing index was left unchanged")

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands).toContain("vector_count_chunks")
    expect(commands).not.toContain("vector_clear_chunks")
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("does not clear existing chunks when a readable wiki tree unexpectedly has no content pages", async () => {
    listDirectoryMock.mockResolvedValueOnce([])
    mockInvoke.mockImplementation(async (command) => {
      if (command === "vector_count_chunks") return 7
      return undefined
    })

    await expect(embedAllPages(
      "/proj",
      cfg,
      undefined,
      { clearExisting: true },
    )).rejects.toThrow("Existing index was left unchanged")

    const commands = mockInvoke.mock.calls.map((call) => call[0])
    expect(commands).toContain("vector_count_chunks")
    expect(commands).not.toContain("vector_clear_chunks")
  })

  it("extracts the title from YAML frontmatter when present", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "rope.md", path: "/proj/wiki/rope.md", is_dir: false },
    ])
    readFileMock.mockResolvedValueOnce(
      `---\ntitle: "RoPE 旋转位置编码"\ntype: concept\n---\n# RoPE\n\nBody.`,
    )
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))
    await embedAllPages("/proj", cfg)
    const body = JSON.parse((mockHttpFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.input.startsWith("RoPE 旋转位置编码")).toBe(true)
  })

  it("falls back to the file id (without .md) when frontmatter has no title", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "mystery.md", path: "/proj/wiki/mystery.md", is_dir: false },
    ])
    readFileMock.mockResolvedValueOnce("no frontmatter here, just body.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))
    await embedAllPages("/proj", cfg)
    const body = JSON.parse((mockHttpFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.input.startsWith("mystery")).toBe(true)
  })

  it("invokes onProgress exactly once per indexed file with increasing done & constant total", async () => {
    listDirectoryMock.mockResolvedValueOnce(makeTree())
    readFileMock.mockResolvedValue("body.")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    const progress: Array<[number, number]> = []
    await embedAllPages("/proj", cfg, (done, total) => progress.push([done, total]))
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it("returns 0 and makes no network calls when embedding is disabled", async () => {
    const disabled = { ...cfg, enabled: false }
    const out = await embedAllPages("/proj", disabled)
    expect(out).toBe(0)
    // Guard runs before listDirectory, so nothing is called.
    expect(listDirectoryMock).not.toHaveBeenCalled()
    expect(mockHttpFetch).not.toHaveBeenCalled()
  })

  it("returns 0 when listDirectory throws (project has no wiki dir yet)", async () => {
    listDirectoryMock.mockRejectedValueOnce(new Error("ENOENT: no such file"))
    const out = await embedAllPages("/proj", cfg)
    expect(out).toBe(0)
  })

  it("does not clear existing chunks when forced rebuild cannot read the wiki tree", async () => {
    listDirectoryMock.mockRejectedValueOnce(new Error("ENOENT: no such file"))

    await expect(embedAllPages(
      "/proj",
      cfg,
      undefined,
      { clearExisting: true },
    )).rejects.toThrow("Could not read wiki tree")

    expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain("vector_clear_chunks")
  })

  it("continues with remaining files when one file's readFile throws", async () => {
    listDirectoryMock.mockResolvedValueOnce([
      { name: "a.md", path: "/proj/wiki/a.md", is_dir: false },
      { name: "b.md", path: "/proj/wiki/b.md", is_dir: false },
    ])
    // First file fails, second succeeds.
    readFileMock
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce("body for b")
    mockHttpFetch.mockImplementation(async () => okResponse([0.5]))

    const count = await embedAllPages("/proj", cfg)
    expect(count).toBe(1)
    const upserts = mockInvoke.mock.calls.filter((c) => c[0] === "vector_upsert_chunks")
    expect(upserts).toHaveLength(1)
    expect((upserts[0][1] as { pageId: string }).pageId).toBe("b")
  })
})

// ── Legacy & misc helpers ───────────────────────────────────────────

describe("legacyVectorRowCount / dropLegacyVectorTable / getEmbeddingCount / removePageEmbedding", () => {
  it("legacyVectorRowCount: returns the Rust row count on success, 0 on error", async () => {
    mockInvoke.mockResolvedValueOnce(42)
    const n = await legacyVectorRowCount("/proj")
    expect(n).toBe(42)
    expect(mockInvoke).toHaveBeenCalledWith("vector_legacy_row_count", {
      projectPath: "/proj",
    })

    mockInvoke.mockRejectedValueOnce(new Error("legacy table missing"))
    const n2 = await legacyVectorRowCount("/proj")
    expect(n2).toBe(0)
  })

  it("dropLegacyVectorTable: invokes the Rust command with normalized path, propagates throws", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await dropLegacyVectorTable("/proj")
    expect(mockInvoke).toHaveBeenCalledWith("vector_drop_legacy", {
      projectPath: "/proj",
    })

    // Unlike the read helpers, drop is destructive enough that a
    // failure SHOULD propagate — callers can show the error in UI.
    mockInvoke.mockRejectedValueOnce(new Error("lock contention"))
    await expect(dropLegacyVectorTable("/proj")).rejects.toThrow("lock contention")
  })

  it("getEmbeddingCount: returns chunk count, swallows errors to 0", async () => {
    mockInvoke.mockResolvedValueOnce(128)
    expect(await getEmbeddingCount("/proj")).toBe(128)
    expect(mockInvoke).toHaveBeenCalledWith("vector_count_chunks", {
      projectPath: "/proj",
    })

    mockInvoke.mockRejectedValueOnce(new Error("table missing"))
    expect(await getEmbeddingCount("/proj")).toBe(0)
  })

  it("removePageEmbedding: invokes vector_delete_page, swallows errors silently", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await removePageEmbedding("/proj", "rope")
    expect(mockInvoke).toHaveBeenCalledWith("vector_delete_page", {
      projectPath: "/proj",
      pageId: "rope",
    })

    mockInvoke.mockRejectedValueOnce(new Error("table missing"))
    // Must not throw — source-delete flow depends on silent failure.
    await expect(removePageEmbedding("/proj", "rope")).resolves.toBeUndefined()
  })
})

describe("extractEmbeddingTitle", () => {
  it("does not read a body prose line starting with title: as the frontmatter title", () => {
    const content = "---\ntype: entity\n---\n# Real Heading\n\nSome text.\ntitle: not-frontmatter-at-all\n"
    expect(extractEmbeddingTitle(content, "mypage")).toBe("mypage")
  })

  it("still uses a genuine frontmatter title", () => {
    const content = "---\ntitle: Real Title\n---\n# Real Title\n"
    expect(extractEmbeddingTitle(content, "mypage")).toBe("Real Title")
  })

  it("falls back to fallbackId when there is no frontmatter at all", () => {
    expect(extractEmbeddingTitle("# Just a heading\n\nBody text.", "mypage")).toBe("mypage")
  })
})
