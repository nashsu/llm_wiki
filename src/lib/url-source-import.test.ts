import { beforeEach, describe, expect, it, vi } from "vitest"

const mediaIngestConfig = vi.hoisted(() => ({ audioVideoEnabled: true }))

vi.mock("@/commands/fs", () => ({
  writeFile: vi.fn(),
  copyFile: vi.fn(),
  deleteFile: vi.fn(async () => undefined),
  downloadMediaUrl: vi.fn(),
}))
vi.mock("@/lib/source-lifecycle", () => ({
  enqueueSourceIngest: vi.fn(),
  getUniqueDestPath: vi.fn(async (root: string, name: string) => `${root}/${name}`),
}))
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => ({ mediaIngestConfig }) },
}))
vi.mock("@/lib/tauri-fetch", () => ({ getHttpFetch: vi.fn() }))

import { copyFile, deleteFile, downloadMediaUrl, writeFile } from "@/commands/fs"
import { enqueueSourceIngest } from "@/lib/source-lifecycle"
import { getHttpFetch } from "@/lib/tauri-fetch"
import {
  MAX_BATCH_URLS,
  fetchImportUrl,
  importSourceUrls,
  parseImportUrls,
  urlSourceFileName,
} from "./url-source-import"

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

describe("importSourceUrls media fork", () => {
  const project = { path: "/project", id: "p1" } as never
  /** Canned HTML response so the text/HTML fallback never hits the network. */
  const htmlFetch = vi.fn(async () => new Response("<html><head><title>Article</title></head></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  }))

  beforeEach(() => {
    vi.clearAllMocks()
    mediaIngestConfig.audioVideoEnabled = true
    vi.mocked(getHttpFetch).mockResolvedValue(htmlFetch as unknown as typeof globalThis.fetch)
  })

  it("imports a video link as a downloaded audio file when media ingest is enabled", async () => {
    vi.mocked(downloadMediaUrl).mockResolvedValue("/tmp/llm-wiki-media-import/talk [abc123].mp3")

    const results = await importSourceUrls(project, ["https://youtube.com/watch?v=abc123"], {} as never)

    expect(results).toEqual([{ url: "https://youtube.com/watch?v=abc123", path: "/project/raw/sources/talk [abc123].mp3" }])
    expect(copyFile).toHaveBeenCalledWith(
      "/tmp/llm-wiki-media-import/talk [abc123].mp3",
      "/project/raw/sources/talk [abc123].mp3",
    )
    expect(htmlFetch).not.toHaveBeenCalled() // no HTML/text fetch happened
    expect(writeFile).not.toHaveBeenCalled()
    // copyFile copies, so the yt-dlp download must be removed from the temp dir.
    expect(deleteFile).toHaveBeenCalledWith("/tmp/llm-wiki-media-import/talk [abc123].mp3")
    expect(enqueueSourceIngest).toHaveBeenCalledWith(project, ["/project/raw/sources/talk [abc123].mp3"], {})
  })

  it("deletes the temp download even when the copy into raw/sources fails", async () => {
    vi.mocked(downloadMediaUrl).mockResolvedValue("/tmp/llm-wiki-media-import/talk [abc123].mp3")
    vi.mocked(copyFile).mockRejectedValue(new Error("disk full"))

    const results = await importSourceUrls(project, ["https://youtube.com/watch?v=abc123"], {} as never)

    expect(results).toEqual([{ url: "https://youtube.com/watch?v=abc123", error: "disk full" }])
    expect(deleteFile).toHaveBeenCalledWith("/tmp/llm-wiki-media-import/talk [abc123].mp3")
  })

  it("falls back to the text/HTML fetch when yt-dlp reports an unsupported URL", async () => {
    vi.mocked(downloadMediaUrl).mockRejectedValue(new Error("unsupported URL: no extractor found"))

    const results = await importSourceUrls(project, ["https://example.com/article"], {} as never)

    expect(downloadMediaUrl).toHaveBeenCalledWith("https://example.com/article")
    expect(results).toEqual([{ url: "https://example.com/article", path: "/project/raw/sources/Article.html" }])
    expect(copyFile).not.toHaveBeenCalled()
    expect(vi.mocked(writeFile).mock.calls[0][0]).toBe("/project/raw/sources/Article.html")
  })

  it("reports a real download failure instead of falling back to a doomed text fetch", async () => {
    vi.mocked(downloadMediaUrl).mockRejectedValue(new Error("Video unavailable: private video"))

    const results = await importSourceUrls(project, ["https://youtube.com/watch?v=private"], {} as never)

    expect(results).toEqual([{ url: "https://youtube.com/watch?v=private", error: "Video unavailable: private video" }])
    expect(htmlFetch).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("skips yt-dlp entirely when the media toggle is off", async () => {
    mediaIngestConfig.audioVideoEnabled = false

    const results = await importSourceUrls(project, ["https://youtube.com/watch?v=abc123"], {} as never)

    expect(downloadMediaUrl).not.toHaveBeenCalled()
    expect(results[0].path).toBe("/project/raw/sources/Article.html")
  })
})
