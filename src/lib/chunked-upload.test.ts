// Chunked-upload client tests (issue #14 P2 stage 5).
//
// Mocks the api/ingest module (multipart upload + enqueue-by-path) and stubs
// global fetch for the chunked protocol itself, so init/chunk/complete run
// through the REAL request()/parseError paths of src/api/client.ts. The fake
// fetch mirrors the server semantics (uploads/chunked.js): a chunk PUT answers
// {received} = offset + bytes, and offset mismatches are scripted per test as
// 400 + details.received (the resume channel).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/api/ingest", () => ({
  uploadForIngest: vi.fn(),
  enqueueByPath: vi.fn(),
}))

import type { IngestEnqueueResponse } from "@llm-wiki/api-types"
import { enqueueByPath, uploadForIngest } from "@/api/ingest"
import { ApiError } from "@/api/client"
import { CHUNK_SIZE, MULTIPART_MAX_BYTES, uploadFileAuto } from "./chunked-upload"

const mockUploadForIngest = vi.mocked(uploadForIngest)
const mockEnqueueByPath = vi.mocked(enqueueByPath)

const MB = 1024 * 1024
const SMALL_SIZE = 9 * MB
const LARGE_SIZE = 11 * MB
const PROJECT_ID = "uuid-proj-1"
const UPLOAD_ID = "upload-abc-123"
const COMPLETE_PATH = "raw/sources/1754300000000_deadbeef_big.bin"
const ENQUEUE_RESPONSE: IngestEnqueueResponse = {
  taskId: 7,
  filePath: COMPLETE_PATH,
  status: "pending",
}

interface PutCall {
  uploadId: string
  offset: number
  size: number
  firstByte: number
  lastByte: number
}

let putCalls: PutCall[] = []
let initCalls: Array<{ fileName: string; fileSize: number; destPath: string }> = []
let completeCalls: string[] = []
/** Per-call (0-based) scripted PUT responses; absent → success {received}. */
let putScript: Array<((call: PutCall) => Response) | undefined> = []

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function errorResponse(status: number, code: string, message: string, details: unknown): Response {
  return jsonResponse({ error: { code, message, details } }, status)
}

/** Deterministic content: 1 MiB blocks, block i filled with byte (i + 1). */
function makeFile(name: string, size: number): File {
  const blockSize = MB
  const blocks: BlobPart[] = []
  for (let start = 0; start < size; start += blockSize) {
    const blockIndex = start / blockSize
    const block = new Uint8Array(Math.min(blockSize, size - start))
    block.fill(blockIndex + 1)
    blocks.push(block.buffer as ArrayBuffer)
  }
  return new File(blocks, name, { type: "application/octet-stream" })
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = (init?.method ?? "GET").toUpperCase()

  if (method === "POST" && url.endsWith("/files/upload/init")) {
    initCalls.push(JSON.parse(String(init?.body)))
    return jsonResponse({ uploadId: UPLOAD_ID }, 201)
  }

  if (method === "PUT") {
    const match = /\/files\/upload\/([^/]+)\/chunk\?offset=(\d+)$/.exec(url)
    if (!match) throw new Error(`Unexpected PUT url in chunked-upload test: ${url}`)
    const body = new Uint8Array(await (init?.body as Blob).arrayBuffer())
    const call: PutCall = {
      uploadId: match[1],
      offset: Number(match[2]),
      size: body.length,
      firstByte: body[0] ?? -1,
      lastByte: body[body.length - 1] ?? -1,
    }
    putCalls.push(call)
    const scripted = putScript[putCalls.length - 1]
    return scripted ? scripted(call) : jsonResponse({ received: call.offset + call.size })
  }

  if (method === "POST" && url.endsWith(`/files/upload/${UPLOAD_ID}/complete`)) {
    completeCalls.push(url)
    return jsonResponse({ path: COMPLETE_PATH, size: LARGE_SIZE })
  }

  throw new Error(`Unexpected fetch in chunked-upload test: ${method} ${url}`)
})

beforeEach(() => {
  putCalls = []
  initCalls = []
  completeCalls = []
  putScript = []
  vi.stubGlobal("fetch", fakeFetch)
  fakeFetch.mockClear()
  mockUploadForIngest.mockReset()
  mockUploadForIngest.mockResolvedValue({
    taskId: 42,
    filePath: "raw/sources/small.bin",
    status: "pending",
  })
  mockEnqueueByPath.mockReset()
  mockEnqueueByPath.mockResolvedValue(ENQUEUE_RESPONSE)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("uploadFileAuto size dispatch (charter §4.8)", () => {
  it("≤10MB takes the one-shot multipart route and never opens a chunked session", async () => {
    const file = makeFile("small.bin", SMALL_SIZE)
    const onProgress = vi.fn()

    const res = await uploadFileAuto(PROJECT_ID, file, { onProgress })

    expect(mockUploadForIngest).toHaveBeenCalledTimes(1)
    expect(mockUploadForIngest).toHaveBeenCalledWith(PROJECT_ID, file)
    expect(fakeFetch).not.toHaveBeenCalled() // no init / chunk / complete
    expect(mockEnqueueByPath).not.toHaveBeenCalled() // multipart auto-enqueues
    expect(res.taskId).toBe(42)
    // Progress reports (size, size) after the successful upload.
    expect(onProgress).toHaveBeenCalledWith(SMALL_SIZE, SMALL_SIZE)
  })

  it("the MULTIPART_MAX_BYTES boundary itself stays multipart", async () => {
    const file = makeFile("edge.bin", MULTIPART_MAX_BYTES)

    await uploadFileAuto(PROJECT_ID, file)

    expect(mockUploadForIngest).toHaveBeenCalledTimes(1)
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it(">10MB takes init → chunks → complete → enqueueByPath, never multipart", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)

    const res = await uploadFileAuto(PROJECT_ID, file)

    expect(mockUploadForIngest).not.toHaveBeenCalled()
    expect(initCalls).toHaveLength(1)
    expect(putCalls.length).toBeGreaterThanOrEqual(3)
    expect(completeCalls).toHaveLength(1)
    expect(mockEnqueueByPath).toHaveBeenCalledTimes(1)
    expect(mockEnqueueByPath).toHaveBeenCalledWith(PROJECT_ID, COMPLETE_PATH)
    expect(res).toEqual(ENQUEUE_RESPONSE)
  })
})

describe("chunk sequence", () => {
  it("11MB uploads as exactly 3 PUTs (5MB/5MB/1MB) at offsets 0, 5242880, 10485760", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)

    await uploadFileAuto(PROJECT_ID, file)

    expect(putCalls).toHaveLength(3)
    expect(putCalls.map((c) => c.offset)).toEqual([0, CHUNK_SIZE, 2 * CHUNK_SIZE])
    expect(putCalls.map((c) => c.size)).toEqual([CHUNK_SIZE, CHUNK_SIZE, LARGE_SIZE - 2 * CHUNK_SIZE])
    // Each body is the matching file slice — content blocks are byte-filled
    // with block-index+1, so the first/last bytes identify the slice range.
    expect(putCalls.map((c) => [c.firstByte, c.lastByte])).toEqual([
      [1, 5], // bytes 0..5MB-1 → blocks 1-5
      [6, 10], // bytes 5MB..10MB-1 → blocks 6-10
      [11, 11], // bytes 10MB..11MB-1 → block 11
    ])
    expect(putCalls.every((c) => c.uploadId === UPLOAD_ID)).toBe(true)
  })

  it("init carries fileName/fileSize and a raw/sources destPath mirroring the server naming", async () => {
    const file = makeFile("My Report (final).pdf", LARGE_SIZE)

    await uploadFileAuto(PROJECT_ID, file)

    expect(initCalls).toHaveLength(1)
    expect(initCalls[0].fileName).toBe("My Report (final).pdf")
    expect(initCalls[0].fileSize).toBe(LARGE_SIZE)
    // raw/sources/<ts>_<hex8>_<sanitized basename> (api/ingest.js parity —
    // every char outside [a-zA-Z0-9._-] becomes "_", parens included).
    expect(initCalls[0].destPath).toMatch(/^raw\/sources\/\d+_[0-9a-f]{8}_My_Report__final_\.pdf$/)
  })
})

describe("resume via 400 details.received (the resume channel)", () => {
  it("adopts the server byte count after an offset mismatch and resumes from it", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)
    // The second PUT (offset 5MB) is answered as the server answers an
    // offset-mismatched chunk: 400 + details.received = its byte count —
    // here the server has 6MB (e.g. 1MB of that chunk actually landed).
    putScript[1] = () =>
      errorResponse(400, "VALIDATION_ERROR", "Chunk offset does not match server byte count", {
        received: 6 * MB,
      })

    const res = await uploadFileAuto(PROJECT_ID, file)

    // PUT sequence: 0 ✓, 5MB ✗(400), then resume at 6MB. Since 6MB+5MB
    // reaches the 11MB end, the resumed chunk completes the file (3 PUTs).
    expect(putCalls.map((c) => c.offset)).toEqual([0, CHUNK_SIZE, 6 * MB])
    expect(putCalls.map((c) => c.size)).toEqual([
      CHUNK_SIZE,
      CHUNK_SIZE,
      LARGE_SIZE - 6 * MB, // re-sliced remainder [6MB, 11MB)
    ])
    // The resumed body is exactly file.slice(6MB, 11MB): blocks 7-11.
    expect(putCalls[2].firstByte).toBe(7)
    expect(putCalls[2].lastByte).toBe(11)
    expect(completeCalls).toHaveLength(1)
    expect(mockEnqueueByPath).toHaveBeenCalledTimes(1)
    expect(mockEnqueueByPath).toHaveBeenCalledWith(PROJECT_ID, COMPLETE_PATH)
    expect(res.taskId).toBe(7)
  })

  it("a resent FINAL chunk (400 details.received === fileSize) exits the loop straight to complete", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)
    // The final chunk's 200 was lost; the server answers the resend with the
    // resume channel reporting ALL bytes already received. The client must
    // adopt fileSize, skip any resend, and proceed to complete + enqueue.
    putScript[2] = () =>
      errorResponse(400, "VALIDATION_ERROR", "Chunk offset does not match server byte count", {
        received: LARGE_SIZE,
      })

    const res = await uploadFileAuto(PROJECT_ID, file)

    // Exactly the three chunk PUTs — no degenerate empty resend at offset
    // fileSize — then complete + enqueue once each.
    expect(putCalls.map((c) => c.offset)).toEqual([0, CHUNK_SIZE, 2 * CHUNK_SIZE])
    expect(completeCalls).toHaveLength(1)
    expect(mockEnqueueByPath).toHaveBeenCalledTimes(1)
    expect(mockEnqueueByPath).toHaveBeenCalledWith(PROJECT_ID, COMPLETE_PATH)
    expect(res).toEqual(ENQUEUE_RESPONSE)
  })
})

describe("transient retry", () => {
  it("a chunk PUT failing with 500 is retried and the upload still completes", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)
    // Chunk 2, attempt 1 → 500; the retry succeeds (absent script entry).
    putScript[1] = () => errorResponse(500, "INTERNAL_ERROR", "boom", null)

    const res = await uploadFileAuto(PROJECT_ID, file)

    const chunk2Attempts = putCalls.filter((c) => c.offset === CHUNK_SIZE)
    expect(chunk2Attempts.length).toBe(2) // retried once, within the 3-attempt budget
    expect(putCalls.map((c) => c.offset)).toEqual([0, CHUNK_SIZE, CHUNK_SIZE, 2 * CHUNK_SIZE])
    expect(completeCalls).toHaveLength(1)
    expect(mockEnqueueByPath).toHaveBeenCalledTimes(1)
    expect(res).toEqual(ENQUEUE_RESPONSE)
  })

  it("rejects after 3 failed attempts and never completes or enqueues", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)
    const serverError = () => errorResponse(500, "INTERNAL_ERROR", "boom", null)
    putScript[0] = serverError
    putScript[1] = serverError
    putScript[2] = serverError

    await expect(uploadFileAuto(PROJECT_ID, file)).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    })

    expect(putCalls).toHaveLength(3) // exactly the attempt budget, all chunk 1
    expect(putCalls.every((c) => c.offset === 0)).toBe(true)
    expect(completeCalls).toHaveLength(0)
    expect(mockEnqueueByPath).not.toHaveBeenCalled()
  })

  it("surfaces aborts without retrying", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)
    const controller = new AbortController()
    putScript[0] = () => {
      controller.abort()
      return errorResponse(500, "INTERNAL_ERROR", "boom", null)
    }

    await expect(uploadFileAuto(PROJECT_ID, file, { signal: controller.signal })).rejects.toMatchObject({
      status: 500,
    })
    expect(putCalls).toHaveLength(1) // aborted → no retry
    expect(mockEnqueueByPath).not.toHaveBeenCalled()
  })
})

describe("progress", () => {
  it("onProgress strictly increases and ends at (size, size)", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)
    const calls: Array<[number, number]> = []

    await uploadFileAuto(PROJECT_ID, file, {
      onProgress: (sent, total) => calls.push([sent, total]),
    })

    expect(calls.length).toBe(3) // one per confirmed chunk
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i][0]).toBeGreaterThan(calls[i - 1][0])
    }
    for (const [, total] of calls) expect(total).toBe(LARGE_SIZE)
    expect(calls[calls.length - 1]).toEqual([LARGE_SIZE, LARGE_SIZE])
  })

  it("progress reflects the resume point, not the stale client offset", async () => {
    const file = makeFile("big.bin", LARGE_SIZE)
    const calls: Array<[number, number]> = []
    putScript[1] = () =>
      errorResponse(400, "VALIDATION_ERROR", "offset mismatch", { received: 6 * MB })

    await uploadFileAuto(PROJECT_ID, file, {
      onProgress: (sent, total) => calls.push([sent, total]),
    })

    // Chunk 2 resumes at 6MB and its re-sliced PUT confirms the remaining
    // 5MB (11MB total) — the reported byte counts stay strictly increasing
    // through the resume. (Resume happens inside putChunkWithRetry, so one
    // progress report per confirmed PUT.)
    expect(calls.map(([sent]) => sent)).toEqual([CHUNK_SIZE, LARGE_SIZE])
  })
})

describe("low-level helpers", () => {
  it("chunkedUploadInit/putChunk/complete hit the charter routes", async () => {
    // Lazy import keeps the describe focus on the exported protocol helpers.
    const { chunkedUploadInit, chunkedUploadPutChunk, chunkedUploadComplete } = await import(
      "./chunked-upload"
    )

    const { uploadId } = await chunkedUploadInit(PROJECT_ID, {
      fileName: "a.bin",
      fileSize: LARGE_SIZE,
      destPath: "raw/sources/a.bin",
    })
    expect(uploadId).toBe(UPLOAD_ID)
    expect(fakeFetch).toHaveBeenCalledWith(
      `/api/v2/projects/${PROJECT_ID}/files/upload/init`,
      expect.objectContaining({ method: "POST" }),
    )

    const { received } = await chunkedUploadPutChunk(PROJECT_ID, uploadId, 0, new Blob([new Uint8Array(8)]))
    expect(received).toBe(8)

    const done = await chunkedUploadComplete(PROJECT_ID, uploadId)
    expect(done).toEqual({ path: COMPLETE_PATH, size: LARGE_SIZE })
  })

  it("a non-2xx chunk PUT rejects with an ApiError preserving the envelope details", async () => {
    const { chunkedUploadPutChunk } = await import("./chunked-upload")
    putScript[0] = () =>
      errorResponse(400, "VALIDATION_ERROR", "Chunk offset 8 does not match server byte count", {
        received: 5,
      })

    const err = await chunkedUploadPutChunk(PROJECT_ID, "up-1", 8, new Blob([new Uint8Array(3)])).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, code: "VALIDATION_ERROR", details: { received: 5 } })
  })
})
