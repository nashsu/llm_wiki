/**
 * Server-port tests for packages/server/src/ingest/long-source.js
 * (issue #14 P0 server-driven ingest).
 *
 * streamChat is mocked (real IngestLlmError class kept via importOriginal
 * so instanceof pass-through is exercised against the genuine class);
 * checkpoints are verified against real temp dirs.
 *
 * Covers:
 *   - extractMarkedSection regex behavior
 *   - single-chunk short-circuit ({chunked:false})
 *   - chunk loop: one streamChat per chunk, onProgress details,
 *     server overrides ({temperature: 0.1, max_tokens: 4096}, no reasoning)
 *   - digest / section extraction + consolidated output shape
 *   - checkpoint save after every chunk (params, completedThrough, analyses)
 *   - checkpoint resume (no further LLM calls, resume detail)
 *   - IngestLlmError pass-through vs generic "Chunk analysis stream failed"
 *   - abort semantics ("Ingest cancelled" before any LLM call)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

vi.mock("../src/ingest/llm.js", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, streamChat: vi.fn() }
})

import { streamChat, IngestLlmError } from "../src/ingest/llm.js"
import { analyzeLongSourceInChunks, extractMarkedSection } from "../src/ingest/long-source.js"
import { splitSourceIntoSemanticChunks, hashTextHex } from "../src/ingest/chunking.js"
import {
  buildChunkAnalysisSystemPrompt,
  buildChunkAnalysisUserPrompt,
  trimLongText,
  LONG_SOURCE_CHUNK_MIN,
  LONG_SOURCE_CHUNK_MAX,
  LONG_SOURCE_DIGEST_MAX,
} from "../src/ingest/prompts.js"

const streamChatMock = vi.mocked(streamChat)

const LLM_CONFIG = { provider: "openai", apiKey: "k", model: "m" }

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/** Budget that yields targetChars = 13_750 (> LONG_SOURCE_CHUNK_MIN). */
const SOURCE_BUDGET = 25_000
const TARGET_CHARS = clampNumber(Math.floor(SOURCE_BUDGET * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX)
const OVERLAP_CHARS = clampNumber(Math.floor(TARGET_CHARS * 0.08), 800, 3_000)

/** Build a long source with N numbered sections, each ~13k chars. */
function buildLongContent(sections) {
  const parts = []
  for (let i = 1; i <= sections; i++) {
    parts.push(`## Section ${i}`)
    parts.push(`Paragraph ${i}. `.repeat(900).trim()) // ~13_5xx chars
    parts.push("")
  }
  return parts.join("\n")
}

function expectedChunkCount(content) {
  return splitSourceIntoSemanticChunks(content, TARGET_CHARS, OVERLAP_CHARS).length
}

function twoSectionResponse(n) {
  return `## Chunk Analysis\nAnalysis body ${n}\n\n## Updated Global Digest\nDigest body ${n}`
}

let projectPath
beforeEach(async () => {
  streamChatMock.mockReset()
  projectPath = await mkdtemp(path.join(tmpdir(), "llmwiki-long-source-"))
})

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true })
})

async function runAnalysis(content, overrides = {}) {
  return analyzeLongSourceInChunks(
    projectPath,
    LLM_CONFIG,
    "a wiki about testing",
    "entity, concept",
    "# Index",
    "papers/long.pdf",
    "long-slug",
    "papers",
    content,
    SOURCE_BUDGET,
    overrides.signal,
    overrides.onProgress,
  )
}

// ── extractMarkedSection ─────────────────────────────────────────

describe("extractMarkedSection", () => {
  it("extracts the body of a marked ## section", () => {
    const raw = "intro\n## Chunk Analysis\nbody line one\nbody line two\n## Updated Global Digest\ndigest"
    expect(extractMarkedSection(raw, "Chunk Analysis")).toBe("body line one\nbody line two")
    expect(extractMarkedSection(raw, "Updated Global Digest")).toBe("digest")
  })

  it("matches case-insensitively and at the start of the string", () => {
    expect(extractMarkedSection("## chunk analysis\nbody", "Chunk Analysis")).toBe("body")
  })

  it("returns empty string when the section is missing", () => {
    expect(extractMarkedSection("## Other\nbody", "Chunk Analysis")).toBe("")
    expect(extractMarkedSection("", "Chunk Analysis")).toBe("")
  })

  it("escapes regex metacharacters in the heading", () => {
    expect(extractMarkedSection("## What? (stuff)\nx", "What? (stuff)")).toBe("x")
  })
})

// ── analyzeLongSourceInChunks ────────────────────────────────────

describe("analyzeLongSourceInChunks", () => {
  it("short-circuits with {chunked:false} when the source fits one chunk", async () => {
    const content = "# Small Source\n\nA short paragraph."
    const result = await runAnalysis(content)
    expect(result).toEqual({ chunked: false, analysis: "", sourceContext: content })
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("runs one streamChat per chunk with server-form options", async () => {
    const content = buildLongContent(3)
    const chunks = expectedChunkCount(content)
    expect(chunks).toBeGreaterThanOrEqual(2)

    streamChatMock.mockImplementation(async () => twoSectionResponse(1))
    const details = []
    const result = await runAnalysis(content, { onProgress: ({ detail }) => details.push(detail) })

    expect(result.chunked).toBe(true)
    expect(streamChatMock).toHaveBeenCalledTimes(chunks)
    expect(details).toEqual(
      Array.from({ length: chunks }, (_, i) => `Analyzing long source chunk ${i + 1}/${chunks}...`),
    )

    // Server-form call shape: messages + { signal, overrides } — the
    // reasoning knob is gone, temperature/max_tokens kept exactly.
    const [config, messages, opts] = streamChatMock.mock.calls[0]
    expect(config).toBe(LLM_CONFIG)
    expect(messages[0].role).toBe("system")
    expect(messages[1].role).toBe("user")
    expect(opts.overrides).toEqual({ temperature: 0.1, max_tokens: 4096 })
    expect(opts.signal).toBeUndefined()
    expect(typeof opts.onToken).not.toBe("function")
  })

  it("builds prompts byte-identically to the client helpers", async () => {
    const content = buildLongContent(2)
    const chunks = splitSourceIntoSemanticChunks(content, TARGET_CHARS, OVERLAP_CHARS)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    streamChatMock.mockImplementation(async () => twoSectionResponse(1))
    await runAnalysis(content)

    const systemPrompt = buildChunkAnalysisSystemPrompt(
      "a wiki about testing", "entity, concept", "# Index", content,
    )
    const firstUserPrompt = buildChunkAnalysisUserPrompt(
      "papers/long.pdf", "papers", chunks[0], trimLongText("", LONG_SOURCE_DIGEST_MAX),
    )
    expect(streamChatMock.mock.calls[0][1]).toEqual([
      { role: "system", content: systemPrompt },
      { role: "user", content: firstUserPrompt },
    ])

    if (chunks.length > 1) {
      // Chunk 2 sees chunk 1's digest in its user prompt.
      const secondUserPrompt = buildChunkAnalysisUserPrompt(
        "papers/long.pdf", "papers", chunks[1], trimLongText("Digest body 1", LONG_SOURCE_DIGEST_MAX),
      )
      expect(streamChatMock.mock.calls[1][1][1].content).toBe(secondUserPrompt)
    }
  })

  it("extracts digest + per-chunk analyses into the consolidated output", async () => {
    const content = buildLongContent(3)
    const chunks = expectedChunkCount(content)
    let call = 0
    streamChatMock.mockImplementation(async () => {
      call += 1
      return twoSectionResponse(call)
    })

    const result = await runAnalysis(content)

    expect(result.analysis).toContain("# Consolidated Long-Document Analysis")
    expect(result.analysis).toContain(`Digest body ${chunks}`) // final digest
    expect(result.analysis).toContain("## Per-Chunk Analyses")
    for (let i = 1; i <= chunks; i++) {
      expect(result.analysis).toContain(`## Chunk ${i}/${chunks}`)
      expect(result.analysis).toContain(`Analysis body ${i}`)
    }

    expect(result.sourceContext).toContain("# Long Source Context: papers/long.pdf")
    expect(result.sourceContext).toContain(`analyzed in ${chunks} semantic chunks`)
    expect(result.sourceContext).toContain(`Digest body ${chunks}`)
    expect(result.checkpointPath).toContain(".llm-wiki/ingest-progress/long-slug-")
  })

  it("saves a checkpoint after every chunk", async () => {
    const content = buildLongContent(3)
    const chunks = expectedChunkCount(content)
    let call = 0
    streamChatMock.mockImplementation(async () => {
      call += 1
      return twoSectionResponse(call)
    })

    const result = await runAnalysis(content)

    const saved = JSON.parse(await readFile(result.checkpointPath, "utf8"))
    expect(saved.version).toBe(1)
    expect(saved.sourceIdentity).toBe("papers/long.pdf")
    expect(saved.sourceHash).toBe(hashTextHex(content))
    expect(saved.sourceLength).toBe(content.length)
    expect(saved.sourceBudget).toBe(SOURCE_BUDGET)
    expect(saved.targetChars).toBe(TARGET_CHARS)
    expect(saved.overlapChars).toBe(OVERLAP_CHARS)
    expect(saved.chunkTotal).toBe(chunks)
    expect(saved.completedThrough).toBe(chunks)
    expect(saved.analyses).toHaveLength(chunks)
    expect(saved.globalDigest).toBe(`Digest body ${chunks}`)
    expect(typeof saved.updatedAt).toBe("number")
  })

  it("resumes from a compatible checkpoint without further LLM calls", async () => {
    const content = buildLongContent(3)
    const chunks = expectedChunkCount(content)
    let call = 0
    streamChatMock.mockImplementation(async () => {
      call += 1
      return twoSectionResponse(call)
    })
    await runAnalysis(content)
    expect(streamChatMock).toHaveBeenCalledTimes(chunks)

    streamChatMock.mockReset()
    streamChatMock.mockRejectedValue(new Error("must not be called on resume"))
    const details = []
    const resumed = await runAnalysis(content, { onProgress: ({ detail }) => details.push(detail) })

    expect(streamChatMock).not.toHaveBeenCalled()
    expect(resumed.chunked).toBe(true)
    expect(details).toEqual([
      `Resuming long source analysis from chunk ${chunks + 1}/${chunks}...`,
    ])
    expect(resumed.analysis).toContain(`Digest body ${chunks}`)
    for (let i = 1; i <= chunks; i++) {
      expect(resumed.analysis).toContain(`## Chunk ${i}/${chunks}`)
    }
  })

  it("lets IngestLlmError propagate untouched (usage-limit backoff)", async () => {
    const content = buildLongContent(2)
    const llmErr = new IngestLlmError("429 rate limit exceeded", { usageLimit: true })
    streamChatMock.mockRejectedValue(llmErr)

    await expect(runAnalysis(content)).rejects.toBe(llmErr)
    await expect(runAnalysis(content)).rejects.toMatchObject({ usageLimit: true })
  })

  it("wraps non-IngestLlmError stream failures", async () => {
    const content = buildLongContent(2)
    streamChatMock.mockRejectedValue(new Error("network down"))
    await expect(runAnalysis(content)).rejects.toThrow("Chunk analysis stream failed")
  })

  it("throws the abort error before any LLM call when pre-aborted", async () => {
    const content = buildLongContent(2)
    const controller = new AbortController()
    controller.abort()
    streamChatMock.mockImplementation(async () => twoSectionResponse(1))

    await expect(runAnalysis(content, { signal: controller.signal }))
      .rejects.toThrow("Ingest cancelled")
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("falls back to the raw response when no marked sections are present", async () => {
    const content = buildLongContent(2)
    streamChatMock.mockResolvedValue("plain analysis text without sections")

    const result = await runAnalysis(content)
    expect(result.analysis).toContain("plain analysis text without sections")
    // The raw text doubles as the digest fallback, so the final digest
    // section is populated rather than "(No digest produced.)".
    expect(result.analysis).not.toContain("(No digest produced.)")
  })

  it("renders the no-digest placeholder when chunks produce nothing", async () => {
    const content = buildLongContent(2)
    streamChatMock.mockResolvedValue("")

    const result = await runAnalysis(content)
    expect(result.analysis).toContain("(No digest produced.)")
    expect(result.sourceContext).toContain("(No digest produced.)")
  })
})
