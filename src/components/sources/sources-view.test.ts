import { describe, expect, it } from "vitest"
import type { FileNode } from "@/types/wiki"
import type { UrlImportResult } from "@/lib/url-source-import"
import {
  filterSourceTreeByQuery,
  getUrlImportResultPresentation,
  hasSupportedYouTubeVideoUrl,
  shouldClearUrlImportInput,
} from "./sources-view"

const TREE: FileNode[] = [
  {
    name: "Books",
    path: "/project/raw/sources/Books",
    is_dir: true,
    children: [
      { name: "BookA.md", path: "/project/raw/sources/Books/BookA.md", is_dir: false },
      { name: "三阶段治疗模型.pdf", path: "/project/raw/sources/Books/三阶段治疗模型.pdf", is_dir: false },
    ],
  },
  { name: "notes.txt", path: "/project/raw/sources/notes.txt", is_dir: false },
]

describe("filterSourceTreeByQuery", () => {
  it("keeps parent folders while removing non-matching siblings", () => {
    const result = filterSourceTreeByQuery(TREE, "booka")
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Books")
    expect(result[0].children?.map((node) => node.name)).toEqual(["BookA.md"])
  })

  it("matches Unicode names and normalized path segments", () => {
    expect(filterSourceTreeByQuery(TREE, "治疗模型")[0].children?.[0].name)
      .toBe("三阶段治疗模型.pdf")
    expect(filterSourceTreeByQuery(TREE, "BOOKS")).toEqual([TREE[0]])
  })

  it("returns a new top-level array for an empty query without mutating nodes", () => {
    const result = filterSourceTreeByQuery(TREE, "  ")
    expect(result).toEqual(TREE)
    expect(result).not.toBe(TREE)
  })

  it("returns an empty tree when no source matches", () => {
    expect(filterSourceTreeByQuery(TREE, "missing source")).toEqual([])
  })
})

describe("hasSupportedYouTubeVideoUrl", () => {
  it("recognizes supported single-video URLs anywhere in the multiline input", () => {
    expect(hasSupportedYouTubeVideoUrl([
      "https://example.com/article",
      "  https://youtu.be/abcdefghijk  ",
    ].join("\n"))).toBe(true)
    expect(hasSupportedYouTubeVideoUrl("https://m.youtube.com/watch?v=abcdefghijk")).toBe(true)
    expect(hasSupportedYouTubeVideoUrl("https://www.youtube.com/shorts/abcdefghijk")).toBe(true)
  })

  it("does not hint for unsupported or spoofed YouTube-looking URLs", () => {
    expect(hasSupportedYouTubeVideoUrl("https://www.youtube.com/channel/UC123")).toBe(false)
    expect(hasSupportedYouTubeVideoUrl("https://www.youtube.com/playlist?list=PL123")).toBe(false)
    expect(hasSupportedYouTubeVideoUrl("https://youtube.com.evil.test/watch?v=abcdefghijk")).toBe(false)
    expect(hasSupportedYouTubeVideoUrl("https://www.youtube.com/watch?v=too-short")).toBe(false)
    expect(hasSupportedYouTubeVideoUrl("https://example.com/article")).toBe(false)
  })
})

describe("getUrlImportResultPresentation", () => {
  const result = (value: UrlImportResult) => getUrlImportResultPresentation(value)

  it("maps each import outcome to distinct copy and non-error fallback styling", () => {
    expect(result({ url: "https://example.com", path: "/web.html", outcome: "webpage" }))
      .toEqual({ messageKey: "sources.urlImport.results.webpage", tone: "success" })
    expect(result({ url: "https://youtu.be/abcdefghijk", path: "/video.md", outcome: "youtube-transcript" }))
      .toEqual({ messageKey: "sources.urlImport.results.youtubeTranscript", tone: "success" })
    expect(result({ url: "https://youtu.be/abcdefghijk", path: "/watch.html", outcome: "youtube-webpage-fallback" }))
      .toEqual({ messageKey: "sources.urlImport.results.youtubeFallback", tone: "notice" })
    expect(result({ url: "https://example.com", outcome: "failure", error: "HTTP 500" }))
      .toEqual({ messageKey: "sources.urlImport.results.failure", tone: "error" })
  })

  it("keeps a post-save queue failure on the actual error surface", () => {
    expect(result({
      url: "https://example.com",
      path: "/web.html",
      outcome: "webpage",
      error: "Saved, but failed to queue ingest",
    })).toEqual({ messageKey: "sources.urlImport.results.failure", tone: "error" })
  })
})

describe("shouldClearUrlImportInput", () => {
  it("clears after saved webpage fallback but not after a queue error", () => {
    expect(shouldClearUrlImportInput([{
      url: "https://youtu.be/abcdefghijk",
      path: "/watch.html",
      outcome: "youtube-webpage-fallback",
    }])).toBe(true)

    expect(shouldClearUrlImportInput([{
      url: "https://youtu.be/abcdefghijk",
      path: "/watch.html",
      outcome: "youtube-webpage-fallback",
      error: "Saved, but failed to queue ingest",
    }])).toBe(false)
  })
})
