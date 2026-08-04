// Tests for the server-side semantic chunking + long-source checkpoint module
// (issue #14 server-driven ingest). Pins:
//  - hashTextHex stability (64-bit FNV-1a over UTF-16 code units, bit-exact —
//    checkpoint file names depend on it),
//  - chunk shape (id/index/total/headingPath/overlapBefore),
//  - the client's target/overlap clamp boundaries
//    (target = clamp(floor(budget*0.55), 12_000, 60_000),
//     overlap = clamp(floor(target*0.08), 800, 3_000)),
//  - oversized-block splitting at sentence punctuation,
//  - LongSourceCheckpoint v1 round-trip + incompatibility on ANY param change.
//
// Behavioral assertions for splitSourceIntoSemanticChunks are ported from
// src/lib/ingest.prompt.test.ts ("splits long sources on heading and paragraph
// boundaries with overlap"). Pure logic — no DB, no env setup needed.

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  splitSourceIntoSemanticChunks,
  hashTextHex,
  longSourceCheckpointPath,
  isCompatibleLongSourceCheckpoint,
  loadLongSourceCheckpoint,
  saveLongSourceCheckpoint,
  clearLongSourceCheckpoint,
} from "../src/ingest/chunking.js"

const cleanups = []
function makeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), "llmwiki-chunk-test-"))
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop(), { recursive: true, force: true })
})

describe("hashTextHex — 64-bit FNV-1a over UTF-16 code units", () => {
  it("matches published FNV-1a 64-bit vectors for ASCII input", () => {
    // For ASCII, UTF-16 code units equal bytes, so the published FNV test
    // vectors apply unchanged. cbf29ce484222325 is the FNV offset basis.
    expect(hashTextHex("")).toBe("cbf29ce484222325")
    expect(hashTextHex("a")).toBe("af63dc4c8601ec8c")
    expect(hashTextHex("foobar")).toBe("85944171f73967e8")
  })

  it("is deterministic and snapshots stable values for regression", () => {
    expect(hashTextHex("hello world")).toBe("779a65e7023cd2e7")
    expect(hashTextHex("abc")).toBe("e71fa2190541574b")
    expect(hashTextHex("hello world")).toBe(hashTextHex("hello world"))
    expect(hashTextHex("abc")).toBe(hashTextHex("abc"))
  })

  it("always emits zero-padded lowercase 16-char hex", () => {
    for (const text of ["", "a", "𐍈", "x".repeat(1000), "llm-wiki checkpoint"]) {
      expect(hashTextHex(text)).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it("hashes non-BMP characters as TWO UTF-16 code units (surrogate pair)", () => {
    // U+10348 (𐍈) is encoded as the surrogate pair D800 DF48. Independent
    // reference: FNV-1a over the explicit code-unit array, not over string
    // iteration — proves the port iterates code units, not code points.
    const fnvOverUnits = (units) => {
      let h = 0xcbf29ce484222325n
      const prime = 0x100000001b3n
      for (const unit of units) {
        h ^= BigInt(unit)
        h = BigInt.asUintN(64, h * prime)
      }
      return h.toString(16).padStart(16, "0")
    }
    expect(hashTextHex("𐍈")).toBe(fnvOverUnits([0xd800, 0xdf48]))
    expect(hashTextHex("𐍈")).toBe("e5e3400a23f42095")
    expect(hashTextHex(String.fromCharCode(0xd800, 0xdf48))).toBe(hashTextHex("𐍈"))
    // Adjacent code point (different low surrogate) must hash differently.
    expect(hashTextHex("𐍈")).not.toBe(hashTextHex("𐍉"))
  })
})

describe("splitSourceIntoSemanticChunks — chunk shape", () => {
  // Ported from src/lib/ingest.prompt.test.ts: "splits long sources on
  // heading and paragraph boundaries with overlap".
  const content = [
    "# Chapter One",
    "",
    "A".repeat(1200),
    "",
    "B".repeat(1200),
    "",
    "## Section Two",
    "",
    "C".repeat(1200),
    "",
    "D".repeat(1200),
  ].join("\n")

  it("splits long sources on heading and paragraph boundaries with overlap", () => {
    const chunks = splitSourceIntoSemanticChunks(content, 1800, 200)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].headingPath).toBe("Chapter One")
    expect(chunks.some((chunk) => chunk.headingPath.includes("Section Two"))).toBe(true)
    expect(chunks[1].overlapBefore.length).toBeGreaterThan(0)
    expect(chunks[1].main.startsWith(chunks[0].main.slice(-200))).toBe(false)
  })

  it("assigns id/index/total and full chunk shape to every chunk", () => {
    const chunks = splitSourceIntoSemanticChunks(content, 1800, 200)
    expect(chunks.length).toBe(4)
    for (let i = 0; i < chunks.length; i++) {
      expect(Object.keys(chunks[i]).sort()).toEqual(
        ["headingPath", "id", "index", "main", "overlapBefore", "total"].sort(),
      )
      expect(chunks[i].id).toBe(`chunk-${i + 1}`)
      expect(chunks[i].index).toBe(i + 1)
      expect(chunks[i].total).toBe(chunks.length)
      expect(typeof chunks[i].headingPath).toBe("string")
      expect(typeof chunks[i].main).toBe("string")
      expect(chunks[i].main.length).toBeGreaterThan(0)
    }
    expect(chunks[0].overlapBefore).toBe("")
    // No-break overlap falls back to the raw trimmed tail.
    expect(chunks[1].overlapBefore).toBe("A".repeat(200))
  })

  it("returns [] for empty content", () => {
    expect(splitSourceIntoSemanticChunks("", 1800, 200)).toEqual([])
    expect(splitSourceIntoSemanticChunks("   \n\n  ", 1800, 200)).toEqual([])
  })

  it("clamps the effective target to a 1_000 char floor (target=1 behaves as target=1000)", () => {
    const small = ["x".repeat(1100), "", "y".repeat(1100), "", "z".repeat(1100)].join("\n")
    expect(splitSourceIntoSemanticChunks(small, 1, 10))
      .toEqual(splitSourceIntoSemanticChunks(small, 1000, 10))
    expect(splitSourceIntoSemanticChunks(small, 1, 10).length).toBe(3)
  })
})

describe("chunk target/overlap clamp boundaries (client ingest.ts:2786-2787)", () => {
  // Verbatim port of the client's derivation (budget computation itself lives
  // in prompts.js; these formulas map a sourceBudget to chunk params):
  //   targetChars = clampNumber(Math.floor(sourceBudget * 0.55), 12_000, 60_000)
  //   overlapChars = clampNumber(Math.floor(targetChars * 0.08), 800, 3_000)
  const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value))
  const LONG_SOURCE_CHUNK_MIN = 12_000
  const LONG_SOURCE_CHUNK_MAX = 60_000
  const targetCharsForBudget = (sourceBudget) =>
    clampNumber(Math.floor(sourceBudget * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX)
  const overlapCharsForTarget = (targetChars) =>
    clampNumber(Math.floor(targetChars * 0.08), 800, 3_000)

  it("clamps target into [12_000, 60_000]", () => {
    expect(targetCharsForBudget(10_000)).toBe(12_000) // 5_500 → floor up
    expect(targetCharsForBudget(21_818)).toBe(12_000) // 11_999.9 → 11_999 → floor up
    expect(targetCharsForBudget(100_000)).toBe(55_000) // interior, unclamped
    expect(targetCharsForBudget(109_092)).toBe(60_000) // 60_000.6 → 60_000
    expect(targetCharsForBudget(109_093)).toBe(60_000) // 60_001 → floor down
    expect(targetCharsForBudget(1_000_000)).toBe(60_000)
  })

  it("clamps overlap into [800, 3_000]", () => {
    expect(overlapCharsForTarget(9_999)).toBe(800) // 799.92 → 799 → floor up
    expect(overlapCharsForTarget(10_000)).toBe(800) // exact lower bound
    expect(overlapCharsForTarget(12_000)).toBe(960) // interior
    expect(overlapCharsForTarget(37_500)).toBe(3_000) // exact upper bound
    expect(overlapCharsForTarget(60_000)).toBe(3_000) // 4_800 → floor down
  })

  it("chunking honors the minimum boundary values (target=12_000, overlap=800)", () => {
    // Three plain paragraphs (no headings) so each paragraph chunk's overlap
    // is drawn from the previous paragraph body.
    const source = ["X".repeat(12_000), "", "X".repeat(12_000), "", "X".repeat(12_000)].join("\n")
    const chunks = splitSourceIntoSemanticChunks(source, 12_000, 800)
    expect(chunks.length).toBe(3)
    expect(chunks[1].overlapBefore.length).toBe(800)
    expect(chunks[1].overlapBefore).toBe("X".repeat(800))
  })

  it("chunks correctly at the maximum boundary pair (target=60_000, overlap=3_000)", () => {
    const source = [
      "# A", "", "Y".repeat(25_000),
      "# B", "", "Y".repeat(25_000),
      "# C", "", "Y".repeat(25_000),
    ].join("\n")
    const chunks = splitSourceIntoSemanticChunks(source, 60_000, 3_000)
    expect(chunks.length).toBe(2)
    // The "# C" heading still fits chunk 1 (50_017 ≤ 60_000), so the overlap
    // tail is the last 3_000 chars of chunk 1: Y×2995 + "\n\n# C". The
    // paragraph break in that tail is rejected by overlapSuffix's 0.4× guard
    // (only 5 chars would remain), so the whole trimmed tail is kept.
    expect(chunks[1].overlapBefore).toBe("Y".repeat(2_995) + "\n\n# C")
  })
})

describe("oversized-block splitting", () => {
  it("splits an oversized paragraph at sentence punctuation (. ! ? 。 ！ ？)", () => {
    const sentence = (letter) => letter.repeat(599) + (letter === "B" ? "。" : letter === "C" ? "!" : ".")
    const paragraph = `${sentence("A")} ${sentence("B")} ${sentence("C")}`
    // 1802 chars > target*1.25 (1250) → oversized split kicks in.
    expect(paragraph.length).toBe(1802)

    const chunks = splitSourceIntoSemanticChunks(paragraph, 1000, 100)
    expect(chunks.length).toBe(3)
    expect(chunks[0].main).toBe("A".repeat(599) + ".")
    expect(chunks[1].main).toBe("B".repeat(599) + "。")
    expect(chunks[2].main).toBe("C".repeat(599) + "!")
  })

  it("hard-slices an oversized piece with no punctuation every targetChars", () => {
    const chunks = splitSourceIntoSemanticChunks("Z".repeat(2500), 1000, 100)
    expect(chunks.map((c) => c.main.length)).toEqual([1000, 1000, 500])
  })

  it("leaves blocks within the 1.25×target tolerance unsplit", () => {
    const chunks = splitSourceIntoSemanticChunks("Z".repeat(1250), 1000, 100)
    expect(chunks.length).toBe(1)
    expect(chunks[0].main.length).toBe(1250)
  })
})

describe("overlapSuffix behavior (via overlapBefore)", () => {
  it("prefers cutting at a paragraph break when enough content follows it", () => {
    const source = [
      "aaaa bbbb.",
      "",
      "cccc dddd eeee ffff gggg.",
      "",
      "T".repeat(1000),
    ].join("\n")
    const chunks = splitSourceIntoSemanticChunks(source, 1000, 30)
    expect(chunks.length).toBe(2)
    expect(chunks[1].overlapBefore).toBe("cccc dddd eeee ffff gggg.")
  })

  it("falls back to a sentence break when no paragraph break fits", () => {
    const source = ["aaaa bbbb cccc. dddd eeee ffff gggg hhhh.", "", "T".repeat(1000)].join("\n")
    const chunks = splitSourceIntoSemanticChunks(source, 1000, 30)
    expect(chunks.length).toBe(2)
    expect(chunks[1].overlapBefore).toBe("dddd eeee ffff gggg hhhh.")
  })
})

describe("LongSourceCheckpoint v1 — path, round-trip, compatibility", () => {
  const slug = "7-project-a--long-report"
  const sourceContent = "checkpointed source content"

  function makeParams(overrides = {}) {
    return {
      sourceIdentity: "project-a/long-report.md",
      sourceHash: hashTextHex(sourceContent),
      sourceLength: sourceContent.length,
      sourceBudget: 55_000,
      targetChars: 30_250,
      overlapChars: 2_420,
      chunkTotal: 4,
      ...overrides,
    }
  }

  function makeCheckpoint(params, overrides = {}) {
    return {
      version: 1,
      ...params,
      completedThrough: 2,
      globalDigest: "digest so far",
      analyses: ["chunk 1 analysis", "chunk 2 analysis"],
      updatedAt: 1_700_000_000_000,
      ...overrides,
    }
  }

  it("builds the checkpoint path as .llm-wiki/ingest-progress/<slug>-<fnv1a-hash>.json", () => {
    const hash = hashTextHex(sourceContent)
    expect(longSourceCheckpointPath("/proj", slug, hash))
      .toBe(`/proj/.llm-wiki/ingest-progress/${slug}-${hash}.json`)
    // Backslashes are normalized (path-utils parity).
    expect(longSourceCheckpointPath("C:\\fake\\proj", slug, hash))
      .toBe(`C:/fake/proj/.llm-wiki/ingest-progress/${slug}-${hash}.json`)
  })

  it("save → load round-trip returns the identical checkpoint (resume data intact)", async () => {
    const project = makeProject()
    const params = makeParams()
    const checkpointPath = longSourceCheckpointPath(project, slug, params.sourceHash)
    const checkpoint = makeCheckpoint(params)

    await saveLongSourceCheckpoint(checkpointPath, checkpoint)
    // Exact on-disk shape: pretty-printed JSON, nested dir auto-created.
    expect(readFileSync(checkpointPath, "utf8")).toBe(JSON.stringify(checkpoint, null, 2))

    const loaded = await loadLongSourceCheckpoint(checkpointPath, params)
    expect(loaded).toEqual(checkpoint)
    expect(loaded.completedThrough).toBe(2)
    expect(loaded.analyses).toEqual(["chunk 1 analysis", "chunk 2 analysis"])
    expect(loaded.globalDigest).toBe("digest so far")
  })

  it("is incompatible on ANY changed parameter (exact-equality check)", async () => {
    const project = makeProject()
    const params = makeParams()
    const checkpointPath = longSourceCheckpointPath(project, slug, params.sourceHash)
    await saveLongSourceCheckpoint(checkpointPath, makeCheckpoint(params))

    for (const key of [
      "sourceIdentity", "sourceHash", "sourceLength", "sourceBudget",
      "targetChars", "overlapChars", "chunkTotal",
    ]) {
      const tweaked = makeParams({ [key]: typeof params[key] === "number" ? params[key] + 1 : `${params[key]}x` })
      expect(await loadLongSourceCheckpoint(checkpointPath, tweaked), `param ${key}`).toBeNull()
      expect(isCompatibleLongSourceCheckpoint(makeCheckpoint(params), tweaked)).toBe(false)
    }
    // Untouched params still load.
    expect(await loadLongSourceCheckpoint(checkpointPath, params)).not.toBeNull()
  })

  it("rejects wrong version, bad completedThrough, and analyses-length mismatch", async () => {
    const params = makeParams()
    const base = makeCheckpoint(params)
    expect(isCompatibleLongSourceCheckpoint({ ...base, version: 2 }, params)).toBe(false)
    expect(isCompatibleLongSourceCheckpoint({ ...base, completedThrough: -1 }, params)).toBe(false)
    expect(isCompatibleLongSourceCheckpoint({ ...base, completedThrough: 5 }, params)).toBe(false) // > chunkTotal
    expect(isCompatibleLongSourceCheckpoint({ ...base, completedThrough: 3 }, params)).toBe(false) // analyses.length !== completedThrough
    expect(isCompatibleLongSourceCheckpoint({ ...base, analyses: "nope" }, params)).toBe(false)
  })

  it("returns null for a missing or corrupt checkpoint file", async () => {
    const project = makeProject()
    const params = makeParams()
    const checkpointPath = longSourceCheckpointPath(project, slug, params.sourceHash)

    expect(await loadLongSourceCheckpoint(checkpointPath, params)).toBeNull()

    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(path.dirname(checkpointPath), { recursive: true })
    writeFileSync(checkpointPath, "{not json")
    expect(await loadLongSourceCheckpoint(checkpointPath, params)).toBeNull()
  })

  it("clear removes the checkpoint file and is a safe no-op afterwards", async () => {
    const project = makeProject()
    const params = makeParams()
    const checkpointPath = longSourceCheckpointPath(project, slug, params.sourceHash)
    await saveLongSourceCheckpoint(checkpointPath, makeCheckpoint(params))
    expect(existsSync(checkpointPath)).toBe(true)

    await clearLongSourceCheckpoint(checkpointPath)
    expect(existsSync(checkpointPath)).toBe(false)
    await expect(clearLongSourceCheckpoint(checkpointPath)).resolves.toBeUndefined()
  })
})
