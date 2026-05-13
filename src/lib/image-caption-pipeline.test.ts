/**
 * Unit coverage for the caption pipeline. Mocks `captionImage` and
 * the fs commands so we can pin the cache + rewrite logic without
 * touching either the LLM or the filesystem.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockCaption, mockReadBase64, mockReadFile, mockWriteFile, mockFileExists, mockCreateDir } =
  vi.hoisted(() => ({
    mockCaption: vi.fn(),
    mockReadBase64: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockFileExists: vi.fn(),
    mockCreateDir: vi.fn(),
  }))

vi.mock("@/lib/vision-caption", () => ({
  captionImage: mockCaption,
}))

vi.mock("@/commands/fs", () => ({
  readFile: (p: string) => mockReadFile(p),
  writeFile: (p: string, c: string) => mockWriteFile(p, c),
  fileExists: (p: string) => mockFileExists(p),
  createDirectory: (p: string) => mockCreateDir(p),
  readFileAsBase64: (p: string) => mockReadBase64(p),
}))

import { captionMarkdownImages, __test } from "./image-caption-pipeline"
import type { LlmConfig } from "@/stores/wiki-store"

const cfg: LlmConfig = {
  provider: "custom",
  apiKey: "",
  model: "vl-test",
  ollamaUrl: "",
  customEndpoint: "http://example/v1",
  apiMode: "chat_completions",
  maxContextSize: 8192,
}

beforeEach(() => {
  mockCaption.mockReset()
  mockReadBase64.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockFileExists.mockReset()
  mockCreateDir.mockReset()
  // Default: no cache file present, no images to read.
  mockFileExists.mockResolvedValue(false)
  mockCreateDir.mockResolvedValue(undefined)
  mockWriteFile.mockResolvedValue(undefined)
})

describe("findImageReferences (helper)", () => {
  it("captures markdown image syntax with position info", () => {
    const refs = __test.findImageReferences("text\n![](a.png)\n![label](b.jpg) more")
    expect(refs).toEqual([
      { full: "![](a.png)", alt: "", url: "a.png", index: 5, length: 10 },
      { full: "![label](b.jpg)", alt: "label", url: "b.jpg", index: 16, length: 15 },
    ])
  })

  it("ignores links and HTML img", () => {
    const refs = __test.findImageReferences("[link](url) <img src=foo.png /> ![real](z.png)")
    expect(refs).toHaveLength(1)
    expect(refs[0].url).toBe("z.png")
  })
})

describe("captionMarkdownImages", () => {
  it("returns input unchanged when there are no image references", async () => {
    const out = await captionMarkdownImages("/proj", "no images here", cfg)
    expect(out.enrichedMarkdown).toBe("no images here")
    expect(out.freshCaptions).toBe(0)
    expect(out.cachedCaptions).toBe(0)
    expect(mockCaption).not.toHaveBeenCalled()
  })

  it("captions a fresh image, rewrites alt text, persists cache", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("a red square")

    const md = "Before\n\n![](/abs/img-1.png)\n\nAfter"
    const out = await captionMarkdownImages("/proj", md, cfg)

    expect(out.freshCaptions).toBe(1)
    expect(out.cachedCaptions).toBe(0)
    expect(out.enrichedMarkdown).toBe(
      "Before\n\n![a red square](/abs/img-1.png)\n\nAfter",
    )

    expect(mockCaption).toHaveBeenCalledTimes(1)
    expect(mockCaption).toHaveBeenCalledWith(
      "AAAA",
      "image/png",
      cfg,
      undefined,
      // Pipeline always passes a context options object, even when
      // both sides are empty (image at start/end of doc).
      expect.objectContaining({ contextBefore: expect.any(String), contextAfter: expect.any(String) }),
    )

    // Cache file written exactly once at the end of the batch.
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const [cachePath, contents] = mockWriteFile.mock.calls[0] as [string, string]
    expect(cachePath).toBe("/proj/.llm-wiki/image-caption-cache.json")
    const written = JSON.parse(contents)
    const entries = Object.values(written) as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      caption: "a red square",
      mimeType: "image/png",
      model: "vl-test",
    })
  })

  it("dedupes by SHA-256: two refs to the same bytes → one LLM call, both rewritten", async () => {
    // Both URLs return the same base64 bytes — same hash → single
    // caption call, both alt-texts populated.
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("the logo")

    const md = "![](/a/logo.png) and ![](/b/logo-copy.png)"
    const out = await captionMarkdownImages("/proj", md, cfg)

    // Two reads, ONE caption call, both refs rewritten.
    expect(mockReadBase64).toHaveBeenCalledTimes(2)
    expect(mockCaption).toHaveBeenCalledTimes(1)
    expect(out.freshCaptions).toBe(1)
    expect(out.enrichedMarkdown).toBe(
      "![the logo](/a/logo.png) and ![the logo](/b/logo-copy.png)",
    )
  })

  it("uses cached caption when SHA-256 hash matches", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })

    // Pre-populate the cache file. Hash of base64-decoded "AAAA"
    // (bytes 0,0,0): we compute it via the same helper to keep
    // the test deterministic and decoupled from a literal hash.
    const knownHash = await __test.sha256OfBase64("AAAA")
    const cacheJson = {
      [knownHash]: {
        caption: "previously captioned",
        mimeType: "image/png",
        model: "vl-old",
        capturedAt: "2026-01-01T00:00:00Z",
      },
    }
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(JSON.stringify(cacheJson))

    const md = "![](/abs/x.png)"
    const out = await captionMarkdownImages("/proj", md, cfg)

    expect(out.cachedCaptions).toBe(1)
    expect(out.freshCaptions).toBe(0)
    expect(mockCaption).not.toHaveBeenCalled()
    expect(out.enrichedMarkdown).toBe("![previously captioned](/abs/x.png)")
    // Cache wasn't grown → no write.
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it("sanitizes captions: strips newlines and replaces ] with )", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("line1\nline2 with ] bracket")

    const md = "![](/abs/x.png)"
    const out = await captionMarkdownImages("/proj", md, cfg)

    expect(out.enrichedMarkdown).toBe("![line1 line2 with ) bracket](/abs/x.png)")
  })

  it("continues batch when one caption call fails, reporting failed count", async () => {
    mockReadBase64.mockImplementation(async (p: string) => {
      if (p === "/abs/a.png") return { base64: "AAAA", mimeType: "image/png" }
      return { base64: "BBBB", mimeType: "image/png" }
    })
    mockCaption.mockImplementation(async (b64: string) => {
      if (b64 === "AAAA") return "first"
      throw new Error("HTTP 500")
    })

    const md = "![](/abs/a.png) ![](/abs/b.png)"
    const out = await captionMarkdownImages("/proj", md, cfg)

    expect(out.freshCaptions).toBe(1)
    expect(out.failed).toBe(1)
    // Successful one rewritten, failing one keeps original empty alt.
    expect(out.enrichedMarkdown).toBe("![first](/abs/a.png) ![](/abs/b.png)")
  })

  it("respects shouldCaption filter: skips URLs that don't match", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("c")

    const md = "![](/wanted/img.png) ![](https://external.example/foo.png)"
    const out = await captionMarkdownImages("/proj", md, cfg, {
      shouldCaption: (url) => url.startsWith("/wanted/"),
    })

    expect(mockReadBase64).toHaveBeenCalledTimes(1)
    expect(mockReadBase64).toHaveBeenCalledWith("/wanted/img.png")
    expect(out.enrichedMarkdown).toBe(
      "![c](/wanted/img.png) ![](https://external.example/foo.png)",
    )
  })

  it("uses urlToAbsPath hook when provided", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("c")

    const md = "![](media/foo/img-1.png)"
    await captionMarkdownImages("/proj", md, cfg, {
      urlToAbsPath: (url) => `/custom/anchor/${url}`,
    })

    expect(mockReadBase64).toHaveBeenCalledWith("/custom/anchor/media/foo/img-1.png")
  })

  it("resolves raw/assets project-relative URLs by default", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("c")

    await captionMarkdownImages("/proj", "![](raw/assets/foo/img-1.png)", cfg)

    expect(mockReadBase64).toHaveBeenCalledWith("/proj/raw/assets/foo/img-1.png")
  })

  it("forwards AbortSignal to captionImage", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("c")

    const ctl = new AbortController()
    await captionMarkdownImages("/proj", "![](/abs/x.png)", cfg, {
      signal: ctl.signal,
    })
    expect(mockCaption).toHaveBeenCalledWith(
      "AAAA",
      "image/png",
      cfg,
      ctl.signal,
      expect.objectContaining({ contextBefore: expect.any(String), contextAfter: expect.any(String) }),
    )
  })

  it("recovers from corrupt cache JSON (logs and starts fresh)", async () => {
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue("{ this is not valid JSON")
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("ok")

    const out = await captionMarkdownImages("/proj", "![](/abs/x.png)", cfg)
    expect(out.enrichedMarkdown).toBe("![ok](/abs/x.png)")
    expect(out.freshCaptions).toBe(1)
  })

  it("respects concurrency limit — three caption calls dispatch in parallel when concurrency=3", async () => {
    // Need three distinct valid base64 strings so each image
    // hashes to a unique cache key (otherwise dedupe collapses
    // to one call). `atob` requires legal base64 — `AQ==` /
    // `Ag==` / `Aw==` are bytes 0x01, 0x02, 0x03 respectively.
    const b64ByPath: Record<string, string> = {
      "/abs/a.png": "AQ==",
      "/abs/b.png": "Ag==",
      "/abs/c.png": "Aw==",
    }
    mockReadBase64.mockImplementation(async (p: string) => ({
      base64: b64ByPath[p] ?? "AAAA",
      mimeType: "image/png",
    }))
    let inFlight = 0
    let peakInFlight = 0
    mockCaption.mockImplementation(async (b64: string) => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      // Yield one microtask boundary so the worker pool spins up
      // additional tasks before this one resolves.
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return `cap-${b64}`
    })

    const md = "![](/abs/a.png) ![](/abs/b.png) ![](/abs/c.png)"
    const out = await captionMarkdownImages("/proj", md, cfg, { concurrency: 3 })

    expect(out.freshCaptions).toBe(3)
    // With concurrency=3 and ALL three workers spawned before any
    // resolve, the peak should reach 3. We assert >=2 to leave
    // some slack for tight scheduler races but still detect
    // strictly-sequential regressions (peak would be 1).
    expect(peakInFlight).toBeGreaterThanOrEqual(2)
  })

  it("calls onProgress after each image with running counts", async () => {
    const b64ByPath: Record<string, string> = {
      "/abs/a.png": "AQ==",
      "/abs/b.png": "Ag==",
    }
    mockReadBase64.mockImplementation(async (p: string) => ({
      base64: b64ByPath[p] ?? "AAAA",
      mimeType: "image/png",
    }))
    mockCaption.mockResolvedValue("c")
    const progressCalls: Array<{ done: number; total: number }> = []

    const md = "![](/abs/a.png) ![](/abs/b.png)"
    await captionMarkdownImages("/proj", md, cfg, {
      onProgress: (done, total) => progressCalls.push({ done, total }),
    })

    expect(progressCalls).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ])
  })

  it("passes surrounding text as contextBefore / contextAfter to captionImage", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("c")

    // Image is sandwiched between recognizable before / after
    // markers so the slice content is easy to assert on.
    const before = "Figure 3: Quarterly revenue 2024 — preceding text. ".repeat(2)
    const after = " Following commentary about the chart. ".repeat(2)
    const md = `${before}![](/abs/x.png)${after}`

    await captionMarkdownImages("/proj", md, cfg)

    const args = mockCaption.mock.calls[0]
    const opts = args[4] as { contextBefore: string; contextAfter: string }
    expect(opts.contextBefore).toContain("Figure 3: Quarterly revenue 2024")
    expect(opts.contextAfter).toContain("Following commentary about the chart")
    // The image's own `![](url)` must NOT leak into either side
    // — slicing is by index/length, not by string match.
    expect(opts.contextBefore).not.toContain("![](/abs/x.png)")
    expect(opts.contextAfter).not.toContain("![](/abs/x.png)")
  })

  it("clamps context windows at document boundaries (no out-of-range read)", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("c")

    // Image at the very start: contextBefore must be empty string.
    // Image at the very end: contextAfter must be empty string.
    const md1 = "![](/abs/start.png) trailing text only"
    await captionMarkdownImages("/proj", md1, cfg)
    let opts = mockCaption.mock.calls[0][4] as { contextBefore: string; contextAfter: string }
    expect(opts.contextBefore).toBe("")
    expect(opts.contextAfter).toBe(" trailing text only")

    mockCaption.mockClear()

    const md2 = "leading text only ![](/abs/end.png)"
    await captionMarkdownImages("/proj", md2, cfg)
    opts = mockCaption.mock.calls[0][4] as { contextBefore: string; contextAfter: string }
    expect(opts.contextBefore).toBe("leading text only ")
    expect(opts.contextAfter).toBe("")
  })
})
