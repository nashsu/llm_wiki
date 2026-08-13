import { getFileSize, readFileAsBase64 } from "@/commands/fs"
import { getHttpFetch } from "@/lib/tauri-fetch"
import type { MediaIngestConfig } from "@/stores/wiki-store"

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
const GROQ_MODEL = "whisper-large-v3-turbo"

// Groq's hard upload limit; ffmpeg's mono/16kHz/32kbps extraction (Task 5)
// keeps most sources well under this, but long meeting recordings (1-2h)
// can still exceed it — split into equal byte ranges rather than failing.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

interface ByteRange {
  startByte: number
  endByte: number
}

export function splitBySizeForTest(totalBytes: number, maxBytes: number): ByteRange[] {
  if (totalBytes <= maxBytes) return [{ startByte: 0, endByte: totalBytes }]
  const segmentCount = Math.ceil(totalBytes / maxBytes)
  const segmentSize = Math.ceil(totalBytes / segmentCount)
  const segments: ByteRange[] = []
  for (let start = 0; start < totalBytes; start += segmentSize) {
    segments.push({ startByte: start, endByte: Math.min(start + segmentSize, totalBytes) })
  }
  return segments
}

interface TranscriptionRequest {
  url: string
  headers: Record<string, string>
  model: string
}

export function buildTranscriptionRequestForTest(config: MediaIngestConfig): TranscriptionRequest {
  if (config.audioVideoBackend === "custom") {
    const base = config.audioVideoCustomEndpoint.replace(/\/+$/, "")
    return {
      url: `${base}/audio/transcriptions`,
      headers: config.audioVideoCustomToken
        ? { Authorization: `Bearer ${config.audioVideoCustomToken}` }
        : {},
      // Custom endpoints don't necessarily speak Groq's exact model name —
      // "whisper-1" is the de facto OpenAI-compatible default most
      // self-hosted/third-party Whisper servers accept.
      model: "whisper-1",
    }
  }
  return {
    url: GROQ_TRANSCRIPTION_URL,
    headers: { Authorization: `Bearer ${config.audioVideoToken}` },
    model: GROQ_MODEL,
  }
}

async function transcribeSegment(
  audioBytes: Uint8Array,
  fileName: string,
  request: TranscriptionRequest,
  signal?: AbortSignal,
): Promise<string> {
  const httpFetch = await getHttpFetch()
  const form = new FormData()
  form.append("file", new Blob([bytesToUploadBody(audioBytes)], { type: "audio/mpeg" }), fileName)
  form.append("model", request.model)

  const response = await httpFetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: form,
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Transcription request failed: HTTP ${response.status}: ${text}`)
  }
  const json = (await response.json()) as { text?: string }
  // `""` is a legitimate result (silent segment). A *missing* field means the
  // endpoint answered with a shape we don't understand — defaulting that to ""
  // would silently drop a whole segment out of a joined transcript.
  if (typeof json.text !== "string") {
    throw new Error("Transcription response missing 'text' field")
  }
  return json.text.trim()
}

/**
 * Transcribes an audio file (already extracted/compressed by
 * `extract_audio_track`) via Groq or a custom OpenAI-compatible endpoint.
 * Splits into byte-range segments when the file exceeds Groq's 25MB
 * upload limit, transcribing each segment independently and joining the
 * results with blank lines — segment boundaries may cut mid-sentence,
 * which is an acceptable trade-off for very long recordings versus
 * failing outright.
 */
export async function transcribeAudio(
  audioPath: string,
  config: MediaIngestConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (config.audioVideoBackend === "groq" && !config.audioVideoToken.trim()) {
    throw new Error("Groq API token is not configured (Settings → Media ingestion)")
  }
  if (config.audioVideoBackend === "custom" && !config.audioVideoCustomEndpoint.trim()) {
    throw new Error("Custom transcription endpoint is not configured (Settings → Media ingestion)")
  }

  const request = buildTranscriptionRequestForTest(config)
  const totalBytes = await getFileSize(audioPath)
  const segments = splitBySizeForTest(totalBytes, MAX_UPLOAD_BYTES)
  const fileName = audioPath.split("/").pop() ?? "audio.mp3"
  const { base64 } = await readFileAsBase64(audioPath)
  const fullBytes = base64ToBytes(base64)

  if (segments.length === 1) {
    return transcribeSegment(fullBytes, fileName, request, signal)
  }

  const transcripts: string[] = []
  for (const segment of segments) {
    const chunk = fullBytes.slice(segment.startByte, segment.endByte)
    transcripts.push(await transcribeSegment(chunk, fileName, request, signal))
  }
  return transcripts.join("\n\n")
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Same `Uint8Array` -> `ArrayBuffer` narrowing MinerU's upload path uses. */
function bytesToUploadBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
