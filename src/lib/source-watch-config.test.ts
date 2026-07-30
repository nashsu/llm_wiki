import { describe, expect, it } from "vitest"
import {
  DEFAULT_SOURCE_WATCH_CONFIG,
  isPathAllowedBySourceWatch,
  normalizeSourceWatchConfig,
} from "@/lib/source-watch-config"
import sourceWatchDefaults from "@/lib/source-watch-defaults.json"

describe("source watch config", () => {
  it("uses the shared default fixture", () => {
    expect(DEFAULT_SOURCE_WATCH_CONFIG).toEqual(sourceWatchDefaults)
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

  it("rejects code extensions under default config", () => {
    expect(isPathAllowedBySourceWatch("raw/sources/app.ts", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/lib.py", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
    expect(isPathAllowedBySourceWatch("raw/sources/main.go", DEFAULT_SOURCE_WATCH_CONFIG)).toBe(false)
  })

  it("allows code extensions when explicitly included", () => {
    const config = normalizeSourceWatchConfig({
      includeExtensions: ["js", "ts", "tsx", "py", "go", "rs", "php"],
    })

    expect(isPathAllowedBySourceWatch("raw/sources/app.ts", config)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/lib.py", config)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/main.go", config)).toBe(true)
    expect(isPathAllowedBySourceWatch("raw/sources/lib.rs", config)).toBe(true)
    // still rejects unknown extensions
    expect(isPathAllowedBySourceWatch("raw/sources/notes.xyz", config)).toBe(false)
    // still rejects dotfiles
    expect(isPathAllowedBySourceWatch("raw/sources/.hidden.ts", config)).toBe(false)
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
