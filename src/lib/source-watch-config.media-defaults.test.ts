import { describe, expect, it } from "vitest"
import { normalizeSourceWatchConfig } from "./source-watch-config"
import { AUDIO_VIDEO_SOURCE_EXTENSIONS, IMAGE_SOURCE_EXTENSIONS } from "./media-extensions"

describe("normalizeSourceWatchConfig media-extension backfill", () => {
  it("adds the media extensions to an old persisted config that predates this feature", () => {
    const oldPersistedConfig = {
      includeExtensions: ["md", "pdf", "docx"], // realistic pre-feature saved list
    }
    const result = normalizeSourceWatchConfig(oldPersistedConfig)
    for (const ext of AUDIO_VIDEO_SOURCE_EXTENSIONS) {
      expect(result.includeExtensions).toContain(ext)
    }
    for (const ext of IMAGE_SOURCE_EXTENSIONS) {
      expect(result.includeExtensions).toContain(ext)
    }
    // Original entries are preserved, not replaced.
    expect(result.includeExtensions).toContain("md")
    expect(result.includeExtensions).toContain("pdf")
    expect(result.includeExtensions).toContain("docx")
  })

  it("does not duplicate media extensions for a fresh config that already has them", () => {
    const result = normalizeSourceWatchConfig(undefined) // falls back to DEFAULT_SOURCE_WATCH_CONFIG
    const mp4Count = result.includeExtensions.filter((e) => e === "mp4").length
    expect(mp4Count).toBe(1)
  })

  it("keeps an empty include-list empty, because empty means no extension filter", () => {
    // `importSourceFiles` clears includeExtensions to bypass the watcher
    // allow-list for explicit imports; backfilling media there would turn that
    // allow-all into a media-only filter and reject every document.
    const result = normalizeSourceWatchConfig({ includeExtensions: [] })
    expect(result.includeExtensions).toEqual([])
  })
})
