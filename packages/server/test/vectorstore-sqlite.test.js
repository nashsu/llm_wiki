// Tests for the SQLite-backed vector store (issue #14 gap).
//
// Covers: extension load, migration 012, upsert/search round-trip with score
// transform, project isolation, page replace/delete/clear semantics,
// dimension-change recreate, validation errors, and graceful degradation when
// sqlite-vec is unavailable.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Config reads LLM_WIKI_DATA_DIR at module load — set it before importing db.
process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-vec-test-"))

const { getDb, isVecAvailable } = await import("../src/store/db.js")
const { vectorCommands, vectorIndexHealth } = await import("../src/commands/vectorstore.js")

// Open the DB (runs migrations + loads the sqlite-vec extension) before the
// describe.skipIf guards evaluate.
getDb()

function makeProject(id) {
  const dir = mkdtempSync(path.join(tmpdir(), "llmwiki-vec-proj-"))
  mkdirSync(path.join(dir, ".llm-wiki"), { recursive: true })
  writeFileSync(path.join(dir, ".llm-wiki", "project.json"), JSON.stringify({ id }))
  return dir
}

const unit = (x) => {
  // unit-normalize a 4-d vector so cosine comparisons are exact
  const n = Math.sqrt(x.reduce((s, v) => s + v * v, 0))
  return x.map((v) => v / n)
}
const V = {
  a: unit([1, 0, 0, 0]),
  b: unit([0, 1, 0, 0]),
  c: unit([0.9, 0.1, 0, 0]), // close to a
  d: unit([0, 0, 1, 0]),
}

const cleanups = []

describe.skipIf(!isVecAvailable())("vectorstore (sqlite-vec)", () => {
  beforeAll(() => { getDb() })
  afterAll(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
    rmSync(process.env.LLM_WIKI_DATA_DIR, { recursive: true, force: true })
  })

  it("migration 012 applied: vec_meta exists, placeholder vec_chunks dropped", () => {
    const db = getDb()
    const meta = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_meta'`).get()
    expect(meta).toBeTruthy()
    // The lazy vec0 table does not exist before the first upsert.
    const chunks = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_chunks'`).get()
    expect(chunks).toBeUndefined()
    const applied = db.prepare(`SELECT name FROM _migrations WHERE name = '012_vec_chunks_vec0'`).get()
    expect(applied).toBeTruthy()
  })

  it("upsert + search round-trip: nearest chunk first, fields populated", async () => {
    const proj = makeProject("vec-rt-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj,
      pageId: "Page One",
      chunks: [
        { chunk_index: 0, chunk_text: "alpha text", heading_path: "H1 > H2", embedding: V.a },
        { chunk_index: 1, chunk_text: "beta text", heading_path: "H1", embedding: V.b },
      ],
    })

    const hits = await vectorCommands.vector_search_chunks({
      projectPath: proj, queryEmbedding: V.a, topK: 5,
    })
    expect(hits.length).toBe(2)
    expect(hits[0].chunk_id).toBe("Page One#0")
    expect(hits[0].chunk_text).toBe("alpha text")
    expect(hits[0].heading_path).toBe("H1 > H2")
    expect(hits[0].chunk_index).toBe(0)
    expect(hits[0].score).toBeCloseTo(1, 5) // distance 0 → 1/(1+0)
    expect(hits[1].chunk_id).toBe("Page One#1")
    // score transform: score = 1 / (1 + distance), distance = 1 - cosine
    expect(hits[1].score).toBeCloseTo(1 / (1 + 1), 5)
  })

  it("ranks by cosine similarity (near vector beats orthogonal)", async () => {
    const proj = makeProject("vec-rank-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj,
      pageId: "RankPage",
      chunks: [
        { chunk_index: 0, chunk_text: "far", heading_path: "", embedding: V.d },
        { chunk_index: 1, chunk_text: "near", heading_path: "", embedding: V.c },
      ],
    })
    const hits = await vectorCommands.vector_search_chunks({
      projectPath: proj, queryEmbedding: V.a, topK: 2,
    })
    expect(hits[0].chunk_text).toBe("near")
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it("isolates projects by project.json id", async () => {
    const projA = makeProject("vec-iso-A")
    const projB = makeProject("vec-iso-B")
    cleanups.push(projA, projB)
    await vectorCommands.vector_upsert_chunks({
      projectPath: projA, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "A only", heading_path: "", embedding: V.a }],
    })
    await vectorCommands.vector_upsert_chunks({
      projectPath: projB, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "B only", heading_path: "", embedding: V.b }],
    })
    const hitsA = await vectorCommands.vector_search_chunks({ projectPath: projA, queryEmbedding: V.a })
    const hitsB = await vectorCommands.vector_search_chunks({ projectPath: projB, queryEmbedding: V.a })
    expect(hitsA.map((h) => h.chunk_text)).toEqual(["A only"])
    expect(hitsB.map((h) => h.chunk_text)).toEqual(["B only"])
    expect(await vectorCommands.vector_count_chunks({ projectPath: projA })).toBe(1)
    expect(await vectorCommands.vector_count_chunks({ projectPath: projB })).toBe(1)
  })

  it("re-upserting a page replaces its chunks (no duplicates)", async () => {
    const proj = makeProject("vec-replace-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Page",
      chunks: [
        { chunk_index: 0, chunk_text: "old-0", heading_path: "", embedding: V.a },
        { chunk_index: 1, chunk_text: "old-1", heading_path: "", embedding: V.b },
      ],
    })
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Page",
      chunks: [{ chunk_index: 0, chunk_text: "new-0", heading_path: "", embedding: V.c }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a })
    expect(hits.length).toBe(1)
    expect(hits[0].chunk_text).toBe("new-0")
  })

  it("delete_page removes one page; clear_chunks removes the project's rows", async () => {
    const proj = makeProject("vec-delete-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Keep",
      chunks: [{ chunk_index: 0, chunk_text: "keep", heading_path: "", embedding: V.a }],
    })
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Gone",
      chunks: [{ chunk_index: 0, chunk_text: "gone", heading_path: "", embedding: V.b }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(2)
    await vectorCommands.vector_delete_page({ projectPath: proj, pageId: "Gone" })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    await vectorCommands.vector_clear_chunks({ projectPath: proj })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
  })

  it("dimension change recreates the table (stale rows dropped, old-dim queries empty)", async () => {
    const proj = makeProject("vec-dim-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P4",
      chunks: [{ chunk_index: 0, chunk_text: "dim4", heading_path: "", embedding: V.a }],
    })
    const dim8 = [0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0]
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P8",
      chunks: [{ chunk_index: 0, chunk_text: "dim8", heading_path: "", embedding: dim8 }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    // Old-dim query cannot match the new table: graceful empty result.
    expect(await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a })).toEqual([])
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: dim8 })
    expect(hits.map((h) => h.chunk_text)).toEqual(["dim8"])
    const db = getDb()
    expect(db.prepare(`SELECT dim FROM vec_meta WHERE id = 1`).get().dim).toBe(8)
  })

  it("topK limits results", async () => {
    const proj = makeProject("vec-topk-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Many",
      chunks: [V.a, V.b, V.d].map((embedding, i) => ({
        chunk_index: i, chunk_text: `c${i}`, heading_path: "", embedding,
      })),
    })
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a, topK: 2 })
    expect(hits.length).toBe(2)
  })

  it("rejects invalid embeddings and page ids", async () => {
    const proj = makeProject("vec-invalid-project")
    cleanups.push(proj)
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: [] }],
    })).rejects.toThrow(/embedding/i)
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [
        { chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a },
        { chunk_index: 1, chunk_text: "y", heading_path: "", embedding: [1, 0] },
      ],
    })).rejects.toThrow(/dimension/i)
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "bad/page", chunks: [],
    })).rejects.toThrow(/page_id/i) // pageId validated before the empty-chunks no-op
    await expect(vectorCommands.vector_delete_page({ projectPath: proj, pageId: "bad/slash" }))
      .rejects.toThrow(/page_id/i)
    await expect(vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: [NaN, 1] }))
      .rejects.toThrow(/embedding/i)
  })

  it("parity no-ops keep the desktop contract", async () => {
    expect(await vectorCommands.vector_optimize_chunks()).toBeNull()
    expect(await vectorCommands.vector_legacy_row_count()).toBe(0)
    expect(await vectorCommands.vector_drop_legacy()).toBeNull()
  })

  it("degrades gracefully when sqlite-vec is unavailable", async () => {
    const dbMod = await import("../src/store/db.js")
    const spy = vi.spyOn(dbMod, "isVecAvailable").mockReturnValue(false)
    try {
      const proj = makeProject("vec-degraded-project")
      cleanups.push(proj)
      // Writes no-op (no throw), reads return empty, count is 0.
      await expect(vectorCommands.vector_upsert_chunks({
        projectPath: proj, pageId: "P",
        chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a }],
      })).resolves.toBeUndefined()
      expect(await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a })).toEqual([])
      expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
      await expect(vectorCommands.vector_delete_page({ projectPath: proj, pageId: "P" })).resolves.toBeUndefined()
      await expect(vectorCommands.vector_clear_chunks({ projectPath: proj })).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  // ── review-fix regressions (PR #27) ────────────────────────────────────

  it("fractional topK does not throw (LIMIT binds must be integers)", async () => {
    const proj = makeProject("vec-frack-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "F",
      chunks: [{ chunk_index: 0, chunk_text: "frack", heading_path: "", embedding: V.a }],
    })
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a, topK: 2.5 })
    expect(hits.length).toBe(1)
  })

  it("delete_project removes rows under both the uuid key and the path key", async () => {
    const proj = makeProject("vec-dp-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "dp-uuid", heading_path: "", embedding: V.a }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    await vectorCommands.vector_delete_project({ projectPath: proj, projectUuid: "vec-dp-project" })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)

    // Path-keyed project (no project.json): rows were written under the path key.
    const bare = mkdtempSync(path.join(tmpdir(), "llmwiki-vec-bare-"))
    cleanups.push(bare)
    await vectorCommands.vector_upsert_chunks({
      projectPath: bare, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "dp-path", heading_path: "", embedding: V.b }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: bare })).toBe(1)
    await vectorCommands.vector_delete_project({ projectPath: bare })
    expect(await vectorCommands.vector_count_chunks({ projectPath: bare })).toBe(0)
  })

  it("projectKey self-heals when project.json appears later (stranded rows dropped)", async () => {
    const proj = mkdtempSync(path.join(tmpdir(), "llmwiki-vec-flip-"))
    cleanups.push(proj)
    mkdirSync(path.join(proj, ".llm-wiki"), { recursive: true })
    // No project.json yet → rows are keyed by the normalized path.
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "flip-before", heading_path: "", embedding: V.a }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    // The client's ensureProjectId writes project.json on first open → identity
    // flips to the uuid; stranded path-key rows must be dropped, not leaked.
    writeFileSync(path.join(proj, ".llm-wiki", "project.json"), JSON.stringify({ id: "vec-flip-uuid" }))
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "flip-after", heading_path: "", embedding: V.a }],
    })
    const db = getDb()
    const rows = db.prepare(`SELECT project_id, chunk_text FROM vec_chunks`).all()
      .filter((r) => r.chunk_text === "flip-before" || r.chunk_text === "flip-after")
    expect(rows).toEqual([{ project_id: "vec-flip-uuid", chunk_text: "flip-after" }])
  })

  it("vectorIndexHealth reports usable / empty / dim_mismatch", async () => {
    const proj = makeProject("vec-health-project")
    cleanups.push(proj)
    expect(vectorIndexHealth({ projectPath: proj, queryEmbedding: V.a })).toBe("empty")
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "H",
      chunks: [{ chunk_index: 0, chunk_text: "health", heading_path: "", embedding: V.a }],
    })
    expect(vectorIndexHealth({ projectPath: proj, queryEmbedding: V.a })).toBeNull()
    expect(vectorIndexHealth({ projectPath: proj, queryEmbedding: [0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0] }))
      .toBe("dim_mismatch")
  })
})

describe.skipIf(isVecAvailable())("vectorstore (no sqlite-vec binary)", () => {
  it("still exports the full command surface", () => {
    expect(Object.keys(vectorCommands)).toEqual(expect.arrayContaining([
      "vector_upsert_chunks", "vector_search_chunks", "vector_delete_page",
      "vector_count_chunks", "vector_clear_chunks",
    ]))
  })
})
