/**
 * Server-port tests for packages/server/src/ingest/wiki-upkeep.js
 * (issue #14 P0 server-driven ingest).
 *
 * All filesystem behavior runs against real mkdtemp project dirs. The
 * embedding module is mocked (reembedSourceSummary only needs the call
 * shape), and tryReadSourceTextFile receives an injected runInWorker so
 * the worker pool never spins up.
 *
 * Covers:
 *   - tryReadSourceTextFile: utf8 read, missing file, cache mtime rule
 *     (hit + stale), worker dispatch + cache write-back, placeholder
 *     formats (image/media/legacy-doc), worker-failure contract
 *   - appendIngestWarningLog: create, append, no-op on empty
 *   - updateWikiIndexDeterministically + normalizeIndexTarget: dedupe of
 *     known targets (incl. aliased wikilinks), aggregate skips, bounded
 *     "Recently Updated" section, title fallback, idempotence
 *   - buildFallbackSourceSummary shape
 *   - shouldRunDedicatedReviewStage thresholds
 *   - migrateLegacySourceSummaryIfSafe happy path + safety bailouts
 *     (canonical exists / ambiguous basenames / basename-only identity)
 *   - migrateExactLegacySourceSummaryIfSafe slug-candidate migration
 *   - matchingRawSourceIdentitiesForBasename (recursive, case-insensitive,
 *     hidden-entry exclusion, missing dir)
 *   - reembedSourceSummary: disabled no-op, title resolution, never throws
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, writeFile, mkdir, utimes, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

vi.mock("../src/ingest/embed.js", () => ({
  embedPage: vi.fn(async () => true),
  removePageEmbedding: vi.fn(async () => {}),
  getLastEmbeddingError: () => null,
  resetEmbeddingStateForTests: () => {},
  extractEmbeddingTitle: (content, fallbackId) => fallbackId,
}))

import { embedPage } from "../src/ingest/embed.js"
import {
  tryReadSourceTextFile,
  appendIngestWarningLog,
  updateWikiIndexDeterministically,
  normalizeIndexTarget,
  buildFallbackSourceSummary,
  shouldRunDedicatedReviewStage,
  migrateLegacySourceSummaryIfSafe,
  migrateExactLegacySourceSummaryIfSafe,
  matchingRawSourceIdentitiesForBasename,
  reembedSourceSummary,
} from "../src/ingest/wiki-upkeep.js"
import {
  sourceSummarySlugFromIdentity,
  legacySourceSummarySlugFromIdentity,
} from "../src/ingest/identity.js"

const embedPageMock = vi.mocked(embedPage)

let projectPath
beforeEach(async () => {
  embedPageMock.mockClear()
  projectPath = await mkdtemp(path.join(tmpdir(), "llmwiki-wiki-upkeep-"))
})

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true })
})

async function writeProject(relativePath, content) {
  const full = path.join(projectPath, relativePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, "utf8")
}

async function writeProjectBytes(relativePath, buffer) {
  const full = path.join(projectPath, relativePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, buffer)
}

async function readProject(relativePath) {
  return readFile(path.join(projectPath, relativePath), "utf8")
}

async function projectFileExists(relativePath) {
  try {
    await stat(path.join(projectPath, relativePath))
    return true
  } catch {
    return false
  }
}

// ── tryReadSourceTextFile ────────────────────────────────────────

describe("tryReadSourceTextFile", () => {
  it("reads plain text files as utf8", async () => {
    const full = path.join(projectPath, "notes.txt")
    await writeFile(full, "hello notes", "utf8")
    const runInWorker = vi.fn()
    await expect(tryReadSourceTextFile(full, { runInWorker })).resolves.toBe("hello notes")
    expect(runInWorker).not.toHaveBeenCalled()
  })

  it('returns "" for a missing file (try* contract)', async () => {
    await expect(tryReadSourceTextFile(path.join(projectPath, "nope.md"), { runInWorker: vi.fn() }))
      .resolves.toBe("")
  })

  it("serves the .cache file when it is at least as new as the original", async () => {
    const original = path.join(projectPath, "doc.pdf")
    await writeFile(original, "%PDF-raw-bytes", "utf8")
    await writeProject(".cache/doc.pdf.txt", "cached extraction")
    const now = Math.floor(Date.now() / 1000)
    await utimes(original, now - 100, now - 100)
    await utimes(path.join(projectPath, ".cache/doc.pdf.txt"), now, now)

    const runInWorker = vi.fn().mockRejectedValue(new Error("worker must not run on cache hit"))
    await expect(tryReadSourceTextFile(original, { runInWorker })).resolves.toBe("cached extraction")
    expect(runInWorker).not.toHaveBeenCalled()
  })

  it("ignores a stale cache, extracts via the worker, and writes the cache back", async () => {
    const original = path.join(projectPath, "doc.docx")
    await writeFile(original, "docx-bytes", "utf8")
    await writeProject(".cache/doc.docx.txt", "stale extraction")
    const now = Math.floor(Date.now() / 1000)
    await utimes(path.join(projectPath, ".cache/doc.docx.txt"), now - 100, now - 100)
    await utimes(original, now, now)

    const runInWorker = vi.fn().mockResolvedValue("fresh extraction")
    await expect(tryReadSourceTextFile(original, { runInWorker })).resolves.toBe("fresh extraction")
    expect(runInWorker).toHaveBeenCalledTimes(1)
    expect(runInWorker).toHaveBeenCalledWith("preprocess", { filePath: original })

    // Cache write-back (Rust write_cache mirror) → next read is a cache hit.
    await expect(readProject(".cache/doc.docx.txt")).resolves.toBe("fresh extraction")
    await expect(tryReadSourceTextFile(original, { runInWorker })).resolves.toBe("fresh extraction")
    expect(runInWorker).toHaveBeenCalledTimes(1)
  })

  it("routes every preprocess-supported binary extension through the worker", async () => {
    const runInWorker = vi.fn().mockResolvedValue("extracted")
    for (const ext of ["pdf", "org", "doc", "docx", "pptx", "xls", "xlsx", "odt", "ods", "odp", "epub", "mobi"]) {
      const full = path.join(projectPath, `file.${ext}`)
      await writeFile(full, "binary-ish", "utf8")
      await expect(tryReadSourceTextFile(full, { runInWorker })).resolves.toBe("extracted")
    }
    expect(runInWorker).toHaveBeenCalledTimes(12)
  })

  it("renders image/media/legacy-doc placeholders byte-identical to Rust", async () => {
    const runInWorker = vi.fn()

    const png = path.join(projectPath, "pic.png")
    await writeProjectBytes("pic.png", Buffer.alloc(2048))
    await expect(tryReadSourceTextFile(png, { runInWorker }))
      .resolves.toBe("[Image: pic.png (2.0 KB)]")

    const pngFractional = path.join(projectPath, "small.png")
    await writeProjectBytes("small.png", Buffer.alloc(1536))
    await expect(tryReadSourceTextFile(pngFractional, { runInWorker }))
      .resolves.toBe("[Image: small.png (1.5 KB)]")

    const mp4 = path.join(projectPath, "clip.mp4")
    await writeProjectBytes("clip.mp4", Buffer.alloc(3 * 1048576))
    await expect(tryReadSourceTextFile(mp4, { runInWorker }))
      .resolves.toBe("[Media: clip.mp4 (3.0 MB)]")

    const ppt = path.join(projectPath, "slides.ppt")
    await writeFile(ppt, "", "utf8")
    await expect(tryReadSourceTextFile(ppt, { runInWorker }))
      .resolves.toBe("[Document: slides.ppt — text extraction not supported for .ppt format]")

    expect(runInWorker).not.toHaveBeenCalled()
  })

  it('returns "" when the worker extraction fails', async () => {
    const full = path.join(projectPath, "broken.epub")
    await writeFile(full, "not really an epub", "utf8")
    const runInWorker = vi.fn().mockRejectedValue(new Error("Could not extract text from EPUB"))
    await expect(tryReadSourceTextFile(full, { runInWorker })).resolves.toBe("")
  })
})

// ── appendIngestWarningLog ───────────────────────────────────────

describe("appendIngestWarningLog", () => {
  it("does nothing for an empty warnings list", async () => {
    await appendIngestWarningLog(projectPath, "papers/a.pdf", [])
    expect(await projectFileExists(".llm-wiki/ingest-warnings.log")).toBe(false)
  })

  it("creates the log, then appends a second entry separated by a blank line", async () => {
    await appendIngestWarningLog(projectPath, "papers/a.pdf", ["first warning", "second warning"])
    const first = await readProject(".llm-wiki/ingest-warnings.log")
    expect(first).toMatch(/^## \d{4}-\d{2}-\d{2}T[\d:.]+Z \| papers\/a\.pdf\n\n1\. first warning\n2\. second warning\n$/)

    await appendIngestWarningLog(projectPath, "papers/b.pdf", ["third warning"])
    const second = await readProject(".llm-wiki/ingest-warnings.log")
    expect(second.startsWith(first.trimEnd())).toBe(true)
    expect(second).toContain("\n\n## ")
    expect(second).toContain("papers/b.pdf")
    expect(second).toContain("1. third warning")
    expect(second.endsWith("\n")).toBe(true)
  })
})

// ── updateWikiIndexDeterministically ─────────────────────────────

describe("updateWikiIndexDeterministically", () => {
  it("returns false when there are no wiki-page candidates", async () => {
    expect(await updateWikiIndexDeterministically(projectPath, [])).toBe(false)
    expect(await updateWikiIndexDeterministically(projectPath, ["raw/sources/a.pdf"])).toBe(false)
    expect(await updateWikiIndexDeterministically(projectPath, ["wiki/notes.txt"])).toBe(false)
    expect(await updateWikiIndexDeterministically(projectPath, [
      "wiki/index.md", "wiki/overview.md", "wiki/log.md",
    ])).toBe(false)
    expect(await projectFileExists("wiki/index.md")).toBe(false)
  })

  it("creates the index and adds entries under the bounded recent section", async () => {
    await writeProject("wiki/pages/foo.md", "---\ntitle: Foo Page\n---\n# Foo Page\nbody")
    await writeProject("wiki/pages/bar.md", "---\ntitle: Bar Page\n---\nbody")

    const changed = await updateWikiIndexDeterministically(projectPath, [
      "wiki/pages/foo.md", "wiki/pages/bar.md",
    ])
    expect(changed).toBe(true)

    const index = await readProject("wiki/index.md")
    expect(index).toContain("# Wiki Index")
    const sectionStart = index.indexOf("## Recently Updated")
    expect(sectionStart).toBeGreaterThan(-1)
    expect(index.indexOf("- [[pages/foo]] — Foo Page")).toBeGreaterThan(sectionStart)
    expect(index.indexOf("- [[pages/bar]] — Bar Page")).toBeGreaterThan(sectionStart)
  })

  it("falls back to the file name when the page has no frontmatter title", async () => {
    await writeProject("wiki/pages/untitled.md", "no frontmatter here")
    await updateWikiIndexDeterministically(projectPath, ["wiki/pages/untitled.md"])
    const index = await readProject("wiki/index.md")
    expect(index).toContain("- [[pages/untitled]] — untitled")
  })

  it("dedupes against wikilinks already present in the index (all alias forms)", async () => {
    await writeProject("wiki/index.md", [
      "# Wiki Index",
      "",
      "- [[pages/foo]]",
      "- [[wiki/pages/bar.md]]",
      "- [[pages/baz|Custom Label]]",
      "- [[pages/qux#Heading]]",
    ].join("\n"))
    await writeProject("wiki/pages/foo.md", "---\ntitle: Foo\n---\nbody")
    await writeProject("wiki/pages/bar.md", "---\ntitle: Bar\n---\nbody")
    await writeProject("wiki/pages/baz.md", "---\ntitle: Baz\n---\nbody")
    await writeProject("wiki/pages/qux.md", "---\ntitle: Qux\n---\nbody")
    await writeProject("wiki/pages/fresh.md", "---\ntitle: Fresh\n---\nbody")

    const changed = await updateWikiIndexDeterministically(projectPath, [
      "wiki/pages/foo.md", "wiki/pages/bar.md", "wiki/pages/baz.md",
      "wiki/pages/qux.md", "wiki/pages/fresh.md",
      // duplicate written paths collapse before matching
      "wiki/pages/fresh.md", "wiki\\pages\\fresh.md",
    ])
    expect(changed).toBe(true)
    const index = await readProject("wiki/index.md")
    expect(index.match(/pages\/fresh/g)).toHaveLength(1)
    expect(index).toContain("- [[pages/fresh]] — Fresh")
    // The pre-existing index lines survive the bounded-section rewrite.
    expect(index).toContain("- [[pages/foo]]")
    expect(index).toContain("- [[pages/baz|Custom Label]]")
  })

  it("is idempotent: a second run with the same paths returns false", async () => {
    await writeProject("wiki/pages/foo.md", "---\ntitle: Foo\n---\nbody")
    expect(await updateWikiIndexDeterministically(projectPath, ["wiki/pages/foo.md"])).toBe(true)
    expect(await updateWikiIndexDeterministically(projectPath, ["wiki/pages/foo.md"])).toBe(false)
  })
})

describe("normalizeIndexTarget", () => {
  it("normalizes wiki prefix, .md suffix, separators, and case", () => {
    expect(normalizeIndexTarget("wiki/Foo.Bar.md")).toBe("foo.bar")
    expect(normalizeIndexTarget("Foo")).toBe("foo")
    expect(normalizeIndexTarget("WIKI\\x.MD")).toBe("x")
    expect(normalizeIndexTarget("pages/deep/Page.md")).toBe("pages/deep/page")
  })
})

// ── buildFallbackSourceSummary ───────────────────────────────────

describe("buildFallbackSourceSummary", () => {
  it("renders the full recovery page shape", () => {
    const out = buildFallbackSourceSummary("papers/a.pdf", "Some analysis.", "2026-08-04")
    expect(out).toBe([
      "---",
      "type: source",
      'title: "Source: papers/a.pdf"',
      "created: 2026-08-04",
      "updated: 2026-08-04",
      'sources: ["papers/a.pdf"]',
      "tags: []",
      "related: []",
      "---",
      "",
      "# Source: papers/a.pdf",
      "",
      "Some analysis.",
      "",
    ].join("\n"))
  })

  it("uses the not-available placeholder for an empty analysis", () => {
    expect(buildFallbackSourceSummary("a.pdf", "", "2026-08-04")).toContain("(Analysis not available)")
  })
})

// ── shouldRunDedicatedReviewStage ────────────────────────────────

describe("shouldRunDedicatedReviewStage", () => {
  it("gates on signal length (REVIEW_STAGE_MIN_SIGNAL_CHARS = 10_000)", () => {
    expect(shouldRunDedicatedReviewStage("x".repeat(9_999))).toBe(false)
    expect(shouldRunDedicatedReviewStage("x".repeat(10_000))).toBe(true)
  })

  it("gates on FILE block count (REVIEW_STAGE_MIN_FILE_BLOCKS = 4)", () => {
    const block = (p) => `---FILE: ${p}---\nbody\n---END FILE---`
    const three = [block("wiki/a.md"), block("wiki/b.md"), block("wiki/c.md")].join("\n\n")
    const four = `${three}\n\n${block("wiki/d.md")}`
    expect(shouldRunDedicatedReviewStage(three)).toBe(false)
    expect(shouldRunDedicatedReviewStage(four)).toBe(true)
  })

  it("runs for any REVIEW signal line, case-insensitively", () => {
    expect(shouldRunDedicatedReviewStage("short\n---REVIEW: item-1 | do something")).toBe(true)
    expect(shouldRunDedicatedReviewStage("short\n---review: item_2 | do something")).toBe(true)
  })

  it("skips short generations without blocks or review signals", () => {
    expect(shouldRunDedicatedReviewStage("just a short generation")).toBe(false)
  })
})

// ── legacy source-summary migration ──────────────────────────────

describe("migrateLegacySourceSummaryIfSafe", () => {
  const identity = "papers/deep learning.pdf"
  const canonicalSlug = sourceSummarySlugFromIdentity(identity)
  const sourceSummaryPath = `wiki/sources/${canonicalSlug}.md`
  const legacyRelPath = "wiki/sources/deep learning.md"

  function legacyPage(sourceRefs) {
    return [
      "---",
      "type: source",
      `sources: [${sourceRefs.map((s) => `"${s}"`).join(", ")}]`,
      "---",
      "",
      "# Legacy summary",
    ].join("\n")
  }

  it("migrates the basename-slug page to the canonical slug (happy path)", async () => {
    await writeProject(legacyRelPath, legacyPage(["deep learning.pdf"]))
    await writeProject("raw/sources/papers/deep learning.pdf", "binary-ish")

    await migrateLegacySourceSummaryIfSafe(projectPath, identity, sourceSummaryPath)

    expect(await projectFileExists(legacyRelPath)).toBe(false)
    const canonical = await readProject(sourceSummaryPath)
    expect(canonical).toContain(`sources: ["${identity}"]`)
    expect(canonical).toContain("# Legacy summary")
  })

  it("bails out when the canonical page already exists", async () => {
    await writeProject(sourceSummaryPath, "sentinel canonical")
    await writeProject(legacyRelPath, legacyPage(["deep learning.pdf"]))
    await writeProject("raw/sources/papers/deep learning.pdf", "binary-ish")

    await migrateLegacySourceSummaryIfSafe(projectPath, identity, sourceSummaryPath)

    expect(await readProject(sourceSummaryPath)).toBe("sentinel canonical")
    expect(await projectFileExists(legacyRelPath)).toBe(true)
  })

  it("bails out when multiple raw sources share the basename (ambiguous)", async () => {
    await writeProject(legacyRelPath, legacyPage(["report.pdf"]))
    await writeProject("raw/sources/a/report.pdf", "x")
    await writeProject("raw/sources/b/report.pdf", "y")

    await migrateLegacySourceSummaryIfSafe(
      projectPath, "a/report.pdf", `wiki/sources/${sourceSummarySlugFromIdentity("a/report.pdf")}.md`,
    )

    expect(await projectFileExists(legacyRelPath)).toBe(true)
    expect(await projectFileExists(`wiki/sources/${sourceSummarySlugFromIdentity("a/report.pdf")}.md`)).toBe(false)
  })

  it("bails out when the sole basename match belongs to a different folder", async () => {
    await writeProject(legacyRelPath.replace("deep learning", "report"), legacyPage(["report.pdf"]))
    await writeProject("raw/sources/report.pdf", "only root copy")

    await migrateLegacySourceSummaryIfSafe(
      projectPath, "a/report.pdf", `wiki/sources/${sourceSummarySlugFromIdentity("a/report.pdf")}.md`,
    )

    expect(await projectFileExists("wiki/sources/report.md")).toBe(true)
  })

  it("bails out when the legacy page references a different source", async () => {
    await writeProject(legacyRelPath, legacyPage(["other.pdf"]))
    await writeProject("raw/sources/papers/deep learning.pdf", "binary-ish")

    await migrateLegacySourceSummaryIfSafe(projectPath, identity, sourceSummaryPath)

    expect(await projectFileExists(legacyRelPath)).toBe(true)
    expect(await projectFileExists(sourceSummaryPath)).toBe(false)
  })

  it("is a no-op for basename-only identities", async () => {
    await writeProject(legacyRelPath, legacyPage(["deep learning.pdf"]))
    await migrateLegacySourceSummaryIfSafe(projectPath, "deep learning.pdf", sourceSummaryPath)
    expect(await projectFileExists(legacyRelPath)).toBe(true)
    expect(await projectFileExists(sourceSummaryPath)).toBe(false)
  })
})

describe("migrateExactLegacySourceSummaryIfSafe", () => {
  // "sub dir/my report.pdf" yields distinct canonical vs legacy
  // (encodeURIComponent-style) slug candidates.
  const identity = "sub dir/my report.pdf"
  const canonicalSlug = sourceSummarySlugFromIdentity(identity)
  const legacySlug = legacySourceSummarySlugFromIdentity(identity)

  it("moves a candidate-slug page that references the exact identity", async () => {
    expect(legacySlug).not.toBe(canonicalSlug)
    const sourceSummaryPath = `wiki/sources/${canonicalSlug}.md`
    const legacyRelPath = `wiki/sources/${legacySlug}.md`
    await writeProject(legacyRelPath, [
      "---",
      `sources: ["${identity}"]`,
      "---",
      "",
      "# Exact legacy summary",
    ].join("\n"))

    const migrated = await migrateExactLegacySourceSummaryIfSafe(projectPath, identity, sourceSummaryPath)

    expect(migrated).toBe(true)
    expect(await projectFileExists(legacyRelPath)).toBe(false)
    const canonical = await readProject(sourceSummaryPath)
    expect(canonical).toContain(`sources: ["${identity}"]`)
    expect(canonical).toContain("# Exact legacy summary")
  })

  it("returns false when the canonical page already exists", async () => {
    const sourceSummaryPath = `wiki/sources/${canonicalSlug}.md`
    await writeProject(sourceSummaryPath, "sentinel")
    await writeProject(`wiki/sources/${legacySlug}.md`, [
      "---", `sources: ["${identity}"]`, "---",
    ].join("\n"))

    expect(await migrateExactLegacySourceSummaryIfSafe(projectPath, identity, sourceSummaryPath)).toBe(false)
    expect(await readProject(sourceSummaryPath)).toBe("sentinel")
  })

  it("returns false when no candidate page references the identity", async () => {
    const sourceSummaryPath = `wiki/sources/${canonicalSlug}.md`
    await writeProject(`wiki/sources/${legacySlug}.md`, [
      "---", 'sources: ["something else.pdf"]', "---",
    ].join("\n"))

    expect(await migrateExactLegacySourceSummaryIfSafe(projectPath, identity, sourceSummaryPath)).toBe(false)
    expect(await projectFileExists(sourceSummaryPath)).toBe(false)
    expect(await projectFileExists(`wiki/sources/${legacySlug}.md`)).toBe(true)
  })
})

describe("matchingRawSourceIdentitiesForBasename", () => {
  it("returns [] when raw/sources does not exist", async () => {
    expect(await matchingRawSourceIdentitiesForBasename(projectPath, "a.pdf")).toEqual([])
  })

  it("finds nested matches case-insensitively and strips the root prefix", async () => {
    await writeProject("raw/sources/a/b/file.pdf", "x")
    await writeProject("raw/sources/other.pdf", "y")
    await writeProject("raw/sources/.hidden/file.pdf", "z")
    await writeProject("raw/sources/.file.pdf", "w")

    expect(await matchingRawSourceIdentitiesForBasename(projectPath, "file.pdf"))
      .toEqual(["a/b/file.pdf"])
    expect(await matchingRawSourceIdentitiesForBasename(projectPath, "FILE.PDF"))
      .toEqual(["a/b/file.pdf"])
    // Hidden entries (dot-names at any depth) are invisible, mirroring
    // Rust list_directory(include_hidden=false).
    expect(await matchingRawSourceIdentitiesForBasename(projectPath, "other.pdf"))
      .toEqual(["other.pdf"])
  })
})

// ── reembedSourceSummary ─────────────────────────────────────────

describe("reembedSourceSummary", () => {
  const embCfg = { enabled: true, model: "emb-model", endpoint: "http://emb.test/v1" }

  it("is a no-op when embedding is disabled or model-less", async () => {
    await reembedSourceSummary(projectPath, "a.pdf", "slug-a", { enabled: false, model: "m" })
    await reembedSourceSummary(projectPath, "a.pdf", "slug-a", { enabled: true, model: "" })
    await reembedSourceSummary(projectPath, "a.pdf", "slug-a", undefined)
    expect(embedPageMock).not.toHaveBeenCalled()
  })

  it("embeds with the frontmatter title when present", async () => {
    const content = "---\ntitle: My Source Title\n---\nbody text"
    await writeProject("wiki/sources/slug-a.md", content)

    await reembedSourceSummary(projectPath, "papers/a.pdf", "slug-a", embCfg)

    expect(embedPageMock).toHaveBeenCalledTimes(1)
    expect(embedPageMock).toHaveBeenCalledWith(projectPath, "slug-a", "My Source Title", content, embCfg)
  })

  it("falls back to the source identity when no title is present", async () => {
    await writeProject("wiki/sources/slug-b.md", "no frontmatter")

    await reembedSourceSummary(projectPath, "papers/b.pdf", "slug-b", embCfg)

    expect(embedPageMock).toHaveBeenCalledWith(projectPath, "slug-b", "papers/b.pdf", "no frontmatter", embCfg)
  })

  it("never throws: missing page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(reembedSourceSummary(projectPath, "a.pdf", "missing-slug", embCfg)).resolves.toBeUndefined()
      expect(embedPageMock).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("never throws: embedPage failure", async () => {
    await writeProject("wiki/sources/slug-c.md", "---\ntitle: C\n---\nbody")
    embedPageMock.mockRejectedValueOnce(new Error("vector store exploded"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(reembedSourceSummary(projectPath, "c.pdf", "slug-c", embCfg)).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
