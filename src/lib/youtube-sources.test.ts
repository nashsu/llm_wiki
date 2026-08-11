import { describe, expect, it } from "vitest"
import {
  YouTubeSourceError,
  importYouTubeUrl,
  isYouTubeUrl,
  parseYouTubeVideoUrl,
  type YouTubeSourceErrorCode,
} from "./youtube-sources"

const VIDEO_ID = "7mU62hM5GP4"
const CANONICAL_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`
const VISITOR_DATA = "visitor-test-value"
const MiB = 1024 * 1024
const EXPERIMENT_MARKERS: Array<{ marker: Record<string, string>; label: string }> = [
  { marker: { pot: "secret-pot" }, label: "pot" },
  { marker: { xpe: "1" }, label: "xpe" },
  { marker: { xpv: "1" }, label: "xpv" },
  { marker: { exp: "foo,xpe,bar" }, label: "xpe in exp" },
  { marker: { exp: "foo_xpe_bar" }, label: "embedded xpe in exp" },
  { marker: { exp: "xpv" }, label: "xpv in exp" },
]

type ObservedInit = RequestInit & { maxRedirections?: number }

interface FetchCall {
  url: string
  init: ObservedInit
}

type Responder = (call: FetchCall) => Response | Promise<Response>

function createFetch(responders: Responder[]): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let index = 0
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: (init ?? {}) as ObservedInit }
    calls.push(call)
    const responder = responders[index++]
    if (!responder) throw new Error(`Unexpected request: ${call.url}`)
    return responder(call)
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

function textResponse(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, { status, headers })
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return textResponse(JSON.stringify(value), status, {
    "content-type": "application/json",
    ...Object.fromEntries(new Headers(headers)),
  })
}

function watchPage(visitorData = VISITOR_DATA): string {
  return [
    "<script>ytcfg.set({\"FIRST\":{\"nested\":{\"quote\":\"escaped \\\" } text\"}}});</script>",
    `<script> ytcfg . set ( {"INNERTUBE_CONTEXT":{"client":{"visitorData":${JSON.stringify(visitorData)}}}} ); </script>`,
  ].join("\n")
}

function timedTextUrl(
  languageCode: string,
  extra: Record<string, string> = {},
  videoId = VIDEO_ID,
): string {
  const url = new URL("https://www.youtube.com/api/timedtext")
  url.search = new URLSearchParams({
    v: videoId,
    lang: languageCode,
    expire: "2000000000",
    signature: "signed-test-value",
    xosf: "1",
    ...extra,
  }).toString()
  return url.toString()
}

function captionTrack(
  languageCode: string,
  kind: "manual" | "asr" = "manual",
  options: { name?: string; url?: string; extra?: Record<string, string>; audioTrackId?: string } = {},
): Record<string, unknown> {
  return {
    baseUrl: options.url ?? timedTextUrl(languageCode, options.extra),
    languageCode,
    name: { simpleText: options.name ?? languageCode },
    ...(kind === "asr" ? { kind: "asr" } : {}),
    ...(options.audioTrackId ? { audioTrackId: options.audioTrackId } : {}),
  }
}

function playerFixture(options: {
  videoId?: string
  status?: string
  reason?: string
  streamingAudioTracks?: Record<string, unknown>[]
  formatAudioTracks?: Record<string, unknown>[]
  adaptiveAudioTracks?: Record<string, unknown>[]
  captionAudioTracks?: Record<string, unknown>[]
  captionTracks?: Record<string, unknown>[]
  metadata?: boolean
} = {}): Record<string, unknown> {
  const withMetadata = options.metadata !== false
  const streamingAudioTracks = options.streamingAudioTracks ?? [
    { displayName: "English (Original)", id: "en.4", audioIsDefault: true },
  ]
  const formatAudioTracks = options.formatAudioTracks ?? streamingAudioTracks
  const adaptiveAudioTracks = options.adaptiveAudioTracks ?? streamingAudioTracks
  return {
    playabilityStatus: {
      status: options.status ?? "OK",
      ...(options.reason ? { reason: options.reason } : {}),
    },
    videoDetails: {
      videoId: options.videoId ?? VIDEO_ID,
      ...(withMetadata
        ? {
            title: "Useful\nVideo",
            author: "Channel\r\nForged: no",
            shortDescription: "First line\r\nSecond\u200b line",
            lengthSeconds: "62",
          }
        : {}),
    },
    ...(withMetadata
      ? {
          microformat: {
            playerMicroformatRenderer: {
              publishDate: "2026-08-11\nForged: no",
            },
          },
        }
      : {}),
    streamingData: {
      formats: formatAudioTracks.map((audioTrack, index) => ({
        itag: 18 + index,
        mimeType: "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"",
        audioTrack,
      })),
      adaptiveFormats: adaptiveAudioTracks.map((audioTrack, index) => ({
        itag: 140 + index,
        mimeType: "audio/mp4; codecs=\"mp4a.40.2\"",
        audioTrack: { ...audioTrack },
      })),
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        ...(options.captionAudioTracks ? { audioTracks: options.captionAudioTracks } : {}),
        captionTracks: options.captionTracks ?? [
          captionTrack("en", "manual", { extra: { track: "manual" } }),
          captionTrack("en", "asr", { extra: { track: "asr" } }),
        ],
      },
    },
  }
}

function json3Fixture(): Record<string, unknown> {
  return {
    wireMagic: "pb3",
    wsWinStyles: [{ mhModeHint: 2 }],
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ acAsrConf: 0 }] },
      { tStartMs: 500, segs: [{ utf8: "\r\n" }] },
      { tStartMs: 1234, dDurationMs: 900, segs: [{ utf8: "Hello\u200b " }, { utf8: "\r\nworld" }] },
      { tStartMs: 2500, segs: [{ utf8: "Repeated lyric" }] },
      { tStartMs: 3500, segs: [{ utf8: "Repeated lyric" }] },
    ],
  }
}

function standardResponders(options: {
  watch?: Response
  player?: Response
  timedText?: Response
  playerValue?: unknown
  timedTextValue?: unknown
} = {}): Responder[] {
  return [
    () => options.watch ?? textResponse(watchPage()),
    () => options.player ?? jsonResponse(options.playerValue ?? playerFixture()),
    () => options.timedText ?? jsonResponse(options.timedTextValue ?? json3Fixture()),
  ]
}

function importWith(fetch: typeof globalThis.fetch, options: { signal?: AbortSignal; maxArtifactBytes?: number } = {}) {
  return importYouTubeUrl(CANONICAL_URL, {
    fetch,
    signal: options.signal ?? new AbortController().signal,
    maxArtifactBytes: options.maxArtifactBytes ?? 2 * MiB,
  })
}

async function expectCode(promise: Promise<unknown>, code: YouTubeSourceErrorCode): Promise<YouTubeSourceError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(YouTubeSourceError)
    expect(error).toMatchObject({ code })
    return error as YouTubeSourceError
  }
  throw new Error(`Expected ${code}`)
}

describe("parseYouTubeVideoUrl", () => {
  it.each([
    `https://youtube.com/watch?v=${VIDEO_ID}&list=PL123`,
    `https://www.youtube.com/watch?v=${VIDEO_ID}#t=1`,
    `https://m.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?si=share-token`,
    `https://www.youtube.com/shorts/${VIDEO_ID}?feature=share`,
    `http://m.youtube.com/watch?v=${VIDEO_ID}`,
  ])("canonicalizes supported single-video form %s", (url) => {
    expect(parseYouTubeVideoUrl(url)).toEqual({ videoId: VIDEO_ID, canonicalUrl: CANONICAL_URL })
    expect(isYouTubeUrl(url)).toBe(true)
  })

  it.each([
    "not a URL",
    "ftp://www.youtube.com/watch?v=7mU62hM5GP4",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/channel/UC123",
    "https://www.youtube.com/@channel",
    "https://www.youtube.com/watch?v=short",
    `https://www.youtube.com/watch?v=${VIDEO_ID}&v=${VIDEO_ID}`,
    `https://user:secret@www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com:8443/watch?v=${VIDEO_ID}`,
    `https://youtube.com.evil.test/watch?v=${VIDEO_ID}`,
    `https://youtu.be.evil.test/${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}/extra`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
  ])("rejects unsupported or unsafe form %s", (url) => {
    expect(parseYouTubeVideoUrl(url)).toBeNull()
    expect(isYouTubeUrl(url)).toBe(false)
  })
})

describe("importYouTubeUrl", () => {
  it("uses the fixed anonymous request chain, selects original manual captions, and renders normalized Markdown", async () => {
    const { fetch, calls } = createFetch(standardResponders())
    const artifact = await importWith(fetch)

    expect(artifact).toMatchObject({
      videoId: VIDEO_ID,
      canonicalUrl: CANONICAL_URL,
      fileName: `youtube-${VIDEO_ID}.md`,
    })
    expect(artifact.markdown).toContain("# Useful Video")
    expect(artifact.markdown).toContain(`Source URL: ${CANONICAL_URL}`)
    expect(artifact.markdown).toContain("Channel: Channel Forged: no")
    expect(artifact.markdown).toContain("Published: 2026-08-11 Forged: no")
    expect(artifact.markdown).toContain("Duration: 1:02")
    expect(artifact.markdown).toContain("Transcript language: en")
    expect(artifact.markdown).toContain("Transcript type: manual")
    expect(artifact.markdown).toContain("First line\nSecond line")
    expect(artifact.markdown).toContain("[00:01.234] Hello world")
    expect(artifact.markdown.match(/Repeated lyric/g)).toHaveLength(2)
    expect(artifact.markdown).not.toMatch(/[\r\u200B]/)

    expect(calls).toHaveLength(3)
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "POST", "GET"])
    for (const call of calls) {
      expect(call.init).toMatchObject({
        credentials: "omit",
        redirect: "manual",
        maxRedirections: 0,
      })
      expect(call.init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(calls[0].url).toBe(CANONICAL_URL)
    const playerUrl = new URL(calls[1].url)
    expect(playerUrl.origin + playerUrl.pathname).toBe("https://www.youtube.com/youtubei/v1/player")
    expect(playerUrl.searchParams.has("key")).toBe(false)
    const headers = new Headers(calls[1].init.headers)
    expect(headers.get("x-youtube-client-name")).toBe("101")
    expect(headers.get("x-youtube-client-version")).toBe("1.02")
    expect(headers.get("x-goog-visitor-id")).toBe(VISITOR_DATA)
    expect(headers.has("cookie")).toBe(false)
    expect(headers.has("authorization")).toBe(false)

    const playerBody = JSON.parse(String(calls[1].init.body)) as Record<string, unknown>
    expect(playerBody).toMatchObject({
      videoId: VIDEO_ID,
      context: {
        client: {
          clientName: "VISIONOS",
          clientVersion: "1.02",
          deviceModel: "RealityDevice17,1",
          hl: "en",
          timeZone: "UTC",
          utcOffsetMinutes: 0,
          visitorData: VISITOR_DATA,
        },
      },
    })
    const serializedRequest = JSON.stringify({ headers: Object.fromEntries(headers), playerBody })
    expect(serializedRequest).not.toMatch(/api.?key|authorization|cookie|po.?token|service.?integrity/i)

    const captionRequest = new URL(calls[2].url)
    expect(captionRequest.origin + captionRequest.pathname).toBe("https://www.youtube.com/api/timedtext")
    expect(captionRequest.searchParams.get("v")).toBe(VIDEO_ID)
    expect(captionRequest.searchParams.get("track")).toBe("manual")
    expect(captionRequest.searchParams.get("fmt")).toBe("json3")
    expect(captionRequest.searchParams.has("xosf")).toBe(false)
    expect(captionRequest.searchParams.has("tlang")).toBe(false)
  })

  it("uses the sole ASR language when no explicit original-audio signal exists", async () => {
    const player = playerFixture({
      streamingAudioTracks: [],
      captionTracks: [captionTrack("ja", "asr")],
    })
    const { fetch, calls } = createFetch(standardResponders({ playerValue: player }))
    const artifact = await importWith(fetch)

    expect(artifact.markdown).toContain("Transcript language: ja")
    expect(artifact.markdown).toContain("Transcript type: automatic (ASR)")
    expect(new URL(calls[2].url).searchParams.get("lang")).toBe("ja")
  })

  it("ignores auto-dubbed audio and selects the manual track matching the explicit original language", async () => {
    const player = playerFixture({
      streamingAudioTracks: [
        { displayName: "English (Dubbed)", id: "en.dubbed", audioIsDefault: false },
        { displayName: "Spanish (Original)", id: "es.4", audioIsDefault: true },
      ],
      captionTracks: [
        captionTrack("en", "manual", { name: "English (Dubbed)" }),
        captionTrack("es", "manual"),
      ],
    })
    const { fetch, calls } = createFetch(standardResponders({ playerValue: player }))
    const artifact = await importWith(fetch)

    expect(artifact.markdown).toContain("Transcript language: es")
    expect(new URL(calls[2].url).searchParams.get("lang")).toBe("es")
  })

  it.each([
    { formatAudioTracks: [{ displayName: "English (Original)", id: "en.4", audioIsDefault: true }], adaptiveAudioTracks: [] },
    { formatAudioTracks: [], adaptiveAudioTracks: [{ displayName: "English (Original)", id: "en.4", audioIsDefault: true }] },
  ])("uses a streaming audio original signal for manual-only captions", async ({
    formatAudioTracks,
    adaptiveAudioTracks,
  }) => {
    const player = playerFixture({
      formatAudioTracks,
      adaptiveAudioTracks,
      captionTracks: [captionTrack("en", "manual", { extra: { track: "manual-only" } })],
    })
    const { fetch, calls } = createFetch(standardResponders({ playerValue: player }))
    const artifact = await importWith(fetch)

    expect(artifact.markdown).toContain("Transcript type: manual")
    expect(new URL(calls[2].url).searchParams.get("track")).toBe("manual-only")
  })

  it("selects the first exact-language manual track before a matching ASR track", async () => {
    const player = playerFixture({
      captionTracks: [
        captionTrack("en", "manual", { extra: { track: "manual-first" } }),
        captionTrack("en", "manual", { extra: { track: "manual-second" } }),
        captionTrack("en", "asr", { extra: { track: "asr" } }),
      ],
    })
    const { fetch, calls } = createFetch(standardResponders({ playerValue: player }))
    const artifact = await importWith(fetch)

    expect(artifact.markdown).toContain("Transcript type: manual")
    expect(new URL(calls[2].url).searchParams.get("track")).toBe("manual-first")
  })

  it.each([
    {
      name: "a lone manual track with no reliable language signal",
      player: playerFixture({
        streamingAudioTracks: [],
        captionAudioTracks: [{ displayName: "English (Original)", id: "en.4", audioIsDefault: true }],
        captionTracks: [captionTrack("en")],
      }),
      code: "ORIGINAL_LANGUAGE_UNKNOWN" as const,
    },
    {
      name: "ambiguous ASR languages",
      player: playerFixture({
        streamingAudioTracks: [],
        captionTracks: [captionTrack("en", "asr"), captionTrack("ja", "asr")],
      }),
      code: "ORIGINAL_LANGUAGE_UNKNOWN" as const,
    },
    {
      name: "multiple ASR tracks sharing one language",
      player: playerFixture({
        streamingAudioTracks: [],
        captionTracks: [
          captionTrack("en", "asr", { extra: { track: "asr-first" } }),
          captionTrack("en", "asr", { extra: { track: "asr-second" } }),
        ],
      }),
      code: "ORIGINAL_LANGUAGE_UNKNOWN" as const,
    },
    {
      name: "translated-only matching captions",
      player: playerFixture({
        captionTracks: [captionTrack("en", "manual", { extra: { tlang: "en" } })],
      }),
      code: "NO_ELIGIBLE_CAPTION" as const,
    },
    {
      name: "mismatched-language captions",
      player: playerFixture({
        streamingAudioTracks: [{ displayName: "Spanish (Original)", id: "es.4", audioIsDefault: true }],
        captionTracks: [captionTrack("en")],
      }),
      code: "NO_ELIGIBLE_CAPTION" as const,
    },
    {
      name: "dubbed-only audio and captions",
      player: playerFixture({
        streamingAudioTracks: [
          { displayName: "English (Original Dubbed)", id: "en.dubbed", audioIsDefault: true },
        ],
        captionTracks: [captionTrack("en", "manual", { name: "English (Dubbed)" })],
      }),
      code: "ORIGINAL_LANGUAGE_UNKNOWN" as const,
    },
  ])("fails closed for $name without requesting timed text", async ({ player, code }) => {
    const { fetch, calls } = createFetch(standardResponders({ playerValue: player }).slice(0, 2))
    await expectCode(importWith(fetch), code)
    expect(calls).toHaveLength(2)
  })

  it.each(EXPERIMENT_MARKERS)("rejects $label experiment markers before timed-text fetch", async ({ marker }) => {
    const player = playerFixture({ captionTracks: [captionTrack("en", "manual", { extra: marker })] })
    const { fetch, calls } = createFetch(standardResponders({ playerValue: player }).slice(0, 2))
    const error = await expectCode(importWith(fetch), "CAPTION_URL_UNSAFE")
    expect(calls).toHaveLength(2)
    expect(error.message).not.toContain("secret-pot")
    expect(error.message).not.toContain(VISITOR_DATA)
  })

  it.each([
    { label: "HTTP", url: timedTextUrl("en").replace("https:", "http:") },
    { label: "credentials", url: timedTextUrl("en").replace("https://", "https://user:secret@") },
    { label: "non-default port", url: timedTextUrl("en").replace("www.youtube.com", "www.youtube.com:8443") },
    { label: "wrong host", url: timedTextUrl("en").replace("www.youtube.com", "youtube.com") },
    { label: "spoofed host", url: timedTextUrl("en").replace("www.youtube.com", "www.youtube.com.evil.test") },
    { label: "wrong path", url: timedTextUrl("en").replace("/api/timedtext", "/api/player") },
    { label: "wrong video", url: timedTextUrl("en", {}, "aaaaaaaaaaa") },
    { label: "wrong language", url: timedTextUrl("es") },
  ])("rejects a $label timed-text URL before requesting it", async ({ url }) => {
    const player = playerFixture({ captionTracks: [captionTrack("en", "manual", { url })] })
    const { fetch, calls } = createFetch(standardResponders({ playerValue: player }).slice(0, 2))
    await expectCode(importWith(fetch), "CAPTION_URL_UNSAFE")
    expect(calls).toHaveLength(2)
  })

  it.each([
    {
      endpoint: "watch",
      responders: [() => textResponse("redirect", 302, { location: "https://evil.test/watch" })],
      code: "WATCH_REDIRECT" as const,
      requests: 1,
    },
    {
      endpoint: "player",
      responders: [
        () => textResponse(watchPage()),
        () => textResponse("redirect", 307, { location: "https://evil.test/player" }),
      ],
      code: "PLAYER_REDIRECT" as const,
      requests: 2,
    },
    {
      endpoint: "timed text",
      responders: [
        () => textResponse(watchPage()),
        () => jsonResponse(playerFixture()),
        () => textResponse("redirect", 308, { location: "https://evil.test/captions" }),
      ],
      code: "TIMED_TEXT_REDIRECT" as const,
      requests: 3,
    },
  ])("fails a $endpoint 3xx without following it", async ({ responders, code, requests }) => {
    const { fetch, calls } = createFetch(responders)
    await expectCode(importWith(fetch), code)
    expect(calls).toHaveLength(requests)
    for (const call of calls) {
      expect(call.init).toMatchObject({ credentials: "omit", redirect: "manual", maxRedirections: 0 })
    }
  })

  it.each([
    {
      endpoint: "watch",
      responders: [() => Promise.reject(new Error("watch request failed"))],
      code: "WATCH_REQUEST_FAILED" as const,
      requests: 1,
    },
    {
      endpoint: "player",
      responders: [
        () => textResponse(watchPage()),
        () => Promise.reject(new Error("player request failed")),
      ],
      code: "PLAYER_REQUEST_FAILED" as const,
      requests: 2,
    },
    {
      endpoint: "timed text",
      responders: [
        () => textResponse(watchPage()),
        () => jsonResponse(playerFixture()),
        () => Promise.reject(new Error("timed-text request failed")),
      ],
      code: "TIMED_TEXT_REQUEST_FAILED" as const,
      requests: 3,
    },
  ])("maps a rejected $endpoint request to $code", async ({ responders, code, requests }) => {
    const { fetch, calls } = createFetch(responders)

    await expectCode(importWith(fetch), code)
    expect(calls).toHaveLength(requests)
  })

  it.each([
    {
      endpoint: "watch",
      responders: (response: Response): Responder[] => [() => response],
      code: "WATCH_READ_FAILED" as const,
      requests: 1,
    },
    {
      endpoint: "player",
      responders: (response: Response): Responder[] => [
        () => textResponse(watchPage()),
        () => response,
      ],
      code: "PLAYER_READ_FAILED" as const,
      requests: 2,
    },
    {
      endpoint: "timed text",
      responders: (response: Response): Responder[] => [
        () => textResponse(watchPage()),
        () => jsonResponse(playerFixture()),
        () => response,
      ],
      code: "TIMED_TEXT_READ_FAILED" as const,
      requests: 3,
    },
  ])("maps a rejected $endpoint stream read to $code", async ({ responders, code, requests }) => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("stream read failed"))
      },
    }))
    const { fetch, calls } = createFetch(responders(response))

    await expectCode(importWith(fetch), code)
    expect(calls).toHaveLength(requests)
  })

  it.each([
    {
      endpoint: "watch",
      maxBytes: 8 * MiB,
      responders: (response: Response): Responder[] => [() => response],
      code: "WATCH_TOO_LARGE" as const,
    },
    {
      endpoint: "player",
      maxBytes: 4 * MiB,
      responders: (response: Response): Responder[] => [() => textResponse(watchPage()), () => response],
      code: "PLAYER_TOO_LARGE" as const,
    },
    {
      endpoint: "timed text",
      maxBytes: 16 * MiB,
      responders: (response: Response): Responder[] => [
        () => textResponse(watchPage()),
        () => jsonResponse(playerFixture()),
        () => response,
      ],
      code: "TIMED_TEXT_TOO_LARGE" as const,
    },
  ])("rejects declared over-limit $endpoint bodies before reading", async ({ maxBytes, responders, code }) => {
    let readerRequested = false
    let cancelled = false
    const response = {
      status: 200,
      ok: true,
      headers: new Headers({ "content-length": String(maxBytes + 1) }),
      body: {
        getReader() {
          readerRequested = true
          throw new Error("body must not be read")
        },
        async cancel() {
          cancelled = true
        },
      },
    } as unknown as Response
    const { fetch } = createFetch(responders(response))

    await expectCode(importWith(fetch), code)
    expect(readerRequested).toBe(false)
    expect(cancelled).toBe(true)
  })

  it.each([
    {
      endpoint: "watch",
      maxBytes: 8 * MiB,
      responders: (response: Response): Responder[] => [() => response],
      code: "WATCH_TOO_LARGE" as const,
    },
    {
      endpoint: "player",
      maxBytes: 4 * MiB,
      responders: (response: Response): Responder[] => [() => textResponse(watchPage()), () => response],
      code: "PLAYER_TOO_LARGE" as const,
    },
    {
      endpoint: "timed text",
      maxBytes: 16 * MiB,
      responders: (response: Response): Responder[] => [
        () => textResponse(watchPage()),
        () => jsonResponse(playerFixture()),
        () => response,
      ],
      code: "TIMED_TEXT_TOO_LARGE" as const,
    },
  ])("cancels chunked $endpoint bodies that overflow without Content-Length", async ({ maxBytes, responders, code }) => {
    const chunk = new Uint8Array(MiB)
    let emitted = 0
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const remaining = maxBytes + 1 - emitted
        if (remaining <= 0) return
        const value = remaining >= chunk.byteLength ? chunk : new Uint8Array(remaining)
        emitted += value.byteLength
        controller.enqueue(value)
      },
      cancel() {
        cancelled = true
      },
    }))
    const { fetch } = createFetch(responders(response))

    await expectCode(importWith(fetch), code)
    expect(emitted).toBe(maxBytes + 1)
    expect(cancelled).toBe(true)
  })

  it("keeps the caller signal active while streaming the response body", async () => {
    const controller = new AbortController()
    let pulls = 0
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        pulls += 1
        stream.enqueue(new TextEncoder().encode(pulls === 1 ? "<html>" : "more"))
        if (pulls === 2) controller.abort()
      },
      cancel() {
        cancelled = true
      },
    }))
    const { fetch } = createFetch([() => response])

    await expectCode(importWith(fetch, { signal: controller.signal }), "ABORTED")
    expect(cancelled).toBe(true)
  })

  it.each([
    { label: "malformed", response: textResponse("{"), code: "TIMED_TEXT_INVALID_JSON" as const },
    { label: "empty", response: textResponse(""), code: "TIMED_TEXT_EMPTY" as const },
    {
      label: "no usable cues",
      response: jsonResponse({
        events: [
          { tStartMs: 0, segs: [{ acAsrConf: 0 }] },
          { tStartMs: 1, segs: [{ utf8: "\n" }] },
          { tStartMs: -1, segs: [{ utf8: "invalid" }] },
          { tStartMs: Number.POSITIVE_INFINITY, segs: [{ utf8: "invalid" }] },
        ],
      }),
      code: "TIMED_TEXT_NO_USABLE_CUES" as const,
    },
  ])("rejects $label JSON3", async ({ response, code }) => {
    const { fetch } = createFetch(standardResponders({ timedText: response }))
    await expectCode(importWith(fetch), code)
  })

  it.each([
    {
      label: "non-OK playability",
      response: jsonResponse(playerFixture({ status: "UNPLAYABLE", reason: "Unavailable" })),
      code: "PLAYER_UNPLAYABLE" as const,
    },
    {
      label: "login requirement",
      response: jsonResponse(playerFixture({ status: "LOGIN_REQUIRED", reason: "Sign in" })),
      code: "PLAYER_LOGIN_REQUIRED" as const,
    },
    {
      label: "bot check",
      response: jsonResponse(playerFixture({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" })),
      code: "PLAYER_BOT_CHECK" as const,
    },
    { label: "rate limiting", response: textResponse("rate limited", 429), code: "PLAYER_RATE_LIMITED" as const },
    { label: "malformed JSON", response: textResponse("{"), code: "PLAYER_INVALID_JSON" as const },
    {
      label: "mismatched video ID",
      response: jsonResponse(playerFixture({ videoId: "aaaaaaaaaaa" })),
      code: "PLAYER_VIDEO_ID_MISMATCH" as const,
    },
  ])("reports stable diagnostics for $label", async ({ response, code }) => {
    const { fetch, calls } = createFetch([
      () => textResponse(watchPage()),
      () => response,
    ])
    await expectCode(importWith(fetch), code)
    expect(calls).toHaveLength(2)
  })

  it("omits unavailable optional metadata without placeholders", async () => {
    const player = playerFixture({ metadata: false })
    const { fetch } = createFetch(standardResponders({ playerValue: player }))
    const artifact = await importWith(fetch)

    expect(artifact.markdown).toContain(`Source URL: ${CANONICAL_URL}`)
    expect(artifact.markdown).not.toMatch(/^# /m)
    expect(artifact.markdown).not.toMatch(/^(?:Channel|Published|Duration):/m)
    expect(artifact.markdown).not.toContain("Unknown")
    expect(artifact.markdown).not.toContain("N/A")
  })

  it("enforces the final UTF-8 Markdown artifact limit", async () => {
    const { fetch, calls } = createFetch(standardResponders())
    await expectCode(importWith(fetch, { maxArtifactBytes: 16 }), "ARTIFACT_TOO_LARGE")
    expect(calls).toHaveLength(3)
  })

  it("rejects unsupported input before making a request", async () => {
    const { fetch, calls } = createFetch([])
    await expectCode(importYouTubeUrl("https://www.youtube.com/playlist?list=PL123", {
      fetch,
      signal: new AbortController().signal,
      maxArtifactBytes: MiB,
    }), "UNSUPPORTED_URL")
    expect(calls).toHaveLength(0)
  })
})
