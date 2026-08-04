/**
 * Server-port tests for packages/server/src/ingest/write.js (issue #14
 * P0 server-driven ingest, "write" cluster).
 *
 * Covers the client write-path behaviors found in
 * src/lib/ingest-parse.test.ts (rewriteIngestPathFromTitleForTargetLanguage
 * matrix) and src/lib/ingest.scenarios.test.ts (writeFileBlocks exercised
 * there through autoIngest; here it is tested directly):
 *
 *   - normal content-page write (stamps, sources canonicalization)
 *   - log append (fresh + existing)
 *   - listing overwrite
 *   - content-page merge with injected mock merger
 *   - single-source page body replacement (replaceExistingBody)
 *   - merger failure fallback + backup
 *   - app-managed aggregate skip warning
 *   - language-guard drop
 *   - wiki-schema routing drop
 *   - hardFailure capture (FS error)
 *   - sourceSummaryPath substitution + media-ref rewrite
 *   - abort semantics
 *   - truncated FILE block accounting
 *
 * Runs against a real mkdtemp project dir; no network, no LLM, no
 * LLM_WIKI_DATA_DIR usage. The LLM module is mocked so the default
 * buildPageMerger can never reach normalizeEndpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

vi.mock("../src/ingest/llm.js", () => ({
  streamChat: vi.fn(),
  IngestLlmError: class IngestLlmError extends Error {},
  isUsageLimitError: () => false,
  USAGE_LIMIT_BACKOFF_MS: 0,
}))

import { streamChat } from "../src/ingest/llm.js"
import {
  writeFileBlocks,
  isOwnedOnlyBySource,
  tryReadFile,
  throwIfIngestAborted,
  backupExistingPage,
  extractGeneratedPageTitle,
  rewriteIngestPathFromTitleForTargetLanguage,
  buildPageMerger,
} from "../src/ingest/write.js"
import { currentWikiDate } from "../src/ingest/parse.js"
import { buildPageMergeSystemPrompt } from "../src/ingest/prompts.js"

const streamChatMock = vi.mocked(streamChat)

const LLM_CONFIG = { provider: "openai", apiKey: "k", model: "m" }

/** Wrap a page body in a FILE block the way the stage-2 model does. */
const block = (blockPath, content) =>
  `---FILE: ${blockPath}---\n${content}\n---END FILE---`

const ENTITY_PAGE = [
  "---",
  "type: entity",
  "title: Foo",
  "tags: []",
  "related: []",
  "---",
  "",
  "# Foo",
  "",
  "Body about Foo.",
].join("\n")

let projectPath
beforeEach(async () => {
  streamChatMock.mockReset()
  projectPath = await mkdtemp(path.join(tmpdir(), "llmwiki-ingest-write-"))
})

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true })
})

async function readProject(relativePath) {
  return readFile(path.join(projectPath, relativePath), "utf8")
}

async function writeProject(relativePath, content) {
  const full = path.join(projectPath, relativePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, "utf8")
}

async function projectFileExists(relativePath) {
  try {
    await readFile(path.join(projectPath, relativePath), "utf8")
    return true
  } catch {
    return false
  }
}

// ── throwIfIngestAborted ─────────────────────────────────────────

describe("throwIfIngestAborted", () => {
  it("throws the exact client error message when the signal is aborted", () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => throwIfIngestAborted(controller.signal)).toThrow("Ingest cancelled")
  })

  it("does not throw for a missing or non-aborted signal", () => {
    expect(() => throwIfIngestAborted(undefined)).not.toThrow()
    expect(() => throwIfIngestAborted(new AbortController().signal)).not.toThrow()
  })
})

// ── tryReadFile ──────────────────────────────────────────────────

describe("tryReadFile", () => {
  it("returns file contents as utf8 and empty string for missing files", async () => {
    await writeProject("wiki/a.md", "hello 世界")
    expect(await tryReadFile(path.join(projectPath, "wiki/a.md"))).toBe("hello 世界")
    expect(await tryReadFile(path.join(projectPath, "wiki/nope.md"))).toBe("")
  })
})

// ── extractGeneratedPageTitle ────────────────────────────────────

describe("extractGeneratedPageTitle", () => {
  it("prefers the frontmatter title over the first heading", () => {
    const content = "---\ntitle: From Frontmatter\n---\n\n# From Heading"
    expect(extractGeneratedPageTitle(content)).toBe("From Frontmatter")
  })

  it("falls back to the first markdown heading", () => {
    expect(extractGeneratedPageTitle("no frontmatter here\n\n# Heading Title\n")).toBe("Heading Title")
  })

  it("returns null when neither title nor heading exists", () => {
    expect(extractGeneratedPageTitle("just prose")).toBeNull()
  })
})

// ── rewriteIngestPathFromTitleForTargetLanguage ──────────────────
// Client matrix from src/lib/ingest-parse.test.ts plus the guard rails.

describe("rewriteIngestPathFromTitleForTargetLanguage", () => {
  it("uses the CJK page title for generated page filenames when the target language is CJK", () => {
    const content = [
      "---",
      "type: concept",
      "title: 反硝化除磷技术",
      "created: 2026-06-18",
      "---",
      "",
      "# 反硝化除磷技术",
      "",
      "正文。",
    ].join("\n")

    expect(
      rewriteIngestPathFromTitleForTargetLanguage(
        "wiki/concepts/denitrifying-phosphorus-removal.md",
        content,
        "Chinese",
      ),
    ).toBe("wiki/concepts/反硝化除磷技术.md")
  })

  it("does not rewrite source summaries or aggregate pages", () => {
    const content = "---\ntitle: 反硝化除磷技术\n---\n# 反硝化除磷技术"

    expect(
      rewriteIngestPathFromTitleForTargetLanguage("wiki/sources/source-slug.md", content, "Chinese"),
    ).toBe("wiki/sources/source-slug.md")
    expect(
      rewriteIngestPathFromTitleForTargetLanguage("wiki/index.md", content, "Chinese"),
    ).toBe("wiki/index.md")
  })

  it("does not rewrite for non-CJK, auto, or missing target languages", () => {
    const content = "---\ntitle: 反硝化除磷技术\n---\n# 反硝化除磷技术"
    const p = "wiki/concepts/foo.md"
    expect(rewriteIngestPathFromTitleForTargetLanguage(p, content, "English")).toBe(p)
    expect(rewriteIngestPathFromTitleForTargetLanguage(p, content, "auto")).toBe(p)
    expect(rewriteIngestPathFromTitleForTargetLanguage(p, content, undefined)).toBe(p)
  })

  it("does not rewrite when the title has no CJK characters", () => {
    const content = "---\ntitle: Denitrification\n---\n# Denitrification"
    expect(
      rewriteIngestPathFromTitleForTargetLanguage("wiki/concepts/foo.md", content, "Chinese"),
    ).toBe("wiki/concepts/foo.md")
  })

  it("does not rewrite when the filename already contains CJK", () => {
    const content = "---\ntitle: 反硝化除磷技术\n---\n# 反硝化除磷技术"
    expect(
      rewriteIngestPathFromTitleForTargetLanguage("wiki/concepts/已有名字.md", content, "Chinese"),
    ).toBe("wiki/concepts/已有名字.md")
  })

  it("does not rewrite log paths", () => {
    const content = "---\ntitle: 日志标题\n---\n# 日志标题"
    expect(
      rewriteIngestPathFromTitleForTargetLanguage("wiki/log.md", content, "Chinese"),
    ).toBe("wiki/log.md")
  })

  it("uses a heading fallback title from extractGeneratedPageTitle", () => {
    const content = "# 脱氮除磷工艺\n\n正文。"
    expect(
      rewriteIngestPathFromTitleForTargetLanguage("wiki/concepts/process.md", content, "Chinese"),
    ).toBe("wiki/concepts/脱氮除磷工艺.md")
  })
})

// ── isOwnedOnlyBySource ──────────────────────────────────────────

describe("isOwnedOnlyBySource", () => {
  it("is true when every source normalizes to the active identity", () => {
    const content = '---\nsources: ["raw/sources/folder/doc.pdf"]\n---\n# X'
    expect(isOwnedOnlyBySource(content, "folder/doc.pdf")).toBe(true)
  })

  it("is false when another source contributes", () => {
    const content = '---\nsources: ["a.pdf", "b.pdf"]\n---\n# X'
    expect(isOwnedOnlyBySource(content, "b.pdf")).toBe(false)
  })

  it("is false when the page has no sources field", () => {
    expect(isOwnedOnlyBySource("---\ntitle: X\n---\n# X", "b.pdf")).toBe(false)
  })
})

// ── backupExistingPage ───────────────────────────────────────────

describe("backupExistingPage", () => {
  it("snapshots content under .llm-wiki/page-history with a sanitized name", async () => {
    await backupExistingPage(projectPath, "wiki/entities/foo.md", "old content")
    const entries = await readdir(path.join(projectPath, ".llm-wiki/page-history"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^wiki_entities_foo\.md-\d{4}-\d{2}-\d{2}T/)
    expect(await readProject(`.llm-wiki/page-history/${entries[0]}`)).toBe("old content")
  })
})

// ── buildPageMerger ──────────────────────────────────────────────

describe("buildPageMerger", () => {
  it("calls streamChat with the merge prompt, both versions, and temperature 0.1", async () => {
    streamChatMock.mockResolvedValueOnce("MERGED OUTPUT")
    const controller = new AbortController()

    const merger = buildPageMerger(LLM_CONFIG)
    const out = await merger("EXISTING", "INCOMING", "src.pdf", controller.signal)

    expect(out).toBe("MERGED OUTPUT")
    expect(streamChatMock).toHaveBeenCalledTimes(1)
    const [config, messages, opts] = streamChatMock.mock.calls[0]
    expect(config).toBe(LLM_CONFIG)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ role: "system", content: buildPageMergeSystemPrompt() })
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("## Existing version on disk\n\nEXISTING")
    expect(messages[1].content).toContain("## Newly generated version (from src.pdf)\n\nINCOMING")
    expect(messages[1].content).toContain("Now output the merged file. Start with `---` on the first line.")
    expect(opts).toEqual({ signal: controller.signal, overrides: { temperature: 0.1 } })
  })
})

// ── writeFileBlocks: normal page write ───────────────────────────

describe("writeFileBlocks — normal content-page write", () => {
  it("writes the page, stamps dates, canonicalizes sources, and reports paths", async () => {
    const today = currentWikiDate()
    const written = []
    const text = block("wiki/entities/foo.md", ENTITY_PAGE)

    const result = await writeFileBlocks(
      projectPath,
      text,
      LLM_CONFIG,
      undefined, // outputLanguage
      "doc.pdf",
      "wiki/sources/doc.md",
      undefined,
      (p) => written.push(p),
    )

    expect(result.writtenPaths).toEqual(["wiki/entities/foo.md"])
    expect(result.completedInputPaths).toEqual(["wiki/entities/foo.md"])
    expect(result.warnings).toEqual([])
    expect(result.hardFailures).toEqual([])
    expect(result.truncatedPaths).toEqual([])
    expect(written).toEqual(["wiki/entities/foo.md"])

    const onDisk = await readProject("wiki/entities/foo.md")
    expect(onDisk).toContain(`created: ${today}`)
    expect(onDisk).toContain(`updated: ${today}`)
    // The model omitted sources — canonicalization must add the active identity.
    expect(onDisk).toContain('sources: ["doc.pdf"]')
    expect(onDisk).toContain("# Foo")
  })
})

// ── writeFileBlocks: log append ──────────────────────────────────

describe("writeFileBlocks — log append", () => {
  const LOG_ENTRY = "## [YYYY-MM-DD] ingest | Doc"

  it("writes a fresh log file with the stamped date", async () => {
    const today = currentWikiDate()
    const text = block("wiki/log.md", LOG_ENTRY)

    const result = await writeFileBlocks(
      projectPath, text, LLM_CONFIG, undefined, "doc.pdf",
    )

    expect(result.writtenPaths).toEqual(["wiki/log.md"])
    expect(await readProject("wiki/log.md")).toBe(`## [${today}] ingest | Doc`)
  })

  it("appends to an existing log file separated by a blank line", async () => {
    const today = currentWikiDate()
    const existingLog = "# Wiki Log\n\n## [2020-01-01] ingest | Old"
    await writeProject("wiki/log.md", existingLog)

    await writeFileBlocks(
      projectPath, block("wiki/log.md", LOG_ENTRY), LLM_CONFIG, undefined, "doc.pdf",
    )

    expect(await readProject("wiki/log.md")).toBe(
      `${existingLog}\n\n## [${today}] ingest | Doc`,
    )
  })
})

// ── writeFileBlocks: listing overwrite ───────────────────────────

describe("writeFileBlocks — listing overwrite", () => {
  it("overwrites a listing page wholesale instead of merging", async () => {
    await writeProject("wiki/topics/index.md", "# Old listing\n\nstale content")
    const newListing = "---\ntitle: Topics\n---\n\n# Topics listing\n\nfresh content"

    const merger = vi.fn()
    const result = await writeFileBlocks(
      projectPath,
      block("wiki/topics/index.md", newListing),
      LLM_CONFIG,
      undefined,
      "doc.pdf",
      undefined,
      undefined,
      undefined,
      { merger },
    )

    expect(result.writtenPaths).toEqual(["wiki/topics/index.md"])
    expect(await readProject("wiki/topics/index.md")).toBe(newListing)
    expect(merger).not.toHaveBeenCalled()
  })
})

// ── writeFileBlocks: content-page merge ──────────────────────────

describe("writeFileBlocks — content-page merge", () => {
  const EXISTING_MULTI_SOURCE = [
    "---",
    "type: entity",
    "title: Foo",
    "created: 2025-01-01",
    "updated: 2025-01-01",
    'sources: ["a.pdf", "b-old.pdf"]',
    "tags: [old]",
    "related: []",
    "---",
    "",
    "# Foo",
    "",
    "Old body statement one.",
  ].join("\n")

  const INCOMING = [
    "---",
    "type: entity",
    "title: Foo",
    'sources: ["b.pdf"]',
    "tags: [new]",
    "related: []",
    "---",
    "",
    "# Foo",
    "",
    "New body statement two.",
  ].join("\n")

  it("uses the injected merger for multi-source pages and locks metadata", async () => {
    await writeProject("wiki/entities/foo.md", EXISTING_MULTI_SOURCE)

    const mergedPage = [
      "---",
      "type: entity",
      "title: Foo Merged",
      "created: 2024-12-31",
      'sources: ["a.pdf"]',
      "tags: []",
      "related: []",
      "---",
      "",
      "# Foo",
      "",
      "Old body statement one. New body statement two. Merged conclusion.",
    ].join("\n")
    const merger = vi.fn().mockResolvedValue(mergedPage)

    const result = await writeFileBlocks(
      projectPath,
      block("wiki/entities/foo.md", INCOMING),
      LLM_CONFIG,
      undefined,
      "b.pdf",
      undefined,
      undefined,
      undefined,
      { merger },
    )

    expect(result.writtenPaths).toEqual(["wiki/entities/foo.md"])
    expect(merger).toHaveBeenCalledTimes(1)
    const [existingArg, incomingArg, sourceArg] = merger.mock.calls[0]
    expect(existingArg).toBe(EXISTING_MULTI_SOURCE)
    // The merger receives the array-field-unioned incoming content.
    expect(incomingArg).toContain("New body statement two.")
    expect(sourceArg).toBe("b.pdf")

    const onDisk = await readProject("wiki/entities/foo.md")
    expect(onDisk).toContain("Old body statement one. New body statement two. Merged conclusion.")
    // Locked fields forced back to the existing values.
    expect(onDisk).toContain("title: Foo")
    expect(onDisk).not.toContain("Foo Merged")
    expect(onDisk).toContain("created: 2025-01-01")
    // Unioned sources survive the LLM's subset + post-merge canonicalization.
    expect(onDisk).toContain("a.pdf")
    expect(onDisk).toContain("b-old.pdf")
    expect(onDisk).toContain("b.pdf")
    expect(onDisk).toMatch(/updated: \d{4}-\d{2}-\d{2}/)
  })

  it("replaces the body without the merger when the page is owned solely by the source", async () => {
    const existingSingleSource = [
      "---",
      "type: entity",
      "title: Foo",
      "created: 2025-01-01",
      'sources: ["b.pdf"]',
      "---",
      "",
      "# Foo",
      "",
      "Obsolete wording from the old version of the source.",
    ].join("\n")
    await writeProject("wiki/entities/foo.md", existingSingleSource)

    const incoming = [
      "---",
      "type: entity",
      "title: Foo",
      'sources: ["b.pdf"]',
      "---",
      "",
      "# Foo",
      "",
      "Corrected wording from the fixed source.",
    ].join("\n")

    const merger = vi.fn()
    const result = await writeFileBlocks(
      projectPath,
      block("wiki/entities/foo.md", incoming),
      LLM_CONFIG,
      undefined,
      "b.pdf",
      undefined,
      undefined,
      undefined,
      { merger },
    )

    expect(result.writtenPaths).toEqual(["wiki/entities/foo.md"])
    expect(merger).not.toHaveBeenCalled()

    const onDisk = await readProject("wiki/entities/foo.md")
    expect(onDisk).toContain("Corrected wording from the fixed source.")
    expect(onDisk).not.toContain("Obsolete wording")
    expect(onDisk).toContain("created: 2025-01-01")

    // The replace path takes a recovery backup.
    const backups = await readdir(path.join(projectPath, ".llm-wiki/page-history"))
    expect(backups).toHaveLength(1)
    expect(await readProject(`.llm-wiki/page-history/${backups[0]}`)).toBe(existingSingleSource)
  })

  it("falls back to incoming body + array union and backs up when the merger throws", async () => {
    await writeProject("wiki/entities/foo.md", EXISTING_MULTI_SOURCE)
    const merger = vi.fn().mockRejectedValue(new Error("llm down"))

    const result = await writeFileBlocks(
      projectPath,
      block("wiki/entities/foo.md", INCOMING),
      LLM_CONFIG,
      undefined,
      "b.pdf",
      undefined,
      undefined,
      undefined,
      { merger },
    )

    expect(result.writtenPaths).toEqual(["wiki/entities/foo.md"])
    const onDisk = await readProject("wiki/entities/foo.md")
    expect(onDisk).toContain("New body statement two.")
    expect(onDisk).toContain("a.pdf")
    expect(onDisk).toContain("b.pdf")

    const backups = await readdir(path.join(projectPath, ".llm-wiki/page-history"))
    expect(backups).toHaveLength(1)
  })
})

// ── writeFileBlocks: aggregate skip ──────────────────────────────

describe("writeFileBlocks — app-managed aggregate skip", () => {
  it("ignores model-generated aggregate pages with the exact client warning", async () => {
    const text = [
      block("wiki/index.md", "# Index\n\nmodel wrote this"),
      "",
      block("wiki/overview.md", "# Overview\n\nmodel wrote this"),
    ].join("\n")

    const result = await writeFileBlocks(
      projectPath, text, LLM_CONFIG, undefined, "doc.pdf",
    )

    expect(result.writtenPaths).toEqual([])
    expect(result.warnings).toEqual([
      'Ignored model-generated "wiki/index.md"; aggregate navigation is maintained by the application.',
      'Ignored model-generated "wiki/overview.md"; aggregate navigation is maintained by the application.',
    ])
    expect(await projectFileExists("wiki/index.md")).toBe(false)
    expect(await projectFileExists("wiki/overview.md")).toBe(false)
  })
})

// ── writeFileBlocks: language guard ──────────────────────────────

describe("writeFileBlocks — language guard", () => {
  it("drops a concept page whose body contradicts the target language", async () => {
    const englishPage = [
      "---",
      "type: concept",
      "title: Foo",
      'sources: ["doc.pdf"]',
      "---",
      "",
      "# Foo",
      "",
      "This is an entirely English body with plenty of Latin characters to detect.",
    ].join("\n")

    const result = await writeFileBlocks(
      projectPath,
      block("wiki/concepts/foo.md", englishPage),
      LLM_CONFIG,
      "Chinese",
      "doc.pdf",
    )

    expect(result.writtenPaths).toEqual([])
    expect(result.warnings).toEqual([
      'Dropped "wiki/concepts/foo.md" — body language doesn\'t match target Chinese.',
    ])
    expect(await projectFileExists("wiki/concepts/foo.md")).toBe(false)
  })

  it("keeps and renames a concept page written in the target CJK language", async () => {
    const chinesePage = [
      "---",
      "type: concept",
      "title: 脱氮除磷",
      'sources: ["doc.pdf"]',
      "---",
      "",
      "# 脱氮除磷",
      "",
      "这是一个关于脱氮除磷工艺的概念页面，包含足够的中文内容用于语言检测。",
    ].join("\n")

    const result = await writeFileBlocks(
      projectPath,
      block("wiki/concepts/nitrogen-removal.md", chinesePage),
      LLM_CONFIG,
      "Chinese",
      "doc.pdf",
    )

    expect(result.writtenPaths).toEqual(["wiki/concepts/脱氮除磷.md"])
    expect(result.completedInputPaths).toEqual(["wiki/concepts/nitrogen-removal.md"])
    expect(await projectFileExists("wiki/concepts/脱氮除磷.md")).toBe(true)
  })
})

// ── writeFileBlocks: wiki-schema routing ─────────────────────────

describe("writeFileBlocks — wiki-schema routing drop", () => {
  it("drops pages whose frontmatter type disagrees with schema routing", async () => {
    await writeProject(
      "schema.md",
      [
        "# Wiki Schema",
        "",
        "## Page Types",
        "",
        "| Type | Directory | Purpose |",
        "| ---- | --------- | ------- |",
        "| source | wiki/sources/ | Source summaries |",
        "| concept | wiki/concepts/ | Ideas |",
      ].join("\n"),
    )

    const wrongPlace = [
      "---",
      "type: source",
      "title: Wrong Place",
      'sources: ["schema-routing.md"]',
      "tags: []",
      "related: []",
      "---",
      "",
      "# Wrong Place",
    ].join("\n")

    const result = await writeFileBlocks(
      projectPath,
      block("wiki/concepts/wrong-place.md", wrongPlace),
      LLM_CONFIG,
      undefined,
      "schema-routing.md",
    )

    expect(result.writtenPaths).toEqual([])
    expect(result.warnings).toEqual([
      'Dropped "wiki/concepts/wrong-place.md" — Page type "source" must be under "wiki/sources/". Current directory: "wiki/concepts".',
    ])
    expect(await projectFileExists("wiki/concepts/wrong-place.md")).toBe(false)
  })
})

// ── writeFileBlocks: hard failures ───────────────────────────────

describe("writeFileBlocks — hard failure accounting", () => {
  it("captures FS-level write errors without aborting the run", async () => {
    // A regular FILE at wiki/ makes directory creation (and thus the
    // write) fail with ENOTDIR — the OS rejects the path.
    await writeFile(path.join(projectPath, "wiki"), "blocker", "utf8")

    const result = await writeFileBlocks(
      projectPath,
      block("wiki/concepts/x.md", ENTITY_PAGE),
      LLM_CONFIG,
      undefined,
      "doc.pdf",
    )

    expect(result.writtenPaths).toEqual([])
    expect(result.hardFailures).toEqual(["wiki/concepts/x.md"])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/^Failed to write "wiki\/concepts\/x\.md": /)
  })
})

// ── writeFileBlocks: sourceSummaryPath substitution ──────────────

describe("writeFileBlocks — sourceSummaryPath substitution", () => {
  it("redirects any wiki/sources/ block to the canonical slug and rewrites media refs", async () => {
    const summaryPage = [
      "---",
      "type: source",
      "title: Source: doc.pdf",
      'sources: ["doc.pdf"]',
      "---",
      "",
      "# Source: doc.pdf",
      "",
      "![img](media/doc/img.png)",
    ].join("\n")

    const result = await writeFileBlocks(
      projectPath,
      block("wiki/sources/whatever-the-model-picked.md", summaryPage),
      LLM_CONFIG,
      undefined,
      "doc.pdf",
      "wiki/sources/3-doc--9eym4.md",
    )

    expect(result.writtenPaths).toEqual(["wiki/sources/3-doc--9eym4.md"])
    expect(result.completedInputPaths).toEqual(["wiki/sources/whatever-the-model-picked.md"])
    expect(await projectFileExists("wiki/sources/whatever-the-model-picked.md")).toBe(false)

    const onDisk = await readProject("wiki/sources/3-doc--9eym4.md")
    expect(onDisk).toContain("![img](../media/doc/img.png)")
  })
})

// ── writeFileBlocks: abort + truncation accounting ───────────────

describe("writeFileBlocks — abort and truncation", () => {
  it("rejects with the cancellation error before writing when already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      writeFileBlocks(
        projectPath,
        block("wiki/entities/foo.md", ENTITY_PAGE),
        LLM_CONFIG,
        undefined,
        "doc.pdf",
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("Ingest cancelled")

    expect(await projectFileExists("wiki/entities/foo.md")).toBe(false)
  })

  it("surfaces truncated FILE blocks via warnings and truncatedPaths", async () => {
    const text = "---FILE: wiki/concepts/big.md---\npartial content that never closes"

    const result = await writeFileBlocks(
      projectPath, text, LLM_CONFIG, undefined, "doc.pdf",
    )

    expect(result.writtenPaths).toEqual([])
    expect(result.truncatedPaths).toEqual(["wiki/concepts/big.md"])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(
      'FILE block "wiki/concepts/big.md" was not closed before end of stream',
    )
  })
})
