const WATCH_MAX_BYTES = 8 * 1024 * 1024
const PLAYER_MAX_BYTES = 4 * 1024 * 1024
const TIMED_TEXT_MAX_BYTES = 16 * 1024 * 1024

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

const VISIONOS_CLIENT = {
  clientName: "VISIONOS",
  clientVersion: "1.02",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  osName: "visionOS",
  osVersion: "26.5.23O471",
  hl: "en",
  gl: "US",
  timeZone: "UTC",
  utcOffsetMinutes: 0,
} as const

export interface ParsedYouTubeVideoUrl {
  videoId: string
  canonicalUrl: string
}

export interface YouTubeSourceArtifact extends ParsedYouTubeVideoUrl {
  fileName: string
  markdown: string
}

export interface ImportYouTubeUrlOptions {
  fetch: typeof globalThis.fetch
  signal: AbortSignal
  maxArtifactBytes: number
}

export type YouTubeSourceErrorCode =
  | "UNSUPPORTED_URL"
  | "ABORTED"
  | "WATCH_REQUEST_FAILED"
  | "WATCH_REDIRECT"
  | "WATCH_HTTP_ERROR"
  | "WATCH_RATE_LIMITED"
  | "WATCH_TOO_LARGE"
  | "WATCH_EMPTY"
  | "WATCH_READ_FAILED"
  | "VISITOR_DATA_MISSING"
  | "PLAYER_REQUEST_FAILED"
  | "PLAYER_REDIRECT"
  | "PLAYER_HTTP_ERROR"
  | "PLAYER_RATE_LIMITED"
  | "PLAYER_TOO_LARGE"
  | "PLAYER_EMPTY"
  | "PLAYER_READ_FAILED"
  | "PLAYER_INVALID_JSON"
  | "PLAYER_LOGIN_REQUIRED"
  | "PLAYER_BOT_CHECK"
  | "PLAYER_UNPLAYABLE"
  | "PLAYER_VIDEO_ID_MISMATCH"
  | "ORIGINAL_LANGUAGE_UNKNOWN"
  | "NO_CAPTIONS"
  | "NO_ELIGIBLE_CAPTION"
  | "CAPTION_URL_UNSAFE"
  | "TIMED_TEXT_REQUEST_FAILED"
  | "TIMED_TEXT_REDIRECT"
  | "TIMED_TEXT_HTTP_ERROR"
  | "TIMED_TEXT_RATE_LIMITED"
  | "TIMED_TEXT_TOO_LARGE"
  | "TIMED_TEXT_EMPTY"
  | "TIMED_TEXT_READ_FAILED"
  | "TIMED_TEXT_INVALID_JSON"
  | "TIMED_TEXT_NO_USABLE_CUES"
  | "ARTIFACT_TOO_LARGE"

/** A diagnostic-safe extraction error. It never includes visitor or signed URL data. */
export class YouTubeSourceError extends Error {
  readonly code: YouTubeSourceErrorCode
  readonly videoId?: string

  constructor(code: YouTubeSourceErrorCode, videoId?: string) {
    super(videoId
      ? `YouTube source import failed (${code}) for video ${videoId}`
      : `YouTube source import failed (${code})`)
    this.name = "YouTubeSourceError"
    this.code = code
    this.videoId = videoId
  }
}

type JsonObject = Record<string, unknown>
type RequestEndpoint = "WATCH" | "PLAYER" | "TIMED_TEXT"
type SafeRequestInit = RequestInit & { maxRedirections: number }

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  displayName: string
  kind: "manual" | "asr"
  translated: boolean
  dubbed: boolean
}

interface TranscriptCue {
  startMs: number
  text: string
}

interface VideoMetadata {
  title?: string
  channel?: string
  description?: string
  publicationDate?: string
  durationSeconds?: number
}

function fail(code: YouTubeSourceErrorCode, videoId?: string): never {
  throw new YouTubeSourceError(code, videoId)
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined
}

function objectAt(root: JsonObject | undefined, ...path: string[]): JsonObject | undefined {
  let current: unknown = root
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return getRecord(current)
}

function stringAt(root: JsonObject | undefined, ...path: string[]): string | undefined {
  let current: unknown = root
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return typeof current === "string" ? current : undefined
}

function remoteText(value: unknown): string {
  if (typeof value === "string") return value
  if (!isRecord(value)) return ""
  if (typeof value.simpleText === "string") return value.simpleText
  if (!Array.isArray(value.runs)) return ""
  return value.runs
    .map((run) => isRecord(run) && typeof run.text === "string" ? run.text : "")
    .join("")
}

export function parseYouTubeVideoUrl(value: string): ParsedYouTubeVideoUrl | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password || url.port) return null

  const host = url.hostname.toLowerCase()
  let videoId: string | undefined

  if (host === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length === 1) videoId = parts[0]
  } else if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    if (url.pathname === "/watch" || url.pathname === "/watch/") {
      const videoIds = url.searchParams.getAll("v")
      if (videoIds.length === 1) videoId = videoIds[0]
    } else {
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts.length === 2 && parts[0].toLowerCase() === "shorts") videoId = parts[1]
    }
  }

  if (!videoId || !VIDEO_ID_PATTERN.test(videoId)) return null
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  }
}

export function isYouTubeUrl(value: string): boolean {
  return parseYouTubeVideoUrl(value) !== null
}

function endpointCode(endpoint: RequestEndpoint, suffix: string): YouTubeSourceErrorCode {
  return `${endpoint}_${suffix}` as YouTubeSourceErrorCode
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // A response may already be errored or locked. The original failure wins.
  }
}

async function readCappedBody(
  response: Response,
  maxBytes: number,
  endpoint: RequestEndpoint,
  signal: AbortSignal,
  videoId: string,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length")
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    await cancelResponse(response)
    fail(endpointCode(endpoint, "TOO_LARGE"), videoId)
  }

  if (!response.body) fail(endpointCode(endpoint, "EMPTY"), videoId)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const cancelForAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancelForAbort, { once: true })

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined)
        fail("ABORTED", videoId)
      }
      const { done, value } = await reader.read()
      if (signal.aborted) fail("ABORTED", videoId)
      if (done) break
      if (!value || value.byteLength === 0) continue
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        fail(endpointCode(endpoint, "TOO_LARGE"), videoId)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof YouTubeSourceError) throw error
    if (signal.aborted) fail("ABORTED", videoId)
    fail(endpointCode(endpoint, "READ_FAILED"), videoId)
  } finally {
    signal.removeEventListener("abort", cancelForAbort)
    reader.releaseLock()
  }

  if (totalBytes === 0) fail(endpointCode(endpoint, "EMPTY"), videoId)
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function requestText(
  fetch: typeof globalThis.fetch,
  url: string,
  init: SafeRequestInit,
  endpoint: RequestEndpoint,
  maxBytes: number,
  videoId: string,
): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    if (init.signal?.aborted) fail("ABORTED", videoId)
    fail(endpointCode(endpoint, "REQUEST_FAILED"), videoId)
  }

  if (response.status >= 300 && response.status < 400) {
    await cancelResponse(response)
    fail(endpointCode(endpoint, "REDIRECT"), videoId)
  }
  if (!response.ok) {
    await cancelResponse(response)
    if (response.status === 429) fail(endpointCode(endpoint, "RATE_LIMITED"), videoId)
    fail(endpointCode(endpoint, "HTTP_ERROR"), videoId)
  }

  const bytes = await readCappedBody(response, maxBytes, endpoint, init.signal as AbortSignal, videoId)
  const text = new TextDecoder().decode(bytes)
  if (!text.trim()) fail(endpointCode(endpoint, "EMPTY"), videoId)
  return text
}

function scanBalancedJsonObject(source: string, start: number): string | null {
  if (source[start] !== "{") return null
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === "{") {
      depth += 1
    } else if (char === "}") {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

function extractVisitorData(watchPage: string, videoId: string): string {
  const matcher = /\bytcfg\s*\.\s*set\s*\(/g
  for (let match = matcher.exec(watchPage); match; match = matcher.exec(watchPage)) {
    let start = matcher.lastIndex
    while (/\s/.test(watchPage[start] ?? "")) start += 1
    const jsonText = scanBalancedJsonObject(watchPage, start)
    if (!jsonText) continue
    let config: unknown
    try {
      config = JSON.parse(jsonText)
    } catch {
      continue
    }
    if (!isRecord(config)) continue
    const directVisitorData = typeof config.VISITOR_DATA === "string" ? config.VISITOR_DATA : undefined
    const visitorData = directVisitorData?.trim()
      ? directVisitorData
      : stringAt(config, "INNERTUBE_CONTEXT", "client", "visitorData")
    if (visitorData?.trim()) return visitorData
  }
  fail("VISITOR_DATA_MISSING", videoId)
}

function parseJsonObject(text: string, code: YouTubeSourceErrorCode, videoId: string): JsonObject {
  try {
    const value: unknown = JSON.parse(text)
    if (isRecord(value)) return value
  } catch {
    // Fall through to the stable diagnostic below.
  }
  fail(code, videoId)
}

function normalizeSingleLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return normalized || undefined
}

function normalizeDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return normalized || undefined
}

function normalizeLanguageCode(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().replace(/_/g, "-").replace(/^a-/, "").toLowerCase()
  return /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(normalized) ? normalized : undefined
}

function primaryLanguage(value: string): string {
  return value.split("-", 1)[0]
}

function audioTrackLanguage(track: JsonObject): string | undefined {
  const direct = normalizeLanguageCode(typeof track.languageCode === "string" ? track.languageCode : undefined)
  if (direct) return direct
  const id = typeof track.audioTrackId === "string"
    ? track.audioTrackId
    : typeof track.id === "string" ? track.id : undefined
  if (!id) return undefined
  return normalizeLanguageCode(id.split(".", 1)[0])
}

function hasQueryParameter(baseUrl: string, name: string): boolean {
  try {
    for (const key of new URL(baseUrl).searchParams.keys()) {
      if (key.toLowerCase() === name) return true
    }
  } catch {
    return false
  }
  return false
}

function parseCaptionTracks(player: JsonObject, videoId: string): CaptionTrack[] {
  const renderer = objectAt(player, "captions", "playerCaptionsTracklistRenderer")
  if (!renderer) fail("NO_CAPTIONS", videoId)
  const rawTracks = renderer.captionTracks
  if (!Array.isArray(rawTracks) || rawTracks.length === 0) fail("NO_CAPTIONS", videoId)

  const tracks: CaptionTrack[] = []
  for (const value of rawTracks) {
    if (!isRecord(value)) continue
    const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : ""
    const languageCode = normalizeLanguageCode(
      typeof value.languageCode === "string" ? value.languageCode : undefined,
    )
    if (!baseUrl || !languageCode) continue
    const displayName = normalizeSingleLine(remoteText(value.name) || remoteText(value.displayName)) ?? languageCode
    const dubbedText = `${displayName} ${typeof value.audioTrackId === "string" ? value.audioTrackId : ""}`
    tracks.push({
      baseUrl,
      languageCode,
      displayName,
      kind: value.kind === "asr" ? "asr" : "manual",
      translated: hasQueryParameter(baseUrl, "tlang"),
      dubbed: value.isDubbed === true || /\bdubb(?:ed|ing)?\b/i.test(dubbedText),
    })
  }
  if (tracks.length === 0) fail("NO_CAPTIONS", videoId)
  return tracks
}

function streamingAudioTracks(player: JsonObject): JsonObject[] {
  const streamingData = getRecord(player.streamingData)
  const deduplicated = new Map<string, JsonObject>()

  for (const key of ["formats", "adaptiveFormats"] as const) {
    const formats = streamingData?.[key]
    if (!Array.isArray(formats)) continue
    for (const format of formats) {
      const audioTrack = isRecord(format) ? getRecord(format.audioTrack) : undefined
      if (!audioTrack) continue
      const id = normalizeSingleLine(
        typeof audioTrack.id === "string"
          ? audioTrack.id
          : typeof audioTrack.audioTrackId === "string" ? audioTrack.audioTrackId : undefined,
      )
      const displayName = normalizeSingleLine(remoteText(audioTrack.displayName)) ?? ""
      const languageCode = normalizeLanguageCode(
        typeof audioTrack.languageCode === "string" ? audioTrack.languageCode : undefined,
      ) ?? ""
      const identity = id
        ? `id:${id}`
        : `fallback:${languageCode}\u0000${displayName}\u0000${String(audioTrack.audioIsDefault === true)}`
      if (!deduplicated.has(identity)) deduplicated.set(identity, audioTrack)
    }
  }
  return [...deduplicated.values()]
}

function resolveOriginalLanguage(player: JsonObject, tracks: CaptionTrack[], videoId: string): string {
  const audioTracks = streamingAudioTracks(player)
  const originalAudioTracks = audioTracks.filter((track) => {
    const displayName = normalizeSingleLine(remoteText(track.displayName)) ?? ""
    const id = typeof track.audioTrackId === "string"
      ? track.audioTrackId
      : typeof track.id === "string" ? track.id : ""
    return /\boriginal\b/i.test(displayName)
      && !/\bdubb(?:ed|ing)?\b/i.test(`${displayName} ${id}`)
      && track.isDubbed !== true
  })

  if (originalAudioTracks.length === 1) {
    const language = audioTrackLanguage(originalAudioTracks[0])
    if (language) return language
    fail("ORIGINAL_LANGUAGE_UNKNOWN", videoId)
  }
  if (originalAudioTracks.length > 1) fail("ORIGINAL_LANGUAGE_UNKNOWN", videoId)

  const asrTracks = tracks.filter((track) => track.kind === "asr" && !track.translated && !track.dubbed)
  if (asrTracks.length === 1) return asrTracks[0].languageCode
  fail("ORIGINAL_LANGUAGE_UNKNOWN", videoId)
}

function selectUniqueTrack(
  tracks: CaptionTrack[],
  originalLanguage: string,
  kind: CaptionTrack["kind"],
): CaptionTrack | undefined {
  const candidates = tracks.filter((track) => track.kind === kind && !track.translated && !track.dubbed)
  const exact = candidates.filter((track) => track.languageCode === originalLanguage)
  if (exact.length > 0) return exact[0]
  const samePrimary = candidates.filter(
    (track) => primaryLanguage(track.languageCode) === primaryLanguage(originalLanguage),
  )
  return samePrimary.length === 1 ? samePrimary[0] : undefined
}

function selectCaptionTrack(player: JsonObject, videoId: string): { track: CaptionTrack; originalLanguage: string } {
  const tracks = parseCaptionTracks(player, videoId)
  const originalLanguage = resolveOriginalLanguage(player, tracks, videoId)
  const track = selectUniqueTrack(tracks, originalLanguage, "manual")
    ?? selectUniqueTrack(tracks, originalLanguage, "asr")
  if (!track) fail("NO_ELIGIBLE_CAPTION", videoId)
  return { track, originalLanguage }
}

function validateTimedTextUrl(baseUrl: string, videoId: string, languageCode: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    fail("CAPTION_URL_UNSAFE", videoId)
  }

  if (url.protocol !== "https:"
    || url.hostname !== "www.youtube.com"
    || url.port
    || url.username
    || url.password
    || url.pathname !== "/api/timedtext") {
    fail("CAPTION_URL_UNSAFE", videoId)
  }

  const videoIds = url.searchParams.getAll("v")
  if (videoIds.length !== 1 || videoIds[0] !== videoId) fail("CAPTION_URL_UNSAFE", videoId)
  const languages = url.searchParams.getAll("lang")
  if (languages.length !== 1 || normalizeLanguageCode(languages[0]) !== languageCode) {
    fail("CAPTION_URL_UNSAFE", videoId)
  }

  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey === "tlang"
      || normalizedKey === "xpe"
      || normalizedKey === "xpv"
      || normalizedKey === "pot"
      || normalizedKey === "potc"
      || normalizedKey === "potoken"
      || normalizedKey === "serviceintegritydimensions"
      || (normalizedKey === "exp" && /x(?:pe|pv)/i.test(value))) {
      fail("CAPTION_URL_UNSAFE", videoId)
    }
  }

  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "xosf") url.searchParams.delete(key)
  }
  url.searchParams.set("fmt", "json3")
  return url.toString()
}

function validatePlayer(player: JsonObject, videoId: string): void {
  const playability = getRecord(player.playabilityStatus)
  const status = typeof playability?.status === "string" ? playability.status : ""
  if (status !== "OK") {
    const reason = `${remoteText(playability?.reason)} ${remoteText(playability?.messages)}`
    if (/\bbot\b|unusual traffic|captcha/i.test(reason)) fail("PLAYER_BOT_CHECK", videoId)
    if (status === "LOGIN_REQUIRED") fail("PLAYER_LOGIN_REQUIRED", videoId)
    fail("PLAYER_UNPLAYABLE", videoId)
  }

  const returnedVideoId = stringAt(player, "videoDetails", "videoId")
  if (returnedVideoId !== videoId) fail("PLAYER_VIDEO_ID_MISMATCH", videoId)
}

function readMetadata(player: JsonObject): VideoMetadata {
  const details = getRecord(player.videoDetails)
  const microformat = objectAt(player, "microformat", "playerMicroformatRenderer")
  const durationValue = details?.lengthSeconds
  const durationSeconds = typeof durationValue === "string" || typeof durationValue === "number"
    ? Number(durationValue)
    : Number.NaN

  return {
    title: normalizeSingleLine(typeof details?.title === "string" ? details.title : undefined),
    channel: normalizeSingleLine(
      typeof details?.author === "string"
        ? details.author
        : typeof microformat?.ownerChannelName === "string" ? microformat.ownerChannelName : undefined,
    ),
    description: normalizeDescription(
      typeof details?.shortDescription === "string" ? details.shortDescription : undefined,
    ),
    publicationDate: normalizeSingleLine(
      typeof microformat?.publishDate === "string"
        ? microformat.publishDate
        : typeof microformat?.uploadDate === "string" ? microformat.uploadDate : undefined,
    ),
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 0
      ? Math.floor(durationSeconds)
      : undefined,
  }
}

function normalizeCueText(value: string): string {
  return value
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function parseJson3(text: string, videoId: string): TranscriptCue[] {
  const root = parseJsonObject(text, "TIMED_TEXT_INVALID_JSON", videoId)
  if (!Array.isArray(root.events)) fail("TIMED_TEXT_INVALID_JSON", videoId)

  const cues: TranscriptCue[] = []
  for (const value of root.events) {
    if (!isRecord(value)) continue
    const startMs = value.tStartMs
    if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) continue
    if (!Array.isArray(value.segs)) continue
    const text = normalizeCueText(value.segs
      .map((segment) => isRecord(segment) && typeof segment.utf8 === "string" ? segment.utf8 : "")
      .join(""))
    if (!text) continue
    cues.push({ startMs, text })
  }
  if (cues.length === 0) fail("TIMED_TEXT_NO_USABLE_CUES", videoId)
  return cues
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`
}

function formatTimestamp(startMs: number): string {
  const wholeMilliseconds = Math.floor(startMs)
  const hours = Math.floor(wholeMilliseconds / 3_600_000)
  const minutes = Math.floor((wholeMilliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((wholeMilliseconds % 60_000) / 1_000)
  const milliseconds = wholeMilliseconds % 1_000
  const secondPart = `${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secondPart}`
    : `${String(minutes).padStart(2, "0")}:${secondPart}`
}

function renderMarkdown(
  parsed: ParsedYouTubeVideoUrl,
  metadata: VideoMetadata,
  track: CaptionTrack,
  cues: TranscriptCue[],
): string {
  const lines: string[] = []
  if (metadata.title) lines.push(`# ${metadata.title}`, "")
  lines.push(`Source URL: ${parsed.canonicalUrl}`, `Video ID: ${parsed.videoId}`)
  if (metadata.channel) lines.push(`Channel: ${metadata.channel}`)
  if (metadata.publicationDate) lines.push(`Published: ${metadata.publicationDate}`)
  if (metadata.durationSeconds !== undefined) lines.push(`Duration: ${formatDuration(metadata.durationSeconds)}`)
  lines.push(
    `Transcript language: ${track.languageCode}`,
    `Transcript type: ${track.kind === "asr" ? "automatic (ASR)" : "manual"}`,
  )
  if (metadata.description) lines.push("", "## Description", "", metadata.description)
  lines.push("", "## Transcript", "")
  for (const cue of cues) lines.push(`[${formatTimestamp(cue.startMs)}] ${cue.text}`)
  return `${lines.join("\n")}\n`
}

function requestInit(signal: AbortSignal, init: RequestInit = {}): SafeRequestInit {
  return {
    ...init,
    credentials: "omit",
    redirect: "manual",
    maxRedirections: 0,
    signal,
  }
}

export async function importYouTubeUrl(
  value: string,
  options: ImportYouTubeUrlOptions,
): Promise<YouTubeSourceArtifact> {
  const parsed = parseYouTubeVideoUrl(value)
  if (!parsed) fail("UNSUPPORTED_URL")
  if (options.signal.aborted) fail("ABORTED", parsed.videoId)

  const watchPage = await requestText(
    options.fetch,
    parsed.canonicalUrl,
    requestInit(options.signal, { method: "GET" }),
    "WATCH",
    WATCH_MAX_BYTES,
    parsed.videoId,
  )
  const visitorData = extractVisitorData(watchPage, parsed.videoId)

  const playerBody = JSON.stringify({
    context: {
      client: {
        ...VISIONOS_CLIENT,
        visitorData,
      },
    },
    videoId: parsed.videoId,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: "HTML5_PREF_WANTS",
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  })
  const playerText = await requestText(
    options.fetch,
    PLAYER_URL,
    requestInit(options.signal, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://www.youtube.com",
        "user-agent": VISIONOS_CLIENT.userAgent,
        "x-youtube-client-name": "101",
        "x-youtube-client-version": VISIONOS_CLIENT.clientVersion,
        "x-goog-visitor-id": visitorData,
      },
      body: playerBody,
    }),
    "PLAYER",
    PLAYER_MAX_BYTES,
    parsed.videoId,
  )
  const player = parseJsonObject(playerText, "PLAYER_INVALID_JSON", parsed.videoId)
  validatePlayer(player, parsed.videoId)
  const metadata = readMetadata(player)
  const { track } = selectCaptionTrack(player, parsed.videoId)
  const timedTextUrl = validateTimedTextUrl(track.baseUrl, parsed.videoId, track.languageCode)

  const timedText = await requestText(
    options.fetch,
    timedTextUrl,
    requestInit(options.signal, { method: "GET" }),
    "TIMED_TEXT",
    TIMED_TEXT_MAX_BYTES,
    parsed.videoId,
  )
  const cues = parseJson3(timedText, parsed.videoId)
  const markdown = renderMarkdown(parsed, metadata, track, cues)
  if (!Number.isFinite(options.maxArtifactBytes)
    || options.maxArtifactBytes < 0
    || new TextEncoder().encode(markdown).byteLength > options.maxArtifactBytes) {
    fail("ARTIFACT_TOO_LARGE", parsed.videoId)
  }

  return {
    ...parsed,
    fileName: `youtube-${parsed.videoId}.md`,
    markdown,
  }
}
