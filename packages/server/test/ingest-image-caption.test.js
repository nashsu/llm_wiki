// Server-port tests for ingest/image-caption.js — ported from
// src/lib/image-caption-pipeline.test.ts.
//
// Adaptations (client → server):
//   • @/commands/fs mocks → REAL filesystem inside a mkdtemp project dir
//     (images are a tiny real PNG written from a base64 constant).
//   • vi.mock("@/lib/vision-caption") → mocked global fetch speaking the
//     OpenAI SSE wire (and one Anthropic-wire case), because captionImage is
//     folded into the caption module and calls streamChat from ingest/llm.js.
//   • captionImage call-shape assertions → assertions on the outbound
//     request body (multimodal content arrays on both wires).
// No network access: fetch is always mocked. Tmp dirs are cleaned up.

import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CAPTION_PROMPT,
  buildCaptionPromptWithContext,
  captionMarkdownImages,
  loadCaptionCache,
  __test,
} from "../src/ingest/image-caption.js"

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

function anthropicCaptionSseResponse(text) {
  const lines = [
    { type: "message_start" },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_stop" },
  ]
  return { ok: true, status: 200, body: sseBody(lines.map((l) => JSON.stringify(l))), text: async () => "", json: async () => ({}) }
}

const cfg = {
  provider: "custom",
  apiKey: "",
  model: "vl-test",
  ollamaUrl: "",
  customEndpoint: "http://example/v1",
  apiMode: "chat_completions",
  maxContextSize: 8192,
}

const tmpDirs = []
let project
let fetchMock

function makeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), "llmwiki-caption-"))
  tmpDirs.push(dir)
  return dir
}

/** Write real image bytes under the project's wiki/ tree and return the
 *  wiki-relative URL the caption pipeline resolves by default. */
function writeWikiImage(relUrl, bytes = PNG_1X1) {
  const abs = path.join(project, "wiki", ...relUrl.split("/"))
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return relUrl
}

function cachePath() {
  return path.join(project, ".llm-wiki", "image-caption-cache.json")
}

function lastRequestBody() {
  const [, opts] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return JSON.parse(opts.body)
}

beforeEach(() => {
  project = makeProject()
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
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

describe("caption prompt builders", () => {
  it("pins the no-context prompt", () => {
    expect(CAPTION_PROMPT).toContain("Describe this image factually for a knowledge-base index.")
    expect(CAPTION_PROMPT).toContain("2 to 4 sentences.")
  })

  it("wraps context with (none) for blank sides", () => {
    const prompt = buildCaptionPromptWithContext("  ", "after text")
    expect(prompt).toContain("--- Text before image ---\n(none)")
    expect(prompt).toContain("--- Text after image ---\nafter text")
  })
})

describe("captionMarkdownImages", () => {
  it("returns input unchanged when there are no image references", async () => {
    const out = await captionMarkdownImages(project, "no images here", cfg)
    expect(out.enrichedMarkdown).toBe("no images here")
    expect(out.freshCaptions).toBe(0)
    expect(out.cachedCaptions).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("captions a fresh image, rewrites alt text, persists cache", async () => {
    writeWikiImage("media/x/img-1.png")
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("a red square"))

    // No surrounding text → the pinned no-context prompt is used.
    const md = "![](media/x/img-1.png)"
    const out = await captionMarkdownImages(project, md, cfg)

    expect(out.freshCaptions).toBe(1)
    expect(out.cachedCaptions).toBe(0)
    expect(out.enrichedMarkdown).toBe("![a red square](media/x/img-1.png)")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = lastRequestBody()
    // Multimodal OpenAI content array passes through the OpenAI wire:
    // [{type:"text"...},{type:"image_url",image_url:{url:"data:..."}}].
    expect(body.messages[0].role).toBe("user")
    expect(body.messages[0].content).toEqual([
      { type: "text", text: CAPTION_PROMPT },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1_BASE64}` } },
    ])
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBe(4096)

    // Cache file written exactly once at the end of the batch.
    const written = JSON.parse(readFileSync(cachePath(), "utf8"))
    const entries = Object.values(written)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      caption: "a red square",
      mimeType: "image/png",
      model: "vl-test",
    })
    expect(Object.keys(written)).toEqual([PNG_1X1_SHA256])
    expect(entries[0].capturedAt).toBeTruthy()
  })

  it("translates multimodal content to Anthropic image blocks for the anthropic wire", async () => {
    writeWikiImage("media/x/img-1.png")
    fetchMock.mockResolvedValueOnce(anthropicCaptionSseResponse("a red square"))

    const out = await captionMarkdownImages(project, "![](media/x/img-1.png)", {
      provider: "anthropic",
      apiKey: "sk-ant",
      model: "claude-sonnet-4-5-20250929",
    })

    expect(out.enrichedMarkdown).toBe("![a red square](media/x/img-1.png)")
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.anthropic.com/v1/messages")
    const body = JSON.parse(opts.body)
    // Array message content passes through llm-call.js's Anthropic adapter
    // unchanged, with the caption module owning the block translation.
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: CAPTION_PROMPT },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: PNG_1X1_BASE64 },
        },
      ],
    })
    expect(body.max_tokens).toBe(4096)
  })

  it("dedupes by SHA-256: two refs to the same bytes → one LLM call, both rewritten", async () => {
    // Both URLs serve the same bytes — same hash → single caption call,
    // both alt-texts populated.
    writeWikiImage("media/a/logo.png")
    writeWikiImage("media/b/logo-copy.png")
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("the logo"))

    const md = "![](media/a/logo.png) and ![](media/b/logo-copy.png)"
    const out = await captionMarkdownImages(project, md, cfg)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.freshCaptions).toBe(1)
    expect(out.enrichedMarkdown).toBe(
      "![the logo](media/a/logo.png) and ![the logo](media/b/logo-copy.png)",
    )
  })

  it("uses cached caption when SHA-256 hash matches", async () => {
    writeWikiImage("media/x/x.png")

    // Pre-populate the cache file keyed by the hash of the image BYTES.
    const knownHash = await __test.sha256OfBase64(PNG_1X1_BASE64)
    expect(knownHash).toBe(PNG_1X1_SHA256)
    mkdirSync(path.join(project, ".llm-wiki"), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify({
      [knownHash]: {
        caption: "previously captioned",
        mimeType: "image/png",
        model: "vl-old",
        capturedAt: "2026-01-01T00:00:00Z",
      },
    }))

    const md = "![](media/x/x.png)"
    const out = await captionMarkdownImages(project, md, cfg)

    expect(out.cachedCaptions).toBe(1)
    expect(out.freshCaptions).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.enrichedMarkdown).toBe("![previously captioned](media/x/x.png)")
  })

  it("sanitizes captions: strips newlines and replaces ] with )", async () => {
    writeWikiImage("media/x/x.png")
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("line1\nline2 with ] bracket"))

    const md = "![](media/x/x.png)"
    const out = await captionMarkdownImages(project, md, cfg)

    expect(out.enrichedMarkdown).toBe("![line1 line2 with ) bracket](media/x/x.png)")
  })

  it("continues batch when one caption call fails, reporting failed count", async () => {
    writeWikiImage("media/x/a.png", Buffer.from("AAAA", "utf8"))
    writeWikiImage("media/x/b.png", PNG_1X1)
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, body: null, text: async () => "boom" })
      .mockResolvedValueOnce(openAiCaptionSseResponse("second"))

    const md = "![](media/x/a.png) ![](media/x/b.png)"
    const out = await captionMarkdownImages(project, md, cfg)

    expect(out.freshCaptions).toBe(1)
    expect(out.failed).toBe(1)
    // Successful one rewritten, failing one keeps original empty alt.
    expect(out.enrichedMarkdown).toBe("![](media/x/a.png) ![second](media/x/b.png)")
  })

  it("counts unreadable images as failed without aborting the batch", async () => {
    writeWikiImage("media/x/ok.png")
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("fine"))

    const md = "![](media/x/missing.png) ![](media/x/ok.png)"
    const out = await captionMarkdownImages(project, md, cfg)

    expect(out.freshCaptions).toBe(1)
    expect(out.failed).toBe(1)
    expect(out.enrichedMarkdown).toBe("![](media/x/missing.png) ![fine](media/x/ok.png)")
  })

  it("respects shouldCaption filter: skips URLs that don't match", async () => {
    writeWikiImage("wanted/img.png")
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("c"))

    const md = "![](wanted/img.png) ![](https://external.example/foo.png)"
    const out = await captionMarkdownImages(project, md, cfg, {
      shouldCaption: (url) => url.startsWith("wanted/"),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(out.enrichedMarkdown).toBe(
      "![c](wanted/img.png) ![](https://external.example/foo.png)",
    )
  })

  it("uses urlToAbsPath hook when provided", async () => {
    // The image only exists at the custom anchor — proves the hook is used.
    const customAbs = path.join(project, "custom", "anchor", "media", "foo", "img-1.png")
    mkdirSync(path.dirname(customAbs), { recursive: true })
    writeFileSync(customAbs, PNG_1X1)
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("c"))

    const md = "![](media/foo/img-1.png)"
    const out = await captionMarkdownImages(project, md, cfg, {
      urlToAbsPath: (url) => path.join(project, "custom", "anchor", url),
    })

    expect(out.enrichedMarkdown).toBe("![c](media/foo/img-1.png)")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("skips Codex CLI captioning once before reading image bytes", async () => {
    writeWikiImage("media/x/a.png")
    writeWikiImage("media/x/b.png")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const out = await captionMarkdownImages(project, "![](media/x/a.png)\n![](media/x/b.png)", {
        ...cfg,
        provider: "codex-cli",
      })

      expect(out.enrichedMarkdown).toBe("![](media/x/a.png)\n![](media/x/b.png)")
      expect(out.failed).toBe(2)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        "[caption-pipeline] skipped image captioning: Codex CLI transport does not support image input yet.",
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("short-circuits without LLM calls when the signal is already aborted", async () => {
    writeWikiImage("media/x/x.png")
    const ctl = new AbortController()
    ctl.abort()

    const out = await captionMarkdownImages(project, "![](media/x/x.png)", cfg, {
      signal: ctl.signal,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.enrichedMarkdown).toBe("![](media/x/x.png)")
    expect(out.freshCaptions).toBe(0)
  })

  it("forwards the abort signal to the outbound LLM request", async () => {
    writeWikiImage("media/x/x.png")
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("c"))
    const ctl = new AbortController()

    await captionMarkdownImages(project, "![](media/x/x.png)", cfg, { signal: ctl.signal })

    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect(opts.signal.aborted).toBe(false)
  })

  it("recovers from corrupt cache JSON (logs and starts fresh)", async () => {
    mkdirSync(path.join(project, ".llm-wiki"), { recursive: true })
    writeFileSync(cachePath(), "{ this is not valid JSON")
    writeWikiImage("media/x/x.png")
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("ok"))

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const out = await captionMarkdownImages(project, "![](media/x/x.png)", cfg)
      expect(out.enrichedMarkdown).toBe("![ok](media/x/x.png)")
      expect(out.freshCaptions).toBe(1)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("corrupt cache at"),
        expect.anything(),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("respects concurrency limit — three caption calls dispatch in parallel when concurrency=3", async () => {
    // Three distinct byte sets → three distinct hashes (otherwise dedupe
    // collapses to one call).
    writeWikiImage("media/x/a.png", Buffer.from([1]))
    writeWikiImage("media/x/b.png", Buffer.from([2]))
    writeWikiImage("media/x/c.png", Buffer.from([3]))

    let inFlight = 0
    let peakInFlight = 0
    fetchMock.mockImplementation(async () => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      // Yield so the worker pool spins up additional tasks before this
      // one resolves.
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return openAiCaptionSseResponse("cap")
    })

    const md = "![](media/x/a.png) ![](media/x/b.png) ![](media/x/c.png)"
    const out = await captionMarkdownImages(project, md, cfg, { concurrency: 3 })

    expect(out.freshCaptions).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // With concurrency=3 and ALL three workers spawned before any resolve,
    // the peak should reach 3. Assert >=2 to leave slack for tight
    // scheduler races but still detect strictly-sequential regressions.
    expect(peakInFlight).toBeGreaterThanOrEqual(2)
  })

  it("calls onProgress after each image with running counts", async () => {
    writeWikiImage("media/x/a.png", Buffer.from([1]))
    writeWikiImage("media/x/b.png", Buffer.from([2]))
    fetchMock.mockImplementation(async () => openAiCaptionSseResponse("c"))
    const progressCalls = []

    const md = "![](media/x/a.png) ![](media/x/b.png)"
    await captionMarkdownImages(project, md, cfg, {
      onProgress: (done, total) => progressCalls.push({ done, total }),
    })

    expect(progressCalls).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ])
  })

  it("passes surrounding text as contextBefore / contextAfter in the prompt", async () => {
    writeWikiImage("media/x/x.png")
    fetchMock.mockResolvedValueOnce(openAiCaptionSseResponse("c"))

    // Image is sandwiched between recognizable before / after markers so
    // the slice content is easy to assert on.
    const before = "Figure 3: Quarterly revenue 2024 — preceding text. ".repeat(2)
    const after = " Following commentary about the chart. ".repeat(2)
    const md = `${before}![](media/x/x.png)${after}`

    await captionMarkdownImages(project, md, cfg)

    const promptText = lastRequestBody().messages[0].content[0].text
    expect(promptText).toContain("--- Text before image ---")
    expect(promptText).toContain("Figure 3: Quarterly revenue 2024")
    expect(promptText).toContain("Following commentary about the chart")
    // The image's own `![](url)` must NOT leak into either side — slicing
    // is by index/length, not by string match.
    expect(promptText).not.toContain("![](media/x/x.png)")
  })

  it("clamps context windows at document boundaries (no out-of-range read)", async () => {
    // Distinct bytes per image — identical bytes would dedupe through the
    // SHA-256 cache written by the first call and skip the later LLM calls.
    writeWikiImage("media/x/start.png", Buffer.from([1]))
    writeWikiImage("media/x/end.png", Buffer.from([2]))
    writeWikiImage("media/x/lone.png", Buffer.from([3]))
    fetchMock.mockImplementation(async () => openAiCaptionSseResponse("c"))

    // Image at the very start: before side collapses to "(none)".
    const md1 = "![](media/x/start.png) trailing text only"
    await captionMarkdownImages(project, md1, cfg)
    let promptText = lastRequestBody().messages[0].content[0].text
    expect(promptText).toContain("--- Text before image ---\n(none)")
    expect(promptText).toContain("--- Text after image ---\ntrailing text only")

    // Image at the very end: after side collapses to "(none)".
    const md2 = "leading text only ![](media/x/end.png)"
    await captionMarkdownImages(project, md2, cfg)
    promptText = lastRequestBody().messages[0].content[0].text
    expect(promptText).toContain("--- Text before image ---\nleading text only")
    expect(promptText).toContain("--- Text after image ---\n(none)")

    // No surrounding text at all: the pinned no-context prompt is used.
    const md3 = "![](media/x/lone.png)"
    await captionMarkdownImages(project, md3, cfg)
    promptText = lastRequestBody().messages[0].content[0].text
    expect(promptText).toBe(CAPTION_PROMPT)
  })
})

describe("loadCaptionCache", () => {
  it("returns sha → caption map from the cache file", async () => {
    mkdirSync(path.join(project, ".llm-wiki"), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify({
      abc: { caption: "one", mimeType: "image/png", model: "m", capturedAt: "now" },
      def: { caption: "two", mimeType: "image/png", model: "m", capturedAt: "now" },
    }))

    const map = await loadCaptionCache(project)
    expect(map.get("abc")).toBe("one")
    expect(map.get("def")).toBe("two")
    expect(map.size).toBe(2)
  })

  it("returns an empty map when the cache file is missing or corrupt", async () => {
    expect((await loadCaptionCache(project)).size).toBe(0)

    mkdirSync(path.join(project, ".llm-wiki"), { recursive: true })
    writeFileSync(cachePath(), "not json at all")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect((await loadCaptionCache(project)).size).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })
})
