import { describe, expect, it } from "vitest"
import {
  DEFAULT_SOURCE_WATCH_CONFIG,
  isPathAllowedBySourceWatch,
  normalizeSourceWatchConfig,
} from "@/lib/source-watch-config"
import sourceWatchDefaults from "@/lib/source-watch-defaults.json"

describe("source watch config", () => {
  it("includes AnyDoc Office and RTF variants in the default watch set", () => {
    for (const extension of ["docm", "ppt", "ppsm", "xlsb", "rtf"]) {
      expect(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions).toContain(extension)
    }
  })
  it("includes standalone image sources in the default watch set", () => {
    for (const extension of ["png", "jpg", "jpeg"]) {
      expect(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions).toContain(extension)
    }
  })

  it("upgrades the previous default extension set without changing custom lists", () => {
    const previousDefaults = DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions.filter(
      (extension) => !["png", "jpg", "jpeg"].includes(extension),
    )
    expect(normalizeSourceWatchConfig({ includeExtensions: previousDefaults }).includeExtensions)
      .toEqual([...previousDefaults, "png", "jpg", "jpeg"])
    expect(normalizeSourceWatchConfig({ includeExtensions: ["md", "pdf"] }).includeExtensions)
      .toEqual(["md", "pdf"])
  })
  it("uses the shared default fixture", () => {
    expect(DEFAULT_SOURCE_WATCH_CONFIG).toEqual(sourceWatchDefaults)
    expect(normalizeSourceWatchConfig({}).persistExtractedMarkdown).toBe(false)
    expect(normalizeSourceWatchConfig({}).parsingConcurrency).toBe(2)
    expect(normalizeSourceWatchConfig({}).ingestConcurrency).toBe(1)
    expect(
      normalizeSourceWatchConfig({ persistExtractedMarkdown: true }).persistExtractedMarkdown,
    ).toBe(true)
    expect(normalizeSourceWatchConfig({ parsingConcurrency: 100 }).parsingConcurrency).toBe(64)
    expect(normalizeSourceWatchConfig({ ingestConcurrency: 100 }).ingestConcurrency).toBe(64)
    expect(normalizeSourceWatchConfig({ ingestConcurrency: 0 }).ingestConcurrency).toBe(1)
    expect(
      normalizeSourceWatchConfig({ parsingConcurrency: Number.NaN }).parsingConcurrency,
    ).toBe(2)
    expect(
      normalizeSourceWatchConfig({ ingestConcurrency: Number.NaN }).ingestConcurrency,
    ).toBe(1)
  })

  it("allows document types by default and rejects config/media/binaries", () => {
    expect(isPathAllowedBySourceWatch("raw/sources/report.pdf", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/notes.md", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/notes.org", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/report.doc", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/secrets.json", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/video.mp4", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/tool.exe", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
  })

  it("applies directory and glob exclusions", () => {
    const config = normalizeSourceWatchConfig({
      includeExtensions: ["md"],
      excludeDirs: [".obsidian", "drafts"],
      excludeGlobs: ["*.private.*", "~$*"],
    })

    expect(isPathAllowedBySourceWatch("raw/sources/ready.md", config)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/drafts/ready.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/subdir/drafts/ready.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/.obsidian/index.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/plan.private.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/~$Document.docx", config)).toBe(false)
  })

  it("normalizes comma-separated exclusion values from text fields", () => {
    const config = normalizeSourceWatchConfig({
      includeExtensions: ["md, pdf", "docx"],
      excludeExtensions: ["json, yaml\nxml，dll"],
      excludeDirs: [".git, node_modules", "drafts，wip"],
      excludeGlobs: ["*.private.*, ~$*"],
    })

    expect(config.includeExtensions).toEqual(["md", "pdf", "docx"])
    expect(config.excludeExtensions).toEqual(["json", "yaml", "xml", "dll"])
    expect(config.excludeDirs).toEqual([".git", "node_modules", "drafts", "wip"])
    expect(config.excludeGlobs).toEqual(["*.private.*", "~$*"])
    expect(config.excludedPaths).toEqual([])
  })

  it("normalizes excludedPaths to source-relative keys", () => {
    const config = normalizeSourceWatchConfig({
      excludedPaths: ["raw/sources/foo.md", "/proj/raw/sources/docs/paper.pdf", "docs/", "", "foo.md"],
    })
    expect(config.excludedPaths).toEqual(["foo.md", "docs/paper.pdf", "docs"])
  })

  it("respects excludedPaths for exact files and folder prefixes", () => {
    const config = normalizeSourceWatchConfig({ excludedPaths: ["foo.md", "docs"] })
    expect(isPathAllowedBySourceWatch("raw/sources/foo.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/docs/paper.pdf", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/docs/sub/a.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/raw/sources/foo.md", config)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/bar.md", config)).toBe(true)
  })
})
