import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", () => ({
  getFileSize: vi.fn(),
  readFileAsBase64: vi.fn(),
}))
vi.mock("@/lib/tauri-fetch", () => ({ getHttpFetch: vi.fn() }))

import { getFileSize, readFileAsBase64 } from "@/commands/fs"
import { getHttpFetch } from "@/lib/tauri-fetch"
import {
  splitBySizeForTest,
  buildTranscriptionRequestForTest,
  transcribeAudio,
} from "./media-transcribe"
import type { MediaIngestConfig } from "@/stores/wiki-store"

const baseConfig: MediaIngestConfig = {
  audioVideoEnabled: true,
  audioVideoBackend: "groq",
  audioVideoToken: "",
  audioVideoCustomEndpoint: "",
  audioVideoCustomToken: "",
  imagesEnabled: false,
}

describe("splitBySize", () => {
  it("returns a single segment when under the byte limit", () => {
    const segments = splitBySizeForTest(10_000_000, 25_000_000)
    expect(segments).toEqual([{ startByte: 0, endByte: 10_000_000 }])
  })

  it("keeps a file that is exactly at the limit in one segment", () => {
    expect(splitBySizeForTest(25_000_000, 25_000_000)).toEqual([
      { startByte: 0, endByte: 25_000_000 },
    ])
  })

  it("produces contiguous segments that never exceed the limit", () => {
    const segments = splitBySizeForTest(51_000_001, 25_000_000)
    expect(segments[0].startByte).toBe(0)
    expect(segments[segments.length - 1].endByte).toBe(51_000_001)
    for (const [i, segment] of segments.entries()) {
      expect(segment.endByte - segment.startByte).toBeLessThanOrEqual(25_000_000)
      if (i > 0) expect(segment.startByte).toBe(segments[i - 1].endByte)
    }
  })

  it("splits into equal-ish segments when over the byte limit", () => {
    const segments = splitBySizeForTest(60_000_000, 25_000_000)
    expect(segments.length).toBe(3)
    expect(segments[0]).toEqual({ startByte: 0, endByte: 20_000_000 })
    expect(segments[1]).toEqual({ startByte: 20_000_000, endByte: 40_000_000 })
    expect(segments[2]).toEqual({ startByte: 40_000_000, endByte: 60_000_000 })
  })
})

describe("buildTranscriptionRequest", () => {
  it("targets Groq's endpoint with the groq backend", () => {
    const req = buildTranscriptionRequestForTest({
      audioVideoEnabled: true,
      audioVideoBackend: "groq",
      audioVideoToken: "gsk_test",
      audioVideoCustomEndpoint: "",
      audioVideoCustomToken: "",
      imagesEnabled: false,
    })
    expect(req.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions")
    expect(req.headers.Authorization).toBe("Bearer gsk_test")
  })

  it("targets the custom endpoint with the custom backend", () => {
    const req = buildTranscriptionRequestForTest({
      audioVideoEnabled: true,
      audioVideoBackend: "custom",
      audioVideoToken: "",
      audioVideoCustomEndpoint: "https://my-whisper.example.com/v1",
      audioVideoCustomToken: "secret",
      imagesEnabled: false,
    })
    expect(req.url).toBe("https://my-whisper.example.com/v1/audio/transcriptions")
    expect(req.headers.Authorization).toBe("Bearer secret")
  })

  it("trims a trailing slash from the custom endpoint", () => {
    const req = buildTranscriptionRequestForTest({
      ...baseConfig,
      audioVideoBackend: "custom",
      audioVideoCustomEndpoint: "https://my-whisper.example.com/v1//",
    })
    expect(req.url).toBe("https://my-whisper.example.com/v1/audio/transcriptions")
  })
})

// These reject before any Tauri/network call, so no mocks are needed:
// a regression would surface as a different error message.
describe("transcribeAudio configuration guards", () => {
  it("rejects when the Groq token is missing", async () => {
    await expect(
      transcribeAudio("/tmp/a.mp3", { ...baseConfig, audioVideoBackend: "groq" }),
    ).rejects.toThrow(/Groq API token is not configured/)
  })

  it("rejects when the custom endpoint is missing", async () => {
    await expect(
      transcribeAudio("/tmp/a.mp3", { ...baseConfig, audioVideoBackend: "custom" }),
    ).rejects.toThrow(/Custom transcription endpoint is not configured/)
  })
})

describe("transcribeAudio HTTP path", () => {
  const groqConfig: MediaIngestConfig = { ...baseConfig, audioVideoToken: "gsk_test" }

  /** Stages a file of `size` bytes whose first byte of each segment is `marker`. */
  function stageAudioFile(size: number, markers: Record<number, number> = {}): Buffer {
    const buf = Buffer.alloc(size)
    for (const [offset, value] of Object.entries(markers)) buf[Number(offset)] = value
    vi.mocked(getFileSize).mockResolvedValue(size)
    vi.mocked(readFileAsBase64).mockResolvedValue({
      base64: buf.toString("base64"),
      mimeType: "audio/mpeg",
    })
    return buf
  }

  function stageFetch(...responses: unknown[]) {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      const body = responses.shift()
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as unknown as Response
    })
    vi.mocked(getHttpFetch).mockResolvedValue(fetchMock as unknown as typeof fetch)
    return fetchMock
  }

  /** Pulls the uploaded audio Blob out of the FormData handed to fetch. */
  async function uploadedBytes(fetchMock: ReturnType<typeof stageFetch>, call: number) {
    const init = fetchMock.mock.calls[call][1]
    const blob = (init.body as FormData).get("file") as Blob
    return new Uint8Array(await blob.arrayBuffer())
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the transcript text from a single-segment upload", async () => {
    stageAudioFile(1024)
    const fetchMock = stageFetch({ text: "  hello world  " })

    await expect(transcribeAudio("/tmp/a.mp3", groqConfig)).resolves.toBe("hello world")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.groq.com/openai/v1/audio/transcriptions")
  })

  it("keeps an empty string (silence) rather than treating it as an error", async () => {
    stageAudioFile(1024)
    stageFetch({ text: "" })
    await expect(transcribeAudio("/tmp/a.mp3", groqConfig)).resolves.toBe("")
  })

  it("throws when the response has no text field", async () => {
    stageAudioFile(1024)
    stageFetch({ segments: [] })
    await expect(transcribeAudio("/tmp/a.mp3", groqConfig)).rejects.toThrow(
      /missing 'text' field/,
    )
  })

  it("uploads each byte-range segment in order and joins the transcripts", async () => {
    // 26MB > the 25MB upload cap -> two 13,631,488-byte segments.
    const totalBytes = 26 * 1024 * 1024
    const segmentSize = totalBytes / 2
    stageAudioFile(totalBytes, { 0: 11, [segmentSize]: 22 })
    const fetchMock = stageFetch({ text: "first half" }, { text: "second half" })

    await expect(transcribeAudio("/tmp/long.mp3", groqConfig)).resolves.toBe(
      "first half\n\nsecond half",
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const first = await uploadedBytes(fetchMock, 0)
    const second = await uploadedBytes(fetchMock, 1)
    expect(first.length).toBe(segmentSize)
    expect(second.length).toBe(segmentSize)
    // Marker bytes prove segment 2 starts where segment 1 ends.
    expect(first[0]).toBe(11)
    expect(second[0]).toBe(22)
  })
})
