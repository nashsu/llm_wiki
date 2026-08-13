import { describe, expect, it, beforeEach } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import {
  INGESTABLE_SOURCE_EXTENSIONS,
  isIngestableSourcePath,
} from "./source-lifecycle"
import { AUDIO_VIDEO_SOURCE_EXTENSIONS, IMAGE_SOURCE_EXTENSIONS } from "./media-extensions"

describe("media extension gate", () => {
  beforeEach(() => {
    useWikiStore.getState().setMediaIngestConfig({
      audioVideoEnabled: false,
      audioVideoBackend: "groq",
      audioVideoToken: "",
      audioVideoCustomEndpoint: "",
      audioVideoCustomToken: "",
      imagesEnabled: false,
    })
  })

  it("registers the expected audio/video and image extensions", () => {
    for (const ext of ["mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a"]) {
      expect(AUDIO_VIDEO_SOURCE_EXTENSIONS.has(ext)).toBe(true)
      expect(INGESTABLE_SOURCE_EXTENSIONS.has(ext)).toBe(true)
    }
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "avif", "heic"]) {
      expect(IMAGE_SOURCE_EXTENSIONS.has(ext)).toBe(true)
      expect(INGESTABLE_SOURCE_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  it("rejects audio/video files when audioVideoEnabled is false", () => {
    expect(isIngestableSourcePath("/project/raw/sources/talk.mp4")).toBe(false)
  })

  it("accepts audio/video files once audioVideoEnabled is true", () => {
    useWikiStore.getState().setMediaIngestConfig({
      ...useWikiStore.getState().mediaIngestConfig,
      audioVideoEnabled: true,
    })
    expect(isIngestableSourcePath("/project/raw/sources/talk.mp4")).toBe(true)
  })

  it("rejects images when imagesEnabled is false, accepts once true", () => {
    expect(isIngestableSourcePath("/project/raw/sources/screenshot.png")).toBe(false)
    useWikiStore.getState().setMediaIngestConfig({
      ...useWikiStore.getState().mediaIngestConfig,
      imagesEnabled: true,
    })
    expect(isIngestableSourcePath("/project/raw/sources/screenshot.png")).toBe(true)
  })

  it("leaves text documents unaffected by either toggle", () => {
    expect(isIngestableSourcePath("/project/raw/sources/notes.pdf")).toBe(true)
  })
})
