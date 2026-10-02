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

import {
  captionMarkdownImages,
  loadCaptionCache,
  stripMarkdownImageReferences,
  __test,
} from "./image-caption-pipeline"
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
      { full: "![](a.png)", alt: "", url: "a.png", destination: "a.png", index: 5, length: 10 },
      { full: "![label](b.jpg)", alt: "label", url: "b.jpg", destination: "b.jpg", index: 16, length: 15 },
    ])
  })

  it("ignores links and HTML img", () => {
    const refs = __test.findImageReferences("[link](url) <img src=foo.png /> ![real](z.png)")
    expect(refs).toHaveLength(1)
    expect(refs[0].url).toBe("z.png")
  })

  it("captures local image destinations containing spaces", () => {
    const refs = __test.findImageReferences(
      "![](assets/figure one.png) ![two](<assets/figure two.jpg>)",
    )

    expect(refs.map((ref) => ref.url)).toEqual([
      "assets/figure one.png",
      "assets/figure two.jpg",
    ])
  })

  it("handles parentheses, optional titles, encoded spaces, and empty destinations", () => {
    const refs = __test.findImageReferences([
      "![](media/Shot (1).png)",
      "![](<media/Shot (2).png> \"Screenshot\")",
      "![](media/figure%20three.png 'Figure')",
      "![]( )",
    ].join("\n"))

    expect(refs.map((ref) => ref.url)).toEqual([
      "media/Shot (1).png",
      "media/Shot (2).png",
      "media/figure three.png",
    ])
  })

  it("does not mistake a trailing parenthesized filename segment for a title", () => {
    const refs = __test.findImageReferences("![](media/Shot (1))")
    expect(refs[0]?.url).toBe("media/Shot (1)")
  })

  it("stops malformed image candidates at the current line", () => {
    const markdown = "![not an image\ntext\n![](real image.png)"
    const refs = __test.findImageReferences(markdown)
    expect(refs).toHaveLength(1)
    expect(refs[0].url).toBe("real image.png")
    expect(refs[0].index).toBe(markdown.indexOf("![]("))
  })

  it("does not join embeds or reference images to a later Markdown link", () => {
    const samples = [
      "See ![[a.png]] and [docs](https://x.test)",
      "![logo][1] then [link](https://x.test)",
      "x![citation needed] see [here](https://x.test)",
    ]
    for (const sample of samples) {
      expect(__test.findImageReferences(sample)).toEqual([])
      expect(stripMarkdownImageReferences(sample)).toBe(sample)
    }
  })

  it("normalizes encoded spaces and escaped parentheses for filesystem access", () => {
    const refs = __test.findImageReferences(
      "![](media/figure%20one.png) ![](media/figure\\)two.png)",
    )
    expect(refs.map((ref) => ref.url)).toEqual([
      "media/figure one.png",
      "media/figure)two.png",
    ])
  })
})

describe("stripMarkdownImageReferences", () => {
  it("strips titled and adjacent image references without touching malformed input", () => {
    expect(stripMarkdownImageReferences("a![](<x y.png> \"t\")![](z.png)b"))
      .toBe("a  b")
    expect(stripMarkdownImageReferences("![not](image"))
      .toBe("![not](image")
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

  it("captions and preserves an image destination containing spaces", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("a process diagram")

    const out = await captionMarkdownImages(
      "/proj",
      "![](<assets/process flow.png>)",
      cfg,
    )

    expect(mockReadBase64).toHaveBeenCalledWith("/proj/wiki/assets/process flow.png")
    expect(out.enrichedMarkdown).toBe(
      "![a process diagram](<assets/process flow.png>)",
    )
  })

  it("deduplicates equivalent plain and angle-bracket destinations", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("same image")

    const out = await captionMarkdownImages(
      "/proj",
      "![](assets/figure one.png)\n![](<assets/figure one.png>)",
      cfg,
    )

    expect(mockCaption).toHaveBeenCalledTimes(1)
    expect(out.enrichedMarkdown).toBe(
      "![same image](assets/figure one.png)\n![same image](<assets/figure one.png>)",
    )
  })

  it("forwards outputLanguage to captionImage", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("ein rotes Quadrat")

    await captionMarkdownImages("/proj", "![](/abs/img-1.png)", cfg, {
      outputLanguage: "German",
    })

    expect(mockCaption).toHaveBeenCalledWith(
      "AAAA",
      "image/png",
      cfg,
      undefined,
      expect.objectContaining({ outputLanguage: "German" }),
    )
  })

  it("does not reuse a caption cached for a different output language", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    mockCaption.mockResolvedValue("ein rotes Quadrat")
    const knownHash = await __test.sha256OfBase64("AAAA")
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(JSON.stringify({
      [knownHash]: {
        caption: "a red square",
        mimeType: "image/png",
        model: "vl-old",
        capturedAt: "2026-01-01T00:00:00Z",
      },
    }))

    const out = await captionMarkdownImages("/proj", "![](/abs/img-1.png)", cfg, {
      outputLanguage: "German",
    })

    expect(out.freshCaptions).toBe(1)
    expect(out.cachedCaptions).toBe(0)
    expect(mockCaption).toHaveBeenCalledTimes(1)
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string)
    expect(written[__test.captionCacheKey(knownHash, "German")]).toMatchObject({
      caption: "ein rotes Quadrat",
      imageHash: knownHash,
      outputLanguage: "German",
    })
  })

  it("reuses a caption cached for the same output language", async () => {
    mockReadBase64.mockResolvedValue({ base64: "AAAA", mimeType: "image/png" })
    const knownHash = await __test.sha256OfBase64("AAAA")
    const key = __test.captionCacheKey(knownHash, "German")
    mockFileExists.mockResolvedValue(true)
    mockReadFile.mockResolvedValue(JSON.stringify({
      [key]: {
        caption: "ein rotes Quadrat",
        mimeType: "image/png",
        model: "vl-old",
        capturedAt: "2026-01-01T00:00:00Z",
        imageHash: knownHash,
        outputLanguage: "German",
      },
    }))

    const out = await captionMarkdownImages("/proj", "![](/abs/img-1.png)", cfg, {
      outputLanguage: "german",
    })

    expect(out.cachedCaptions).toBe(1)
    expect(out.freshCaptions).toBe(0)
    expect(mockCaption).not.toHaveBeenCalled()
    expect(out.enrichedMarkdown).toContain("![ein rotes Quadrat]")
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

  it("skips Codex CLI captioning once before reading image bytes", async () => {
    const out = await captionMarkdownImages("/proj", "![](/abs/a.png)\n![](/abs/b.png)", {
      ...cfg,
      provider: "codex-cli",
    })

    expect(out.enrichedMarkdown).toBe("![](/abs/a.png)\n![](/abs/b.png)")
    expect(out.failed).toBe(2)
    expect(mockReadBase64).not.toHaveBeenCalled()
    expect(mockCaption).not.toHaveBeenCalled()
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

describe("loadCaptionCache", () => {
  it("selects the newest caption per image when no language is requested", async () => {
    const knownHash = await __test.sha256OfBase64("AAAA")
    const germanKey = __test.captionCacheKey(knownHash, "German")
    mockFileExists.mockResolvedValue(true)
    // Put the legacy entry last to prove selection does not depend on JSON key order.
    mockReadFile.mockResolvedValue(JSON.stringify({
      [germanKey]: {
        caption: "neue Beschreibung",
        mimeType: "image/png",
        model: "vl-new",
        capturedAt: "2026-08-18T00:00:00Z",
        imageHash: knownHash,
        outputLanguage: "German",
      },
      [knownHash]: {
        caption: "old description",
        mimeType: "image/png",
        model: "vl-old",
        capturedAt: "2026-01-01T00:00:00Z",
      },
    }))

    const captions = await loadCaptionCache("/proj")

    expect(captions.get(knownHash)).toBe("neue Beschreibung")
  })
})
