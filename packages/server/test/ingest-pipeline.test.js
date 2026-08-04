/**
 * Mocked-LLM end-to-end tests for packages/server/src/ingest/pipeline.js
 * (runIngestPipeline — the server port of autoIngestImpl, issue #14 P0).
 *
 * streamChat is scripted (analysis → generation with 2 FILE blocks + 1 REVIEW
 * block → empty review-stage output); embedPage is mocked; everything else
 * (parse, write, cache, reviews, index/log upkeep) runs against real temp
 * project dirs.
 *
 * Covers:
 *   - files on disk: pages + deterministic wiki/index.md + wiki/log.md
 *   - cache entry written; second run hits the cache (cached:true) with
 *     ZERO LLM calls and no analysis/generation stages
 *   - reviews folded with on-disk .llm-wiki/review.json + persisted
 *   - stage sequence seen by onProgress is a subsequence of INGEST_STAGES
 *   - byte-identical analysis/generation messages + overrides (reasoning
 *     knob dropped, temperature/max_tokens kept)
 *   - folderContext lands in the analysis user message
 *   - zero-output safety net throws "Ingest produced no output files"
 *   - abort mid-stream throws "Ingest cancelled"
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-pipeline-test-"))
process.env.LLM_WIKI_NO_SHARE = "1"

vi.mock("../src/ingest/llm.js", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, streamChat: vi.fn() }
})

vi.mock("../src/ingest/embed.js", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, embedPage: vi.fn(async () => true) }
})

import { streamChat } from "../src/ingest/llm.js"
import { embedPage } from "../src/ingest/embed.js"

const { runIngestPipeline } = await import("../src/ingest/pipeline.js")
const { INGEST_STAGES } = await import("../src/ingest/progress.js")
const { checkIngestCache } = await import("../src/ingest/cache.js")
const { reviewIdFor } = await import("../src/ingest/reviews.js")
const {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildReviewSuggestionPrompt,
  computeIngestGenerationMaxTokens,
  computeIngestReviewMaxTokens,
  languageRule,
} = await import("../src/ingest/prompts.js")
const { sourceIdentityForPath, sourceSummarySlugFromIdentity } = await import("../src/ingest/identity.js")

const streamChatMock = vi.mocked(streamChat)
const embedPageMock = vi.mocked(embedPage)

const LLM_CONFIG = {
  provider: "openai",
  apiKey: "k",
  model: "m",
  maxContextSize: 200_000,
  requestTimeoutMinutes: 30,
}

const SOURCE_CONTENT = [
  "# Rope physics",
  "",
  "Ropes are load-bearing structures made of twisted fibers.",
  "Their tensile strength depends on material and lay direction.",
].join("\n")

const ANALYSIS = [
  "## Key Entities",
  "- rope (object, central)",
  "",
  "## Main Arguments & Findings",
  "- Ropes bear loads; strength depends on material and lay.",
].join("\n")

function generationFor(sourceSummaryPath) {
  return [
    `---FILE: ${sourceSummaryPath}---`,
    "---",
    "type: source",
    'title: "Source: note.md"',
    'sources: ["note.md"]',
    "tags: []",
    "related: []",
    "---",
    "",
    "# Source: note.md",
    "",
    "Rope physics summary.",
    "---END FILE---",
    "---FILE: wiki/concepts/load-bearing.md---",
    "---",
    "type: concept",
    'title: "Load Bearing"',
    'sources: ["note.md"]',
    "tags: []",
    "related: []",
    "---",
    "",
    "# Load Bearing",
    "",
    "Load bearing is the capacity of a structure to carry weight.",
    "---END FILE---",
    "---REVIEW: suggestion | Check topic coverage---",
    "Follow up on load-bearing research.",
    "---END REVIEW---",
  ].join("\n")
}

function scriptResponses(...responses) {
  let i = 0
  streamChatMock.mockImplementation(async () => {
    if (i >= responses.length) throw new Error(`unexpected streamChat call #${i + 1}`)
    return responses[i++]
  })
}

async function makeProject() {
  const pp = await mkdtemp(path.join(tmpdir(), "llmwiki-pipeline-"))
  await mkdir(path.join(pp, "raw", "sources"), { recursive: true })
  await writeFile(path.join(pp, "raw", "sources", "note.md"), SOURCE_CONTENT, "utf8")
  return pp
}

function makeTask(overrides = {}) {
  return {
    id: 1,
    project_id: 1,
    file_path: "raw/sources/note.md",
    folder_context: "",
    attempt_count: 1,
    ...overrides,
  }
}

function makeEnv(pp, overrides = {}) {
  return {
    projectPath: pp,
    llmConfig: LLM_CONFIG,
    mineruConfig: { enabled: false },
    multimodalConfig: { enabled: false },
    embeddingConfig: { enabled: true, model: "text-embedding-test", endpoint: "http://embed", apiKey: "" },
    outputLanguage: "English",
    signal: undefined,
    onProgress: vi.fn(),
    ...overrides,
  }
}

function stagesSeen(onProgressMock) {
  return onProgressMock.mock.calls.map(([stage]) => stage)
}

function assertStageSubsequence(stages) {
  const order = INGEST_STAGES.map(([name]) => name)
  let lastIndex = -1
  for (const stage of stages) {
    const idx = order.indexOf(stage)
    expect(idx, `unknown stage "${stage}"`).toBeGreaterThanOrEqual(0)
    expect(idx, `out-of-order stage "${stage}" in [${stages.join(",")}]`).toBeGreaterThanOrEqual(lastIndex)
    lastIndex = idx
  }
}

let pp
beforeEach(async () => {
  streamChatMock.mockReset()
  embedPageMock.mockClear()
  pp = await makeProject()
})

afterEach(async () => {
  await rm(pp, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(process.env.LLM_WIKI_DATA_DIR, { recursive: true, force: true })
})

// ── full mocked-LLM end-to-end ──────────────────────────────────────────

describe("runIngestPipeline end-to-end (mocked LLM)", () => {
  async function runFull(envOverrides = {}, taskOverrides = {}) {
    const env = makeEnv(pp, envOverrides)
    const sourceSummaryPath = `wiki/sources/${sourceSummarySlugFromIdentity(sourceIdentityForPath(pp, `${pp}/raw/sources/note.md`))}.md`
    scriptResponses(ANALYSIS, generationFor(sourceSummaryPath), "")
    const result = await runIngestPipeline(makeTask(taskOverrides), env)
    return { env, result, sourceSummaryPath }
  }

  it("writes pages + deterministic index + deterministic log and returns the run summary", async () => {
    const { result, sourceSummaryPath } = await runFull()

    expect(result.cached).toBe(false)
    expect(result.reviewCount).toBe(1)
    expect(result.warnings).toEqual([])
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.writtenPaths).toEqual([
      sourceSummaryPath,
      "wiki/concepts/load-bearing.md",
      "wiki/index.md",
      "wiki/log.md",
    ])

    // Pages on disk.
    const summary = await readFile(path.join(pp, sourceSummaryPath), "utf8")
    expect(summary).toContain("# Source: note.md")
    expect(summary).toContain("Rope physics summary.")
    const concept = await readFile(path.join(pp, "wiki/concepts/load-bearing.md"), "utf8")
    expect(concept).toContain("# Load Bearing")

    // Deterministic index gained the new pages.
    const index = await readFile(path.join(pp, "wiki/index.md"), "utf8")
    expect(index).toContain("[[sources/note]]")
    expect(index).toContain("[[concepts/load-bearing]]")

    // Deterministic log entry (model omitted the log FILE block).
    const log = await readFile(path.join(pp, "wiki/log.md"), "utf8")
    expect(log).toContain("ingest | note.md")

    // Embeddings: pageId index/log skipped; title from frontmatter.
    const embeddedPageIds = embedPageMock.mock.calls.map((call) => call[1])
    expect(embeddedPageIds).toEqual(["note", "load-bearing"])
    expect(embedPageMock.mock.calls[1][2]).toBe("Load Bearing")
  })

  it("sends byte-identical analysis/generation messages with server overrides", async () => {
    const { sourceSummaryPath } = await runFull()

    const directive = languageRule("English", SOURCE_CONTENT)

    // Call 1 — analysis.
    const [cfg1, messages1, opts1] = streamChatMock.mock.calls[0]
    expect(cfg1).toBe(LLM_CONFIG)
    expect(messages1[0]).toEqual({
      role: "system",
      content: buildAnalysisPrompt(directive, "", "", ""),
    })
    expect(messages1[1]).toEqual({
      role: "user",
      content: `Analyze this source document:\n\n**File:** note.md\n\n---\n\n${SOURCE_CONTENT}`,
    })
    expect(opts1.overrides).toEqual({ temperature: 0.1, max_tokens: 4096 })
    expect(opts1.overrides).not.toHaveProperty("reasoning")

    // Call 2 — generation.
    const [, messages2, opts2] = streamChatMock.mock.calls[1]
    expect(messages2[0]).toEqual({
      role: "system",
      content: buildGenerationPrompt(directive, "", "", "", "note.md", "", sourceSummaryPath),
    })
    expect(messages2[1].content).toContain(`Source document to process: **note.md**`)
    expect(messages2[1].content).toContain("## Stage 1 Analysis (context only — do not repeat)")
    expect(messages2[1].content).toContain(ANALYSIS)
    expect(messages2[1].content).toContain(`Now emit the FILE blocks for the wiki files derived from **note.md**.`)
    expect(opts2.overrides).toEqual({
      temperature: 0.1,
      max_tokens: computeIngestGenerationMaxTokens(LLM_CONFIG.maxContextSize),
    })

    // Call 3 — dedicated review stage (generation carries a REVIEW block).
    const [, messages3, opts3] = streamChatMock.mock.calls[2]
    expect(messages3[0]).toEqual({
      role: "system",
      content: buildReviewSuggestionPrompt(directive, "", "", "note.md", ANALYSIS, SOURCE_CONTENT, generationFor(sourceSummaryPath), LLM_CONFIG.maxContextSize),
    })
    expect(messages3[1]).toEqual({
      role: "user",
      content: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none.",
    })
    expect(opts3.overrides).toEqual({
      temperature: 0.1,
      max_tokens: computeIngestReviewMaxTokens(LLM_CONFIG.maxContextSize),
    })

    expect(streamChatMock).toHaveBeenCalledTimes(3)
  })

  it("includes folderContext in the analysis user message when set", async () => {
    const env = makeEnv(pp)
    const sourceSummaryPath = `wiki/sources/${sourceSummarySlugFromIdentity(sourceIdentityForPath(pp, `${pp}/raw/sources/note.md`))}.md`
    scriptResponses(ANALYSIS, generationFor(sourceSummaryPath), "")
    await runIngestPipeline(makeTask({ folder_context: "papers/energy" }), env)

    expect(streamChatMock.mock.calls[0][1][1].content).toBe(
      `Analyze this source document:\n\n**File:** note.md\n**Folder context:** papers/energy\n\n---\n\n${SOURCE_CONTENT}`,
    )
  })

  it("reports stages as a subsequence of INGEST_STAGES", async () => {
    const { env } = await runFull()
    const stages = stagesSeen(env.onProgress)
    assertStageSubsequence(stages)

    // Every executed stage of the full pipeline shows up.
    for (const stage of ["preprocess", "context", "cache-check", "images", "caption", "analysis", "generation", "review-stage", "write", "index-log", "reviews", "cache-save", "embed"]) {
      expect(stages, `missing stage "${stage}"`).toContain(stage)
    }
    // Client detail strings survive as the stage details.
    const details = env.onProgress.mock.calls.map(([, detail]) => detail)
    expect(details).toContain("Reading source...")
    expect(details).toContain("Step 1/2: Analyzing source...")
    expect(details).toContain("Step 2/2: Generating wiki pages...")
    expect(details).toContain("Writing files...")
    expect(details).toContain("Extracting embedded images...")
  })

  it("persists the ingest cache entry keyed by source identity", async () => {
    const { result } = await runFull()
    const cacheRaw = await readFile(path.join(pp, ".llm-wiki", "ingest-cache.json"), "utf8")
    const cache = JSON.parse(cacheRaw)
    expect(cache.entries["note.md"]).toBeTruthy()
    expect(cache.entries["note.md"].filesWritten).toEqual(result.writtenPaths)

    // And checkIngestCache itself reports a hit for the same content.
    const hit = await checkIngestCache(pp, "note.md", SOURCE_CONTENT)
    expect(hit).toEqual(result.writtenPaths)
  })

  it("persists parsed review items to .llm-wiki/review.json", async () => {
    await runFull()
    const raw = await readFile(path.join(pp, ".llm-wiki", "review.json"), "utf8")
    const items = JSON.parse(raw)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: "suggestion",
      title: "Check topic coverage",
      description: "Follow up on load-bearing research.",
      sourcePath: path.join(pp, "raw/sources/note.md").split(path.sep).join("/"),
      resolved: false,
    })
    expect(items[0].id).toMatch(/^review-[0-9a-f]{8}$/)
  })

  it("folds incoming reviews with existing on-disk items (resolved wins)", async () => {
    const seedId = reviewIdFor({ type: "suggestion", title: "Check topic coverage" })
    await mkdir(path.join(pp, ".llm-wiki"), { recursive: true })
    await writeFile(
      path.join(pp, ".llm-wiki", "review.json"),
      JSON.stringify([{
        id: seedId,
        type: "suggestion",
        title: "Check topic coverage",
        description: "old description",
        sourcePath: "raw/sources/note.md",
        resolved: true,
        resolvedAction: "Skip",
        createdAt: 123,
        options: [{ label: "Approve", action: "Approve" }, { label: "Skip", action: "Skip" }],
      }], null, 2),
      "utf8",
    )

    const { result } = await runFull()
    expect(result.reviewCount).toBe(1)

    const items = JSON.parse(await readFile(path.join(pp, ".llm-wiki", "review.json"), "utf8"))
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(seedId)
    expect(items[0].resolved).toBe(true)              // resolved state preserved
    expect(items[0].resolvedAction).toBe("Skip")
    expect(items[0].description).toBe("Follow up on load-bearing research.")
    expect(items[0].sourcePath).toBe(path.join(pp, "raw/sources/note.md").split(path.sep).join("/"))
  })

  it("cache-hit branch returns cached:true without any LLM call", async () => {
    const { result: first } = await runFull()

    streamChatMock.mockReset()
    streamChatMock.mockRejectedValue(new Error("LLM must not be called on a cache hit"))
    const env2 = makeEnv(pp)
    const result2 = await runIngestPipeline(makeTask(), env2)

    expect(result2.cached).toBe(true)
    expect(result2.writtenPaths).toEqual(first.writtenPaths)
    expect(result2.reviewCount).toBe(0)
    expect(result2.warnings).toEqual([])
    expect(streamChatMock).not.toHaveBeenCalled()

    // No LLM stages were reported on the cache-hit path.
    const stages = stagesSeen(env2.onProgress)
    assertStageSubsequence(stages)
    for (const stage of ["analysis", "generation", "review-stage", "write"]) {
      expect(stages).not.toContain(stage)
    }
    // The client's cache-hit terminal detail survives.
    const details = env2.onProgress.mock.calls.map(([, detail]) => detail)
    expect(details).toContain(`Skipped (unchanged) — ${first.writtenPaths.length} files from previous ingest`)
  })
})

// ── failure-mode behavior ───────────────────────────────────────────────

describe("runIngestPipeline failure modes", () => {
  it("throws the exact zero-output safety-net message when nothing can be written", async () => {
    // Block every wiki write by squatting the wiki path with a regular file:
    // generation emits no FILE blocks, the deterministic log write fails,
    // the fallback source-summary write fails → writtenPaths stays empty.
    await writeFile(path.join(pp, "wiki"), "", "utf8")

    const env = makeEnv(pp)
    scriptResponses(ANALYSIS, "No FILE blocks here — model refused.")

    await expect(runIngestPipeline(makeTask(), env)).rejects.toThrow("Ingest produced no output files")

    // The warning log still captured the deterministic-log failure.
    const warningLog = await readFile(path.join(pp, ".llm-wiki", "ingest-warnings.log"), "utf8")
    expect(warningLog).toContain("Deterministic log update failed:")

    // No cache entry was saved for a zero-output run.
    await expect(readFile(path.join(pp, ".llm-wiki", "ingest-cache.json"), "utf8")).rejects.toThrow()
  })

  it("throws 'Ingest cancelled' when the signal aborts mid analysis stream", async () => {
    const controller = new AbortController()
    streamChatMock.mockImplementation(async () => {
      controller.abort()
      throw new Error("stream aborted")
    })

    const env = makeEnv(pp, { signal: controller.signal })
    await expect(runIngestPipeline(makeTask(), env)).rejects.toThrow("Ingest cancelled")
    expect(streamChatMock).toHaveBeenCalledTimes(1) // generation never ran
  })
})
