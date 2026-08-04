// Tests for the server embedding pipeline (issue #14 P0 stage 4):
// text-chunker parity pins + embedPage end-to-end against a mocked
// /embeddings endpoint writing into the real sqlite-vec table.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-embed-test-"))
process.env.LLM_WIKI_NO_SHARE = "1"

const { getDb } = await import("../src/store/db.js")
const { embedPage, extractEmbeddingTitle, getLastEmbeddingError, resetEmbeddingStateForTests } = await import("../src/ingest/embed.js")
const { chunkMarkdown, stripFrontmatter } = await import("../src/ingest/text-chunker.js")
const { vectorCommands } = await import("../src/commands/vectorstore.js")

getDb()

const PROJECT = "/tmp/embed-proj"
const VEC = [0.1, 0.2, 0.3, 0.4]

function embCfg(extra = {}) {
  return { enabled: true, endpoint: "http://emb.test/v1", apiKey: "", model: "emb-model", ...extra }
}

let fetchMock
beforeEach(() => {
  resetEmbeddingStateForTests()
  fetchMock = vi.fn(async (_url, opts) => {
    const body = JSON.parse(opts.body)
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    return { ok: true, status: 200, json: async () => ({ data: inputs.map(() => ({ embedding: VEC })) }), text: async () => "" }
  })
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await vectorCommands.vector_clear_chunks({ projectPath: PROJECT }).catch(() => {})
})
afterAll(() => rmSync(process.env.LLM_WIKI_DATA_DIR, { recursive: true, force: true }))

describe("text-chunker pins", () => {
  it("strips frontmatter and reports body offset", () => {
    const { body, bodyOffset } = stripFrontmatter("---\ntitle: X\n---\nHello")
    expect(body).toBe("Hello")
    expect(bodyOffset).toBe(17)
  })

  it("emits heading breadcrumbs per section", () => {
    const chunks = chunkMarkdown("# Top\nintro text\n\n## Sub\nbody text", { targetChars: 1000, maxChars: 1500, overlapChars: 0 })
    expect(chunks.length).toBe(2)
    expect(chunks[0].headingPath).toBe("# Top")
    expect(chunks[1].headingPath).toBe("# Top > ## Sub")
  })

  it("never splits inside a fenced code block (oversized instead)", () => {
    const code = "```js\n" + "x".repeat(300) + "\n```"
    const chunks = chunkMarkdown(code, { targetChars: 50, maxChars: 100, overlapChars: 0 })
    expect(chunks.length).toBe(1)
    expect(chunks[0].oversized).toBe(true)
    expect(chunks[0].text).toContain("x".repeat(300))
  })

  it("keeps tables intact", () => {
    const table = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n")
    const chunks = chunkMarkdown(table, { targetChars: 5, maxChars: 10, overlapChars: 0 })
    expect(chunks.length).toBe(1)
    expect(chunks[0].text).toBe(table)
  })

  it("returns [] for empty / frontmatter-only content", () => {
    expect(chunkMarkdown("")).toEqual([])
    expect(chunkMarkdown("---\ntitle: X\n---\n   \n")).toEqual([])
  })
})

describe("extractEmbeddingTitle", () => {
  it("uses frontmatter title, falls back to page id", () => {
    expect(extractEmbeddingTitle("---\ntitle: My Page\n---\nbody", "slug")).toBe("My Page")
    expect(extractEmbeddingTitle("no frontmatter", "slug")).toBe("slug")
    expect(extractEmbeddingTitle("---\ntitle:   \n---\nbody", "slug")).toBe("slug")
  })
})

describe("embedPage", () => {
  it("chunks, embeds, and writes rows into vec_chunks", async () => {
    const content = "## One\nfirst section body.\n\n## Two\nsecond section body."
    const ok = await embedPage(PROJECT, "page-a", "Page A", content, embCfg({ maxChunkChars: 20 }))
    expect(ok).toBe(true)
    const count = await vectorCommands.vector_count_chunks({ projectPath: PROJECT })
    expect(count).toBeGreaterThan(1)
    // each embedded request carried the enriched text (title breadcrumb)
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(String(firstBody.input)).toContain("Page A")
  })

  it("re-embedding a page replaces its rows (no dupes)", async () => {
    const cfg = embCfg({ maxChunkChars: 20 })
    await embedPage(PROJECT, "page-b", "B", "## A\none two three four five", cfg)
    const before = await vectorCommands.vector_count_chunks({ projectPath: PROJECT })
    await embedPage(PROJECT, "page-b", "B", "## A\nsingle", cfg)
    const after = await vectorCommands.vector_count_chunks({ projectPath: PROJECT })
    expect(after).toBeLessThanOrEqual(before)
    expect(after).toBeGreaterThan(0)
  })

  it("batches multi-chunk pages and falls back per-item for singletons", async () => {
    const content = "## A\nalpha body text.\n\n## B\nbeta body text.\n\n## C\ngamma body text."
    await embedPage(PROJECT, "page-c", "C", content, embCfg({ maxChunkChars: 15, batchSize: 2 }))
    // batch of 2 + singleton → exactly two HTTP calls
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(Array.isArray(first.input) && first.input.length).toBe(2)
  })

  it("returns false and records the error when the provider fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" })
    const ok = await embedPage(PROJECT, "page-d", "D", "some content here", embCfg())
    expect(ok).toBe(false)
    expect(getLastEmbeddingError()).toMatch(/500/)
    expect(await vectorCommands.vector_count_chunks({ projectPath: PROJECT })).toBe(0)
  })

  it("returns false when embeddings are disabled or unconfigured", async () => {
    expect(await embedPage(PROJECT, "p", "p", "text", { ...embCfg(), enabled: false })).toBe(false)
    expect(await embedPage(PROJECT, "p", "p", "text", { ...embCfg(), model: "" })).toBe(false)
    expect(await embedPage(PROJECT, "p", "p", "text", null)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
