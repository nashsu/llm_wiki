// Server-port tests for ingest/images.js — ported from
// src/lib/extract-source-images.test.ts plus coverage for the ingest.ts
// image regions (memoized extraction, MinerU saved images, caption gating,
// safety-net injection) and the extractImages worker task.
//
// All filesystem work happens inside mkdtemp project dirs that are removed
// afterwards. Image fixtures are a real 1x1 PNG written from a base64
// constant and a real .docx built with jszip. LLM fetches are mocked.

import JSZip from "jszip"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { extractImageCommands } from "../src/commands/extractImages.js"
import { workerTasks } from "../src/workers/tasks.js"
import {
  appendSavedImageRefsForCaption,
  applyCaptionGatingToSourceContent,
  buildImageMarkdownSection,
  extractAndSaveMarkdownImages,
  extractAndSaveSourceImages,
  extractSourceImagesOnce,
  findLocalMarkdownImageRefs,
  hasMineruImageRefs,
  injectImagesIntoSourceSummary,
  promptImageUrlToAbs,
  isSavedImagePromptUrl,
  resolveCaptionConfig,
  savedImagesFromMineruMarkdown,
  sourceSummaryMediaRefsForExternalMarkdown,
  stripWikiMediaAbsPaths,
  toSourceSummaryImageRef,
} from "../src/ingest/images.js"

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, "base64")
const PNG_1X1_SHA256 = createHash("sha256").update(PNG_1X1).digest("hex")

const enc = new TextEncoder()

function sseBody(lines) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(lines.map((l) => `data: ${l}\n\n`).join("")))
      controller.close()
    },
  })
}

function openAiCaptionSseResponse(text) {
  const lines = [
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "[DONE]",
  ]
  return { ok: true, status: 200, body: sseBody(lines), text: async () => "", json: async () => ({}) }
}

const tmpDirs = []
let project

function makeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), "llmwiki-images-"))
  tmpDirs.push(dir)
  return dir
}

function writePng(absPath) {
  mkdirSync(path.dirname(absPath), { recursive: true })
  writeFileSync(absPath, PNG_1X1)
}

beforeEach(() => {
  project = makeProject()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

async function makeDocxWithImage(docxPath, mediaName = "image1.png") {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", "<?xml version=\"1.0\"?><Types></Types>")
  zip.file(`word/media/${mediaName}`, PNG_1X1)
  const bytes = await zip.generateAsync({ type: "nodebuffer" })
  writeFileSync(docxPath, bytes)
}

// ── findLocalMarkdownImageRefs (ported from extract-source-images.test.ts) ──

describe("findLocalMarkdownImageRefs", () => {
  it("extracts Obsidian and markdown local image references", () => {
    const refs = findLocalMarkdownImageRefs(`
![[attachments/chart.png]]
![Figure](images/plot%201.jpg "title")
![Remote](https://example.com/a.png)
![[attachments/chart.png|400]]
`)
    expect(refs).toEqual(["attachments/chart.png", "images/plot 1.jpg"])
  })

  it("ignores non-image links and remote/data references", () => {
    const refs = findLocalMarkdownImageRefs(`
![Doc](notes/page.md)
![Data](data:image/png;base64,abc)
![[draft.txt]]
`)
    expect(refs).toEqual([])
  })
})

// ── extraction orchestration against a tmp project dir ──

describe("extractAndSaveMarkdownImages", () => {
  it("copies referenced local images into wiki/media/<slug>/", async () => {
    const srcDir = path.join(project, "raw", "sources")
    await mkdir(srcDir, { recursive: true })
    await mkdir(path.join(srcDir, "attachments"), { recursive: true })
    writeFileSync(path.join(srcDir, "attachments", "chart.png"), PNG_1X1)
    const sourcePath = path.join(srcDir, "notes.md")
    writeFileSync(sourcePath, "# Notes\n\n![[attachments/chart.png]]\n")

    const markdown = "![[attachments/chart.png]]"
    const images = await extractAndSaveMarkdownImages(project, sourcePath, markdown)

    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({
      index: 1,
      mimeType: "image/png",
      page: null,
      width: 0,
      height: 0,
      relPath: "media/notes/001-chart.png",
      absPath: `${project}/wiki/media/notes/001-chart.png`,
      sha256: PNG_1X1_SHA256,
    })
    expect(readFileSync(images[0].absPath).equals(PNG_1X1)).toBe(true)
  })

  it("returns [] when the markdown has no local image refs", async () => {
    const sourcePath = path.join(project, "doc.md")
    writeFileSync(sourcePath, "text only")
    const images = await extractAndSaveMarkdownImages(project, sourcePath, "no images ![x](https://e.test/a.png)")
    expect(images).toEqual([])
  })
})

describe("extractAndSaveSourceImages", () => {
  it("extracts DOCX media via extractImageCommands and honors the camelCase wire shape", async () => {
    const docxPath = path.join(project, "raw", "sources", "deck.docx")
    await mkdir(path.dirname(docxPath), { recursive: true })
    await makeDocxWithImage(docxPath)

    const images = await extractAndSaveSourceImages(project, docxPath)

    // The wire-shape warning in extract-source-images.ts: the filter keeps
    // items only when index is a number and relPath/absPath are camelCase
    // strings. A casing regression would surface here as an empty array
    // even though extraction wrote files to disk.
    expect(images).toHaveLength(1)
    const img = images[0]
    expect(typeof img.index).toBe("number")
    expect(typeof img.relPath).toBe("string")
    expect(typeof img.absPath).toBe("string")
    expect(img.relPath).toBe("media/deck/000-image1.png")
    expect(img.absPath).toBe(`${project}/wiki/media/deck/000-image1.png`)
    expect(img.mimeType).toBe("image/png")
    expect(img.sha256).toBe(PNG_1X1_SHA256)
    expect(existsSync(img.absPath)).toBe(true)
  })

  it("returns [] for unsupported file types without dispatching", async () => {
    const txtPath = path.join(project, "notes.txt")
    writeFileSync(txtPath, "hello")
    const images = await extractAndSaveSourceImages(project, txtPath)
    expect(images).toEqual([])
  })

  it("uses the slug override for the destination directory", async () => {
    const docxPath = path.join(project, "deck.docx")
    await makeDocxWithImage(docxPath)
    const images = await extractAndSaveSourceImages(project, docxPath, "sub/deck")
    expect(images).toHaveLength(1)
    expect(images[0].relPath).toBe("media/sub/deck/000-image1.png")
    expect(existsSync(`${project}/wiki/media/sub/deck/000-image1.png`)).toBe(true)
  })

  it("returns [] and warns when extraction throws", async () => {
    const spy = vi.spyOn(extractImageCommands, "extract_and_save_office_images_cmd")
      .mockRejectedValueOnce(new Error("boom"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const docxPath = path.join(project, "broken.docx")
      await makeDocxWithImage(docxPath)
      const images = await extractAndSaveSourceImages(project, docxPath)
      expect(images).toEqual([])
      expect(warn).toHaveBeenCalledWith(
        `[ingest:images] extraction failed for "broken.docx":`,
        "boom",
      )
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })
})

describe("extractSourceImagesOnce memoization", () => {
  it("runs extraction once for concurrent calls with the same key", async () => {
    const spy = vi.spyOn(extractImageCommands, "extract_and_save_office_images_cmd")
    try {
      const docxPath = path.join(project, "memo.docx")
      await makeDocxWithImage(docxPath)

      const [a, b] = await Promise.all([
        extractSourceImagesOnce(project, docxPath, "memo"),
        extractSourceImagesOnce(project, docxPath, "memo"),
      ])

      expect(a).toEqual(b)
      expect(a).toHaveLength(1)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})

// ── buildImageMarkdownSection ──

describe("buildImageMarkdownSection", () => {
  it("returns empty string with no images", () => {
    expect(buildImageMarkdownSection([])).toBe("")
  })

  it("groups by page with Document last and uses captions by sha256", () => {
    const images = [
      { index: 1, mimeType: "image/png", page: null, width: 0, height: 0, relPath: "media/d/000-a.png", absPath: "/x/a.png", sha256: "hash-a" },
      { index: 2, mimeType: "image/png", page: 5, width: 0, height: 0, relPath: "media/d/001-b.png", absPath: "/x/b.png", sha256: "hash-b" },
      { index: 3, mimeType: "image/png", page: 2, width: 0, height: 0, relPath: "media/d/002-c.png", absPath: "/x/c.png", sha256: "hash-c" },
    ]
    const captions = new Map([
      ["hash-b", "Revenue chart [2024]\nwith newline"],
    ])
    const section = buildImageMarkdownSection(images, captions)
    expect(section).toBe([
      "",
      "",
      "## Embedded Images",
      "",
      "### Page 2",
      "",
      "![](media/d/002-c.png)",
      "",
      "### Page 5",
      "",
      // sanitize(): newlines collapse to spaces, `]` → `)` (no `]` may
      // survive inside alt text).
      "![Revenue chart [2024) with newline](media/d/001-b.png)",
      "",
      "### Document",
      "",
      "![](media/d/000-a.png)",
      "",
    ].join("\n"))
  })
})

// ── ingest.ts image regions ──

describe("appendSavedImageRefsForCaption", () => {
  it("appends a Referenced Local Images section", () => {
    const out = appendSavedImageRefsForCaption("Body", [
      { relPath: "media/s/000-a.png" },
      { relPath: "media/s/001-b.png" },
    ])
    expect(out).toBe("Body\n\n## Referenced Local Images\n\n![](media/s/000-a.png)\n![](media/s/001-b.png)\n")
  })

  it("returns content unchanged when there are no images", () => {
    expect(appendSavedImageRefsForCaption("Body", [])).toBe("Body")
  })
})

describe("savedImagesFromMineruMarkdown", () => {
  it("recovers SavedImage metadata for MinerU images already on disk", async () => {
    const mediaDir = path.join(project, "wiki", "media", "paper", "mineru", "images")
    await mkdir(mediaDir, { recursive: true })
    writeFileSync(path.join(mediaDir, "chart.png"), PNG_1X1)

    const markdown = [
      "![Chart](media/paper/mineru/images/chart.png)",
      "![Missing](media/paper/mineru/images/missing.png)",
      "![External](https://example.test/x.png)",
    ].join("\n")

    const images = await savedImagesFromMineruMarkdown(project, "paper", markdown)

    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({
      index: 1,
      mimeType: "image/png",
      page: null,
      width: 0,
      height: 0,
      relPath: "media/paper/mineru/images/chart.png",
      absPath: `${project}/wiki/media/paper/mineru/images/chart.png`,
      sha256: PNG_1X1_SHA256,
    })
  })

  it("matches percent-encoded mineru prefixes back to plain rel paths", async () => {
    const slug = "my paper" // encodes to "my%20paper"
    const mediaDir = path.join(project, "wiki", "media", slug, "mineru", "images")
    await mkdir(mediaDir, { recursive: true })
    writeFileSync(path.join(mediaDir, "chart.png"), PNG_1X1)

    const markdown = "![Chart](media/my%20paper/mineru/images/chart.png)"
    const images = await savedImagesFromMineruMarkdown(project, slug, markdown)

    expect(images).toHaveLength(1)
    expect(images[0].relPath).toBe("media/my paper/mineru/images/chart.png")
    expect(images[0].sha256).toBe(PNG_1X1_SHA256)
  })
})

describe("mineru ref helpers", () => {
  it("hasMineruImageRefs matches plain and encoded prefixes", () => {
    expect(hasMineruImageRefs("x media/paper/mineru/i.png y", "paper")).toBe(true)
    expect(hasMineruImageRefs("x media/my%20paper/mineru/i.png y", "my paper")).toBe(true)
    expect(hasMineruImageRefs("no images", "paper")).toBe(false)
  })

  it("toSourceSummaryImageRef rewrites media paths for wiki/sources pages", () => {
    expect(toSourceSummaryImageRef("media/s/i.png")).toBe("../media/s/i.png")
    expect(toSourceSummaryImageRef("./media/s/i.png")).toBe("../media/s/i.png")
    expect(toSourceSummaryImageRef("https://e.test/i.png")).toBe("https://e.test/i.png")
  })

  it("stripWikiMediaAbsPaths collapses absolute wiki media paths", () => {
    expect(stripWikiMediaAbsPaths("/proj", "see /proj/wiki/media/s/i.png")).toBe("see media/s/i.png")
  })

  it("sourceSummaryMediaRefsForExternalMarkdown rebases media refs", () => {
    expect(sourceSummaryMediaRefsForExternalMarkdown("](media/s/i.png)")).toBe("](../media/s/i.png)")
    expect(sourceSummaryMediaRefsForExternalMarkdown("](./media/s/i.png)")).toBe("](../media/s/i.png)")
    expect(sourceSummaryMediaRefsForExternalMarkdown('src="media/s/i.png"')).toBe('src="../media/s/i.png"')
  })

  it("prompt URL helpers anchor rel paths at the wiki root", () => {
    expect(isSavedImagePromptUrl("/proj", "s", "/proj/wiki/media/s/i.png")).toBe(true)
    expect(isSavedImagePromptUrl("/proj", "s", "media/s/i.png")).toBe(true)
    expect(isSavedImagePromptUrl("/proj", "s", "media/other/i.png")).toBe(false)
    expect(promptImageUrlToAbs("/proj", "media/s/i.png")).toBe("/proj/wiki/media/s/i.png")
    expect(promptImageUrlToAbs("/proj", "/abs/i.png")).toBe("/abs/i.png")
  })
})

describe("resolveCaptionConfig", () => {
  const mainLlm = { provider: "openai", apiKey: "sk-main", model: "gpt-4o", maxContextSize: 128_000 }

  it("returns null when multimodal is disabled", () => {
    expect(resolveCaptionConfig({ enabled: false }, mainLlm)).toBeNull()
  })

  it("uses the main LLM config when useMainLlm is set", () => {
    expect(resolveCaptionConfig({ enabled: true, useMainLlm: true }, mainLlm)).toBe(mainLlm)
  })

  it("projects dedicated multimodal fields into an LlmConfig shape", () => {
    const mm = {
      enabled: true,
      useMainLlm: false,
      provider: "custom",
      apiKey: "sk-mm",
      model: "vl-model",
      ollamaUrl: "",
      customEndpoint: "http://vl.local/v1",
      azureApiVersion: undefined,
      azureModelFamily: undefined,
      apiMode: "chat_completions",
      concurrency: 2,
    }
    expect(resolveCaptionConfig(mm, mainLlm)).toEqual({
      provider: "custom",
      apiKey: "sk-mm",
      model: "vl-model",
      ollamaUrl: "",
      customEndpoint: "http://vl.local/v1",
      azureApiVersion: undefined,
      azureModelFamily: undefined,
      apiMode: "chat_completions",
      maxContextSize: 128_000,
    })
  })
})

// ── caption gating (ingest.ts step 0.6 logic) ──

describe("applyCaptionGatingToSourceContent", () => {
  const savedImages = [{
    index: 1,
    mimeType: "image/png",
    page: null,
    width: 0,
    height: 0,
    relPath: "media/s/img.png",
    absPath: "",
    sha256: PNG_1X1_SHA256,
  }]

  it("strips image refs from sourceContent when multimodal is disabled", async () => {
    const out = await applyCaptionGatingToSourceContent(
      project,
      "A ![](media/s/img.png) B",
      savedImages,
      "s",
      { enabled: false },
      null,
    )
    expect(out).toBe("A   B")
  })

  it("appends refs without captioning when captioning is enabled but no caption LLM resolves", async () => {
    const out = await applyCaptionGatingToSourceContent(
      project,
      "Body",
      savedImages,
      "s",
      { enabled: true, concurrency: 1 },
      null,
    )
    expect(out).toBe("Body\n\n## Referenced Local Images\n\n![](media/s/img.png)\n")
  })

  it("captions extracted images through the mocked OpenAI wire and keeps user-typed refs untouched", async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("A red square."))
    vi.stubGlobal("fetch", fetchMock)

    const imgPath = path.join(project, "wiki", "media", "s", "img.png")
    await mkdir(path.dirname(imgPath), { recursive: true })
    writeFileSync(imgPath, PNG_1X1)

    const sourceContent = "Body ![User](https://example.com/foo.png)"
    const out = await applyCaptionGatingToSourceContent(
      project,
      sourceContent,
      savedImages,
      "s",
      { enabled: true, concurrency: 1 },
      { provider: "openai", apiKey: "sk-test", model: "gpt-4o" },
      { fileName: "s.pdf" },
    )

    expect(out).toContain("![A red square.](media/s/img.png)")
    expect(out).toContain("![User](https://example.com/foo.png)")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Caption cache was written as a side effect.
    const cacheRaw = readFileSync(path.join(project, ".llm-wiki", "image-caption-cache.json"), "utf8")
    const cache = JSON.parse(cacheRaw)
    expect(Object.keys(cache)).toEqual([PNG_1X1_SHA256])
    expect(cache[PNG_1X1_SHA256].caption).toBe("A red square.")
  })

  it("keeps empty-alt refs and never breaks ingest when caption calls fail", async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, body: null, text: async () => "boom" })
    vi.stubGlobal("fetch", fetchMock)

    const imgPath = path.join(project, "wiki", "media", "s", "img.png")
    await mkdir(path.dirname(imgPath), { recursive: true })
    writeFileSync(imgPath, PNG_1X1)

    const out = await applyCaptionGatingToSourceContent(
      project,
      "Body",
      savedImages,
      "s",
      { enabled: true, concurrency: 1 },
      { provider: "openai", apiKey: "sk-test", model: "gpt-4o" },
      { fileName: "s.pdf" },
    )

    // Captioning failure must NEVER break ingest — the enriched content
    // still carries the (empty-alt) image ref.
    expect(out).toBe("Body\n\n## Referenced Local Images\n\n![](media/s/img.png)\n")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ── injectImagesIntoSourceSummary ──

describe("injectImagesIntoSourceSummary", () => {
  const images = [{
    index: 1,
    mimeType: "image/png",
    page: 1,
    width: 0,
    height: 0,
    relPath: "media/deck/000-image1.png",
    absPath: "/ignored",
    sha256: PNG_1X1_SHA256,
  }]
  const marker = "<!-- llm-wiki:embedded-images -->"

  function summaryPath() {
    return path.join(project, "wiki", "sources", "deck.md")
  }

  it("appends a marker-bracketed section to an existing source summary", async () => {
    await mkdir(path.dirname(summaryPath()), { recursive: true })
    writeFileSync(summaryPath(), "# Deck\n\nSummary body")

    await injectImagesIntoSourceSummary(project, "deck.docx", "deck", images)

    const content = readFileSync(summaryPath(), "utf8")
    expect(content).toContain("# Deck\n\nSummary body")
    expect(content).toContain(marker)
    expect(content).toContain("![](../media/deck/000-image1.png)")
  })

  it("is idempotent — re-injection replaces instead of accumulating", async () => {
    await mkdir(path.dirname(summaryPath()), { recursive: true })
    writeFileSync(summaryPath(), "# Deck")

    await injectImagesIntoSourceSummary(project, "deck.docx", "deck", images)
    await injectImagesIntoSourceSummary(project, "deck.docx", "deck", images)

    const content = readFileSync(summaryPath(), "utf8")
    expect(content.split(marker).length - 1).toBe(2) // exactly one paired block
    expect(content.match(/!\[\]\(\.\.\/media\/deck\/000-image1\.png\)/g)).toHaveLength(1)
  })

  it("writes a stub source page when the summary is missing", async () => {
    await injectImagesIntoSourceSummary(project, "deck.docx", "deck", images)

    const content = readFileSync(summaryPath(), "utf8")
    expect(content).toContain("type: source")
    expect(content).toContain('title: "Source: deck.docx"')
    expect(content).toContain("# Source: deck.docx")
    expect(content).toContain(marker)
  })

  it("uses the caption cache for alt text in the safety-net section", async () => {
    await mkdir(path.join(project, ".llm-wiki"), { recursive: true })
    writeFileSync(
      path.join(project, ".llm-wiki", "image-caption-cache.json"),
      JSON.stringify({ [PNG_1X1_SHA256]: { caption: "The logo", mimeType: "image/png", model: "m", capturedAt: "2026-01-01T00:00:00Z" } }, null, 2),
    )

    await injectImagesIntoSourceSummary(project, "deck.docx", "deck", images)

    const content = readFileSync(summaryPath(), "utf8")
    expect(content).toContain("![The logo](../media/deck/000-image1.png)")
  })

  it("does nothing without images", async () => {
    await injectImagesIntoSourceSummary(project, "deck.docx", "deck", [])
    expect(existsSync(summaryPath())).toBe(false)
  })
})

// ── worker task ──

describe("workerTasks.extractImages", () => {
  it("dispatches {command, args} to extractImageCommands", async () => {
    const docxPath = path.join(project, "worker.docx")
    await makeDocxWithImage(docxPath)
    const destDir = path.join(project, "wiki", "media", "worker")
    const relTo = path.join(project, "wiki")

    const out = await workerTasks.extractImages({
      command: "extract_and_save_office_images_cmd",
      args: { sourcePath: docxPath, destDir, relTo },
    })

    expect(out).toHaveLength(1)
    expect(out[0].relPath).toBe("media/worker/000-image1.png")
    expect(out[0].sha256).toBe(PNG_1X1_SHA256)
  })

  it("rejects unknown commands", async () => {
    await expect(workerTasks.extractImages({ command: "constructor", args: {} }))
      .rejects.toThrow("Unknown image extraction command: constructor")
    await expect(workerTasks.extractImages({ command: "nope", args: {} }))
      .rejects.toThrow("Unknown image extraction command: nope")
  })
})
