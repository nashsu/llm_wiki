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
  it("uses the shared default fixture", () => {
    expect(DEFAULT_SOURCE_WATCH_CONFIG).toEqual(sourceWatchDefaults)
    expect(normalizeSourceWatchConfig({}).persistExtractedMarkdown).toBe(false)
    expect(normalizeSourceWatchConfig({}).parsingConcurrency).toBe(2)
    expect(normalizeSourceWatchConfig({}).ingestConcurrency).toBe(1)
    expect(
      normalizeSourceWatchConfig({ persistExtractedMarkdown: true }).persistExtractedMarkdown,
    ).toBe(true)
    expect(normalizeSourceWatchConfig({ parsingConcurrency: 20 }).parsingConcurrency).toBe(8)
    expect(normalizeSourceWatchConfig({ ingestConcurrency: 20 }).ingestConcurrency).toBe(5)
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
  })
})
