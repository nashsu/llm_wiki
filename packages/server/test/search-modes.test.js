// Tests for retrieval-mode enforcement in search_project (issue #14 gap).
//
// wikiSearchMode governs the legs: keyword = keyword+graph, vector =
// vector+graph, hybrid = all. The mode resolves param → shared store →
// hybrid. Vector-requested-but-unavailable degrades to keyword with
// vectorUnavailableReason instead of failing.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-mode-test-"))
process.env.LLM_WIKI_NO_SHARE = "1" // never touch a real desktop app-state.json

const { getDb, isVecAvailable } = await import("../src/store/db.js")
const { searchCommands } = await import("../src/commands/search.js")
const { vectorCommands } = await import("../src/commands/vectorstore.js")
const { writeStoreKey, deleteStoreKey } = await import("../src/store.js")
const { SHARED_STORE_NAME } = await import("../src/config.js")

getDb() // run migrations + load sqlite-vec before skipIf guards evaluate

const unit = (x) => {
  const n = Math.sqrt(x.reduce((s, v) => s + v * v, 0))
  return x.map((v) => v / n)
}
const Q = unit([1, 0, 0, 0])          // query direction
const NEAR = unit([0.99, 0.1, 0, 0])  // Alpha chunk — close to Q
const FAR = unit([0, 0, 1, 0])        // Beta chunk — orthogonal to Q
const EMB_CFG = { enabled: true, endpoint: "http://unused.local", model: "test" }

let project
const cleanups = []

function seedWiki() {
  project = mkdtempSync(path.join(tmpdir(), "llmwiki-mode-proj-"))
  cleanups.push(project)
  mkdirSync(path.join(project, ".llm-wiki"), { recursive: true })
  mkdirSync(path.join(project, "wiki"), { recursive: true })
  writeFileSync(path.join(project, ".llm-wiki", "project.json"), JSON.stringify({ id: "mode-test-project" }))
  writeFileSync(path.join(project, "wiki", "Alpha.md"), "# Alpha\n\nzebra stripes are visually unique patterns\n")
  writeFileSync(path.join(project, "wiki", "Beta.md"), "# Beta\n\nquantum fields permeate spacetime\n")
}

describe.skipIf(!isVecAvailable())("search retrieval modes", () => {
  beforeAll(async () => {
    seedWiki()
    await vectorCommands.vector_upsert_chunks({
      projectPath: project, pageId: "Alpha",
      chunks: [{ chunk_index: 0, chunk_text: "zebra stripes section", heading_path: "Alpha", embedding: NEAR }],
    })
    await vectorCommands.vector_upsert_chunks({
      projectPath: project, pageId: "Beta",
      chunks: [{ chunk_index: 0, chunk_text: "quantum fields section", heading_path: "Beta", embedding: FAR }],
    })
  })
  afterAll(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
    rmSync(process.env.LLM_WIKI_DATA_DIR, { recursive: true, force: true })
  })

  it("keyword mode never runs the vector leg (even with an embedding available)", async () => {
    const r = await searchCommands.search_project({
      projectPath: project, query: "zebra", wikiSearchMode: "keyword",
      queryEmbedding: Q, embeddingConfig: EMB_CFG,
    })
    expect(r.vectorHits).toBe(0)
    expect(r.tokenHits).toBeGreaterThan(0)
    expect(r.vectorUnavailableReason).toBeUndefined()
    expect(r.results.map((x) => x.title)).toContain("Alpha")
  })

  it("vector mode returns vector-ranked pages and skips keyword scoring", async () => {
    const r = await searchCommands.search_project({
      projectPath: project, query: "xylophone concerto", wikiSearchMode: "vector",
      queryEmbedding: Q, embeddingConfig: EMB_CFG,
    })
    expect(r.tokenHits).toBe(0)
    expect(r.vectorHits).toBeGreaterThan(0)
    expect(r.vectorUnavailableReason).toBeUndefined()
    // Alpha's chunk is near Q; Beta's is orthogonal — Alpha must rank first.
    expect(r.results[0].title).toBe("Alpha")
  })

  it("hybrid mode runs both legs", async () => {
    const r = await searchCommands.search_project({
      projectPath: project, query: "zebra", wikiSearchMode: "hybrid",
      queryEmbedding: Q, embeddingConfig: EMB_CFG,
    })
    expect(r.tokenHits).toBeGreaterThan(0)
    expect(r.vectorHits).toBeGreaterThan(0)
    expect(r.results.map((x) => x.title)).toContain("Alpha")
  })

  it("vector mode without a provider degrades to keyword with a reason", async () => {
    const r = await searchCommands.search_project({
      projectPath: project, query: "zebra", wikiSearchMode: "vector",
      embeddingConfig: null,
    })
    expect(r.vectorUnavailableReason).toMatch(/embedding provider/i)
    expect(r.tokenHits).toBeGreaterThan(0) // keyword fallback ran
    expect(r.results.map((x) => x.title)).toContain("Alpha")
  })

  it("hybrid mode with a disabled provider degrades to keyword with a reason", async () => {
    const r = await searchCommands.search_project({
      projectPath: project, query: "quantum", wikiSearchMode: "hybrid",
      embeddingConfig: { enabled: false, endpoint: "http://unused.local" },
    })
    expect(r.vectorUnavailableReason).toMatch(/embedding provider/i)
    expect(r.vectorHits).toBe(0)
    expect(r.results.map((x) => x.title)).toContain("Beta")
  })

  it("keyword mode reports no degradation reason even without a provider", async () => {
    const r = await searchCommands.search_project({
      projectPath: project, query: "zebra", wikiSearchMode: "keyword", embeddingConfig: null,
    })
    expect(r.vectorUnavailableReason).toBeUndefined()
    expect(r.vectorHits).toBe(0)
  })

  it("mode falls back to the shared store setting when not passed", async () => {
    writeStoreKey(SHARED_STORE_NAME, "wikiSearchMode", "keyword")
    try {
      const r = await searchCommands.search_project({
        projectPath: project, query: "zebra",
        queryEmbedding: Q, embeddingConfig: EMB_CFG, // would run vector if hybrid
      })
      expect(r.vectorHits).toBe(0) // store says keyword
    } finally {
      deleteStoreKey(SHARED_STORE_NAME, "wikiSearchMode")
    }
    const r2 = await searchCommands.search_project({
      projectPath: project, query: "zebra",
      queryEmbedding: Q, embeddingConfig: EMB_CFG,
    })
    expect(r2.vectorHits).toBeGreaterThan(0) // back to hybrid default
  })

  it("unknown stored values fall back to hybrid", async () => {
    writeStoreKey(SHARED_STORE_NAME, "wikiSearchMode", "bogus")
    try {
      const r = await searchCommands.search_project({
        projectPath: project, query: "zebra",
        queryEmbedding: Q, embeddingConfig: EMB_CFG,
      })
      expect(r.vectorHits).toBeGreaterThan(0)
    } finally {
      deleteStoreKey(SHARED_STORE_NAME, "wikiSearchMode")
    }
  })

  it("includeContent populates page content on both legs", async () => {
    const kw = await searchCommands.search_project({
      projectPath: project, query: "zebra", wikiSearchMode: "keyword", includeContent: true,
    })
    const alphaKw = kw.results.find((x) => x.title === "Alpha")
    expect(alphaKw?.content).toContain("zebra stripes")

    const vec = await searchCommands.search_project({
      projectPath: project, query: "xylophone concerto", wikiSearchMode: "vector",
      queryEmbedding: Q, embeddingConfig: EMB_CFG, includeContent: true,
    })
    expect(vec.results[0].title).toBe("Alpha")
    expect(vec.results[0].content).toContain("zebra stripes")

    const bare = await searchCommands.search_project({
      projectPath: project, query: "zebra", wikiSearchMode: "keyword",
    })
    expect(bare.results.find((x) => x.title === "Alpha")?.content).toBeUndefined()
  })

  // ── review-fix regressions (PR #27) ────────────────────────────────────

  it("explicit queryEmbedding is honored without an embedding config (desktop parity)", async () => {
    const r = await searchCommands.search_project({
      projectPath: project, query: "xylophone concerto", wikiSearchMode: "vector",
      queryEmbedding: Q, embeddingConfig: null,
    })
    expect(r.vectorUnavailableReason).toBeUndefined()
    expect(r.vectorHits).toBeGreaterThan(0)
    expect(r.results[0].title).toBe("Alpha")
  })

  it("fractional topK does not drop the vector leg", async () => {
    const r = await searchCommands.search_project({
      projectPath: project, query: "zebra", wikiSearchMode: "hybrid",
      queryEmbedding: Q, embeddingConfig: EMB_CFG, topK: 2.5,
    })
    expect(r.vectorUnavailableReason).toBeUndefined()
    expect(r.vectorHits).toBeGreaterThan(0)
  })

  it("vector mode with an empty index degrades to keyword with a reason", async () => {
    const fresh = mkdtempSync(path.join(tmpdir(), "llmwiki-mode-empty-"))
    cleanups.push(fresh)
    mkdirSync(path.join(fresh, ".llm-wiki"), { recursive: true })
    mkdirSync(path.join(fresh, "wiki"), { recursive: true })
    writeFileSync(path.join(fresh, ".llm-wiki", "project.json"), JSON.stringify({ id: "mode-empty-project" }))
    writeFileSync(path.join(fresh, "wiki", "Alpha.md"), "# Alpha\n\nzebra stripes are visually unique patterns\n")
    const r = await searchCommands.search_project({
      projectPath: fresh, query: "zebra", wikiSearchMode: "vector",
      queryEmbedding: Q, embeddingConfig: EMB_CFG,
    })
    expect(r.vectorHits).toBe(0)
    expect(r.vectorUnavailableReason).toMatch(/vector index is empty/i)
    expect(r.tokenHits).toBeGreaterThan(0) // keyword fallback ran
    expect(r.results.map((x) => x.title)).toContain("Alpha")
  })

  it("vector mode degrades to keyword when the vector leg throws mid-retrieval", async () => {
    const spy = vi.spyOn(vectorCommands, "vector_search_chunks")
      .mockRejectedValueOnce(new Error("boom"))
    try {
      const r = await searchCommands.search_project({
        projectPath: project, query: "zebra", wikiSearchMode: "vector",
        queryEmbedding: Q, embeddingConfig: EMB_CFG,
      })
      expect(r.vectorHits).toBe(0)
      expect(r.vectorUnavailableReason).toMatch(/failed during retrieval/i)
      expect(r.tokenHits).toBeGreaterThan(0) // keyword fallback ran
      expect(r.results.map((x) => x.title)).toContain("Alpha")
    } finally {
      spy.mockRestore()
    }
  })

  // LAST in this describe: recreates the vec0 table at a new dimension,
  // dropping the rows the earlier tests rely on.
  it("vector mode with a dimension mismatch degrades to keyword with a reason", async () => {
    const fresh = mkdtempSync(path.join(tmpdir(), "llmwiki-mode-dim-"))
    cleanups.push(fresh)
    mkdirSync(path.join(fresh, ".llm-wiki"), { recursive: true })
    mkdirSync(path.join(fresh, "wiki"), { recursive: true })
    writeFileSync(path.join(fresh, ".llm-wiki", "project.json"), JSON.stringify({ id: "mode-dim-project" }))
    writeFileSync(path.join(fresh, "wiki", "Alpha.md"), "# Alpha\n\nzebra stripes are visually unique patterns\n")
    // Provider switch: 8-dim embeddings recreate the table.
    await vectorCommands.vector_upsert_chunks({
      projectPath: fresh, pageId: "Alpha",
      chunks: [{ chunk_index: 0, chunk_text: "dim8", heading_path: "Alpha", embedding: [0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0] }],
    })
    const r = await searchCommands.search_project({
      projectPath: fresh, query: "zebra", wikiSearchMode: "vector",
      queryEmbedding: Q, embeddingConfig: EMB_CFG, // 4-dim query vs 8-dim index
    })
    expect(r.vectorHits).toBe(0)
    expect(r.vectorUnavailableReason).toMatch(/dimension does not match/i)
    expect(r.tokenHits).toBeGreaterThan(0) // keyword fallback ran
    expect(r.results.map((x) => x.title)).toContain("Alpha")
  })
})
