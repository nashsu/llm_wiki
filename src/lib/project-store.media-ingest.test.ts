import { describe, expect, it } from "vitest"
import { __projectStoreTest } from "./project-store"

describe("normalizeMediaIngestConfig", () => {
  it("fills in defaults for a missing/empty config", () => {
    const result = __projectStoreTest.normalizeMediaIngestConfig({} as never)
    expect(result).toEqual({
      audioVideoEnabled: false,
      audioVideoBackend: "groq",
      audioVideoToken: "",
      audioVideoCustomEndpoint: "",
      audioVideoCustomToken: "",
      imagesEnabled: false,
    })
  })

  it("preserves a valid custom-backend config and trims whitespace", () => {
    const result = __projectStoreTest.normalizeMediaIngestConfig({
      audioVideoEnabled: true,
      audioVideoBackend: "custom",
      audioVideoToken: "  ignored-when-custom  ",
      audioVideoCustomEndpoint: " https://my-whisper.example.com/v1 ",
      audioVideoCustomToken: " secret ",
      imagesEnabled: true,
    })
    expect(result).toEqual({
      audioVideoEnabled: true,
      audioVideoBackend: "custom",
      audioVideoToken: "ignored-when-custom",
      audioVideoCustomEndpoint: "https://my-whisper.example.com/v1",
      audioVideoCustomToken: "secret",
      imagesEnabled: true,
    })
  })

  it("falls back to groq for any unrecognized backend value", () => {
    const result = __projectStoreTest.normalizeMediaIngestConfig({
      audioVideoBackend: "not-a-real-backend",
    } as never)
    expect(result.audioVideoBackend).toBe("groq")
  })
})
