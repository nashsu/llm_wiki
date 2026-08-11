import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  enqueueSourceIngest: vi.fn(),
  fetch: vi.fn(),
  getHttpFetch: vi.fn(),
  getUniqueDestPath: vi.fn(),
  importYouTubeUrl: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  writeFile: mocks.writeFile,
}))

vi.mock("@/lib/tauri-fetch", () => ({
  getHttpFetch: mocks.getHttpFetch,
}))

vi.mock("@/lib/source-lifecycle", () => ({
  enqueueSourceIngest: mocks.enqueueSourceIngest,
  getUniqueDestPath: mocks.getUniqueDestPath,
}))

vi.mock("@/lib/youtube-sources", async () => {
  const actual = await vi.importActual<typeof import("@/lib/youtube-sources")>("@/lib/youtube-sources")
  return {
    ...actual,
    importYouTubeUrl: mocks.importYouTubeUrl,
  }
})

import {
  MAX_BATCH_URLS,
  fetchImportUrl,
  importSourceUrls,
  isYouTubeUrl,
  parseImportUrls,
  urlSourceFileName,
} from "./url-source-import"
import { YouTubeSourceError } from "./youtube-sources"

const project = { id: "project-1", name: "Project", path: "/project" }
const llmConfig = {} as never
const oneMegabyteLimit = { maxFileSizeMb: 1 } as never

function youtubeArtifact(videoId: string, markdown = "# Video\n\nTranscript\n") {
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    fileName: `youtube-${videoId}.md`,
    markdown,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getHttpFetch.mockResolvedValue(mocks.fetch)
  mocks.getUniqueDestPath.mockImplementation(async (root: string, fileName: string) => `${root}/${fileName}`)
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.enqueueSourceIngest.mockResolvedValue([])
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("parseImportUrls", () => {
  it("normalizes fragments, removes duplicates, and preserves order", () => {
    expect(parseImportUrls(" https://example.com/a#part\nhttps://example.com/a\nhttp://例子.测试/b ")).toEqual([
      "https://example.com/a",
      "http://xn--fsqu00a.xn--0zwm56d/b",
    ])
  })

  it("rejects malformed and non-http URLs", () => {
    expect(() => parseImportUrls("not-a-url")).toThrow("Invalid URL")
    expect(() => parseImportUrls("file:///tmp/secret")).toThrow("Unsupported URL scheme")
    expect(() => parseImportUrls("https://user:secret@example.com/page")).toThrow("embedded credentials")
  })

  it("caps batch size", () => {
    const urls = Array.from({ length: MAX_BATCH_URLS + 1 }, (_, index) => `https://example.com/${index}`)
    expect(() => parseImportUrls(urls.join("\n"))).toThrow(`at most ${MAX_BATCH_URLS}`)
  })
})

describe("isYouTubeUrl", () => {
  it("uses strict single-video recognition", () => {
    expect(isYouTubeUrl("https://youtu.be/abcdefghijk")).toBe(true)
    expect(isYouTubeUrl("https://www.youtube.com/shorts/abcdefghijk")).toBe(true)
    expect(isYouTubeUrl("https://www.youtube.com/playlist?list=PL123")).toBe(false)
    expect(isYouTubeUrl("https://www.youtube.com/channel/UC123")).toBe(false)
    expect(isYouTubeUrl("https://youtube.com.evil.test/watch?v=abcdefghijk")).toBe(false)
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=too-short")).toBe(false)
  })
})

describe("urlSourceFileName", () => {
  it("prefers a safe HTML title", () => {
    expect(urlSourceFileName(
      "https://example.com/post/123",
      "text/html; charset=utf-8",
      "<html><head><title>安全 / Useful: Guide</title></head></html>",
    )).toBe("安全-Useful-Guide.html")
  })

  it("uses the URL leaf for plain text", () => {
    expect(urlSourceFileName("https://example.com/docs/readme.md", "text/plain", "hello"))
      .toBe("readme.txt")
  })

  it("avoids Windows reserved names and tolerates malformed escapes", () => {
    expect(urlSourceFileName("https://example.com/AUX", "text/plain", "hello"))
      .toBe("AUX-web.txt")
    expect(urlSourceFileName("https://example.com/bad%escape", "text/plain", "hello"))
      .toBe("bad-escape.txt")
  })
})

describe("fetchImportUrl", () => {
  it("blocks a public URL redirect before requesting a private target", async () => {
    const fetch = async (url: string | URL | Request, init?: RequestInit & { maxRedirections?: number }) => {
      expect(String(url)).toBe("https://example.com/start")
      expect(init).toMatchObject({ redirect: "manual", maxRedirections: 0 })
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      })
    }
    await expect(fetchImportUrl(fetch as typeof globalThis.fetch, "https://example.com/start", new AbortController().signal))
      .rejects.toThrow("cannot redirect")
  })

  it("blocks IPv4-mapped IPv6 private redirect targets", async () => {
    const fetch = async () => new Response(null, {
      status: 302,
      headers: { location: "http://[::ffff:169.254.169.254]/metadata" },
    })
    await expect(fetchImportUrl(fetch as typeof globalThis.fetch, "https://example.com", new AbortController().signal))
      .rejects.toThrow("cannot redirect")
  })

  it("allows an explicitly requested private URL and follows relative redirects", async () => {
    const seen: string[] = []
    const fetch = async (url: string | URL | Request, init?: RequestInit & { maxRedirections?: number }) => {
      seen.push(String(url))
      expect(init).toMatchObject({ redirect: "manual", maxRedirections: 0 })
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: "/page" } })
        : new Response("ok", { status: 200 })
    }
    const response = await fetchImportUrl(
      fetch as typeof globalThis.fetch,
      "http://192.168.1.50/start",
      new AbortController().signal,
    )
    expect(await response.text()).toBe("ok")
    expect(seen).toEqual(["http://192.168.1.50/start", "http://192.168.1.50/page"])
  })
})

describe("importSourceUrls", () => {
  it("keeps ordinary webpage behavior and never invokes the YouTube adapter", async () => {
    mocks.fetch.mockResolvedValue(new Response(
      "<html><head><title>Useful article</title></head><body>Hello</body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ))

    const results = await importSourceUrls(project, ["https://example.com/article"], llmConfig)

    expect(mocks.importYouTubeUrl).not.toHaveBeenCalled()
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/project/raw/sources/Useful-article.html",
      expect.stringContaining('<meta name="llm-wiki-source-url" content="https://example.com/article">'),
    )
    expect(results).toEqual([{
      url: "https://example.com/article",
      path: "/project/raw/sources/Useful-article.html",
      outcome: "webpage",
    }])
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledOnce()
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(
      project,
      ["/project/raw/sources/Useful-article.html"],
      llmConfig,
    )
  })

  it("persists transcript-backed Markdown without a generic webpage request", async () => {
    const url = "https://youtu.be/abcdefghijk"
    mocks.importYouTubeUrl.mockResolvedValue(youtubeArtifact("abcdefghijk"))

    const results = await importSourceUrls(project, [url], llmConfig, oneMegabyteLimit)

    expect(mocks.importYouTubeUrl).toHaveBeenCalledWith(url, expect.objectContaining({
      fetch: mocks.fetch,
      signal: expect.any(AbortSignal),
      maxArtifactBytes: 1024 * 1024,
    }))
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/project/raw/sources/youtube-abcdefghijk.md",
      "# Video\n\nTranscript\n",
    )
    expect(results).toEqual([{
      url,
      path: "/project/raw/sources/youtube-abcdefghijk.md",
      outcome: "youtube-transcript",
    }])
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(
      project,
      ["/project/raw/sources/youtube-abcdefghijk.md"],
      llmConfig,
    )
  })

  it("falls back to an ordinary webpage with a degraded outcome and no error", async () => {
    const url = "https://www.youtube.com/watch?v=abcdefghijk"
    mocks.importYouTubeUrl.mockRejectedValue(new YouTubeSourceError("NO_CAPTIONS", "abcdefghijk"))
    mocks.fetch.mockResolvedValue(new Response("page", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }))

    const results = await importSourceUrls(project, [url], llmConfig)

    expect(results).toEqual([{
      url,
      path: "/project/raw/sources/watch.txt",
      outcome: "youtube-webpage-fallback",
    }])
    expect(results[0].error).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith("YouTube import NO_CAPTIONS for video abcdefghijk; using webpage fallback")
  })

  it("isolates a complete YouTube failure from the next ordinary URL", async () => {
    const youtubeUrl = "https://www.youtube.com/watch?v=abcdefghijk"
    mocks.importYouTubeUrl.mockRejectedValue(new YouTubeSourceError("PLAYER_UNPLAYABLE", "abcdefghijk"))
    mocks.fetch.mockImplementation(async (url: string | URL | Request) => String(url).includes("youtube.com")
      ? new Response("blocked", { status: 503 })
      : new Response("article", { status: 200, headers: { "content-type": "text/plain" } }))

    const results = await importSourceUrls(
      project,
      [youtubeUrl, "https://example.com/article"],
      llmConfig,
    )

    expect(results).toEqual([
      { url: youtubeUrl, outcome: "failure", error: "HTTP 503" },
      {
        url: "https://example.com/article",
        path: "/project/raw/sources/article.txt",
        outcome: "webpage",
      },
    ])
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(
      project,
      ["/project/raw/sources/article.txt"],
      llmConfig,
    )
  })

  it("preserves mixed-batch order and performs one queue handoff for successful paths", async () => {
    const transcriptUrl = "https://youtu.be/aaaaaaaaaaa"
    const fallbackUrl = "https://youtu.be/bbbbbbbbbbb"
    const failedUrl = "https://youtu.be/ccccccccccc"
    const ordinaryUrl = "https://example.com/article"
    mocks.importYouTubeUrl.mockImplementation(async (url: string) => {
      if (url === transcriptUrl) return youtubeArtifact("aaaaaaaaaaa")
      throw new YouTubeSourceError("NO_CAPTIONS", url === fallbackUrl ? "bbbbbbbbbbb" : "ccccccccccc")
    })
    mocks.fetch.mockImplementation(async (url: string | URL | Request) => {
      const value = String(url)
      if (value === fallbackUrl) {
        return new Response("fallback", { status: 200, headers: { "content-type": "text/plain" } })
      }
      if (value === failedUrl) return new Response("missing", { status: 404 })
      return new Response("ordinary", { status: 200, headers: { "content-type": "text/plain" } })
    })

    const results = await importSourceUrls(
      project,
      [transcriptUrl, fallbackUrl, failedUrl, ordinaryUrl],
      llmConfig,
    )

    expect(results.map((result) => result.outcome)).toEqual([
      "youtube-transcript",
      "youtube-webpage-fallback",
      "failure",
      "webpage",
    ])
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledOnce()
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(project, [
      "/project/raw/sources/youtube-aaaaaaaaaaa.md",
      "/project/raw/sources/bbbbbbbbbbb.txt",
      "/project/raw/sources/article.txt",
    ], llmConfig)
  })

  it("uses a fresh, non-aborted signal for webpage fallback after a specialized timeout", async () => {
    vi.useFakeTimers()
    const url = "https://youtu.be/abcdefghijk"
    let specializedSignal: AbortSignal | undefined
    let fallbackSignal: AbortSignal | undefined
    mocks.importYouTubeUrl.mockImplementation(async (_url: string, options: { signal: AbortSignal }) => {
      specializedSignal = options.signal
      return await new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new YouTubeSourceError("ABORTED", "abcdefghijk"))
        }, { once: true })
      })
    })
    mocks.fetch.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      fallbackSignal = init?.signal ?? undefined
      return new Response("fallback", { status: 200, headers: { "content-type": "text/plain" } })
    })

    const pending = importSourceUrls(project, [url], llmConfig)
    await vi.advanceTimersByTimeAsync(60_000)
    const results = await pending

    expect(specializedSignal?.aborted).toBe(true)
    expect(fallbackSignal).not.toBe(specializedSignal)
    expect(fallbackSignal?.aborted).toBe(false)
    expect(results[0].outcome).toBe("youtube-webpage-fallback")
  })

  it("keeps an ordinary webpage timeout as a per-URL failure", async () => {
    vi.useFakeTimers()
    mocks.fetch.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => await new Promise(
      (_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("network aborted")), { once: true }),
    ))

    const pending = importSourceUrls(project, ["https://example.com/slow"], llmConfig)
    await vi.advanceTimersByTimeAsync(60_000)
    const results = await pending

    expect(results).toEqual([{
      url: "https://example.com/slow",
      outcome: "failure",
      error: "network aborted",
    }])
  })

  it("does not persist or queue after the adapter rejects an oversized artifact", async () => {
    const url = "https://youtu.be/abcdefghijk"
    mocks.importYouTubeUrl.mockRejectedValue(new YouTubeSourceError("ARTIFACT_TOO_LARGE", "abcdefghijk"))
    mocks.fetch.mockResolvedValue(new Response("too large", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": String(1024 * 1024 + 1),
      },
    }))

    const results = await importSourceUrls(project, [url], llmConfig, oneMegabyteLimit)

    expect(results[0]).toMatchObject({ url, outcome: "failure", error: "Response exceeds the source file size limit" })
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(project, [], llmConfig)
  })

  it("rejects a generic response over the project source-size limit", async () => {
    mocks.fetch.mockResolvedValue(new Response("small body", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": String(1024 * 1024 + 1),
      },
    }))

    const results = await importSourceUrls(
      project,
      ["https://example.com/large"],
      llmConfig,
      oneMegabyteLimit,
    )

    expect(results[0].outcome).toBe("failure")
    expect(results[0].error).toContain("source file size limit")
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it("does not start webpage fallback when writing a transcript-backed artifact fails", async () => {
    const url = "https://youtu.be/abcdefghijk"
    mocks.importYouTubeUrl.mockResolvedValue(youtubeArtifact("abcdefghijk"))
    mocks.writeFile.mockRejectedValue(new Error("disk full"))

    const results = await importSourceUrls(project, [url], llmConfig)

    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(results).toEqual([{ url, outcome: "failure", error: "disk full" }])
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(project, [], llmConfig)
  })

  it("keeps saved outcomes when the single batch queue handoff fails", async () => {
    const transcriptUrl = "https://youtu.be/abcdefghijk"
    const fallbackUrl = "https://youtu.be/lmnopqrstuv"
    mocks.importYouTubeUrl
      .mockResolvedValueOnce(youtubeArtifact("abcdefghijk"))
      .mockRejectedValueOnce(new YouTubeSourceError("NO_CAPTIONS", "lmnopqrstuv"))
    mocks.fetch.mockResolvedValue(new Response("fallback", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }))
    mocks.enqueueSourceIngest.mockRejectedValue(new Error("queue stopped"))

    const results = await importSourceUrls(project, [transcriptUrl, fallbackUrl], llmConfig)

    expect(results.map((result) => result.outcome)).toEqual([
      "youtube-transcript",
      "youtube-webpage-fallback",
    ])
    expect(results.every((result) => result.path)).toBe(true)
    expect(results.every((result) => result.error === "Saved, but failed to queue ingest: queue stopped")).toBe(true)
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledOnce()
  })
})
