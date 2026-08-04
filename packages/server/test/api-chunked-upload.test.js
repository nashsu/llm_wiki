// Server tests for the chunked-upload protocol (issue #14 P2, Decision 15):
// happy path with byte-integrity, the resume channel (400 + details.received),
// offset replay, chunk overflow, incomplete complete, oversize init 413,
// traversal FORBIDDEN, unknown-id NOT_FOUND, overwrite → file:modified, the
// env-driven multipart cap + MulterError→413 mapping, cross-project session
// isolation, and the TTL sweep.
//
// Env vars — including LLM_WIKI_MAX_UPLOAD_MB=5 so both caps are testable
// with small buffers — are set BEFORE the app module is imported (config is
// read at module load). The orchestrator module is mocked so the multipart
// cap test never starts an ingest pipeline.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import request from "supertest"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-chunked-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
process.env.LLM_WIKI_MAX_UPLOAD_MB = "5"
delete process.env.LLM_WIKI_API_TOKEN

vi.mock("../src/ingest/orchestrator.js", () => ({
  MAX_ATTEMPTS: 3,
  startIngestOrchestrator: vi.fn(),
  stopIngestOrchestrator: vi.fn(),
  kickIngestOrchestrator: vi.fn(),
  cancelIngestTask: vi.fn(async () => true),
  activeIngestTaskCount: () => 0,
  __resetOrchestratorForTests: vi.fn(),
}))

const { app } = await import("../src/index-v2.js")
const { eventBus, EventTypes } = await import("../src/events/bus.js")

const CHUNK = 400 * 1024 // 400KB chunks, three of them per happy-path file
const PROJECT_DIR = path.join(DATA_DIR, "proj")
const OTHER_DIR = path.join(DATA_DIR, "proj-b")
let projectId
let otherProjectId

/** file:created / file:modified envelopes captured off the internal bus. */
let frames = []
let unsubscribe = null

beforeAll(async () => {
  unsubscribe = eventBus.subscribe((env) => {
    if (env.type === EventTypes.FILE_CREATED || env.type === EventTypes.FILE_MODIFIED) {
      frames.push(env)
    }
  })
  mkdirSync(path.join(PROJECT_DIR, "raw", "sources"), { recursive: true })
  const res = await request(app)
    .post("/api/v2/projects")
    .send({ name: "Chunked Upload Project", path: PROJECT_DIR })
  expect(res.status).toBe(201)
  projectId = res.body.project.id
  const other = await request(app)
    .post("/api/v2/projects")
    .send({ name: "Chunked Other Project", path: OTHER_DIR })
  expect(other.status).toBe(201)
  otherProjectId = other.body.project.id
})

afterAll(() => {
  unsubscribe?.()
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  frames = []
})

const files = (suffix = "") => `/api/v2/projects/${projectId}/files${suffix}`

/** Init a session and return its uploadId (expects 201). */
async function initUpload(fileName, fileSize, destPath) {
  const res = await request(app)
    .post(files("/upload/init"))
    .send({ fileName, fileSize, destPath })
  expect(res.status).toBe(201)
  return res.body.uploadId
}

/** PUT one octet-stream chunk; returns the raw response. */
function putChunk(uploadId, offset, buffer, pid = projectId) {
  return request(app)
    .put(`/api/v2/projects/${pid}/files/upload/${uploadId}/chunk`)
    .query({ offset })
    .set("Content-Type", "application/octet-stream")
    .send(buffer)
}

// Tests run serially in declaration order; the happy-path group shares one
// session across its cases (api-v2.test.js uses the same pattern).
describe("happy path", () => {
  const total = CHUNK * 3
  const content = crypto.randomBytes(total)
  const dest = "raw/sources/big.bin"
  let uploadId

  it("init returns 201 {uploadId}", async () => {
    uploadId = await initUpload("big.bin", total, dest)
    expect(uploadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("sequential chunks report cumulative received", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await putChunk(uploadId, i * CHUNK, content.subarray(i * CHUNK, (i + 1) * CHUNK))
      expect(res.status).toBe(200)
      expect(res.body.received).toBe((i + 1) * CHUNK)
    }
  })

  it("complete writes the EXACT bytes and emits file:created", async () => {
    const res = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ path: dest, size: total })

    // Byte-level integrity: hash of the landed file equals hash of the source.
    const written = readFileSync(path.join(PROJECT_DIR, dest))
    expect(crypto.createHash("sha256").update(written).digest("hex"))
      .toBe(crypto.createHash("sha256").update(content).digest("hex"))

    // file:created rides the emit() bridge: envelope projectId null,
    // attribution in payload.projectId, project-relative path.
    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe(EventTypes.FILE_CREATED)
    expect(frames[0].projectId).toBeNull()
    expect(frames[0].payload).toEqual({ projectId, path: dest, size: total })
  })

  it("the session is gone after complete (second complete → NOT_FOUND)", async () => {
    const res = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("NOT_FOUND")
  })
})

describe("resume channel + offset rules", () => {
  it("wrong offset → 400 with details.received; retry at the reported offset succeeds", async () => {
    const content = crypto.randomBytes(2 * CHUNK)
    const uploadId = await initUpload("resume.bin", content.length, "raw/sources/resume.bin")

    const first = await putChunk(uploadId, 0, content.subarray(0, CHUNK))
    expect(first.status).toBe(200)

    const bad = await putChunk(uploadId, CHUNK + 17, content.subarray(CHUNK))
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("VALIDATION_ERROR")
    // RESUME CHANNEL: the server reports its byte count for the client to
    // resume from.
    expect(bad.body.error.details).toEqual({ received: CHUNK })

    const good = await putChunk(uploadId, CHUNK, content.subarray(CHUNK))
    expect(good.status).toBe(200)
    expect(good.body.received).toBe(content.length)

    const done = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(done.status).toBe(200)
    expect(readFileSync(path.join(PROJECT_DIR, "raw/sources/resume.bin")).equals(content)).toBe(true)
  })

  it("offset replay (offset < received) → 400 with details.received", async () => {
    const uploadId = await initUpload("replay.bin", 2 * CHUNK, "raw/sources/replay.bin")
    const first = await putChunk(uploadId, 0, Buffer.alloc(CHUNK, 1))
    expect(first.status).toBe(200)

    const replay = await putChunk(uploadId, 0, Buffer.alloc(CHUNK, 1))
    expect(replay.status).toBe(400)
    expect(replay.body.error.code).toBe("VALIDATION_ERROR")
    expect(replay.body.error.details).toEqual({ received: CHUNK })
  })

  it("a 0-byte chunk at the right offset is a no-op success", async () => {
    const uploadId = await initUpload("empty-chunk.bin", 100, "raw/sources/empty-chunk.bin")
    const res = await putChunk(uploadId, 0, Buffer.alloc(0))
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(0)
  })
})

describe("chunk overflow", () => {
  it("overflowing chunk → 400 and the session stays usable", async () => {
    const size = 1000
    const uploadId = await initUpload("overflow.bin", size, "raw/sources/overflow.bin")
    const first = await putChunk(uploadId, 0, Buffer.alloc(400, 1))
    expect(first.status).toBe(200)

    // 400 + 800 > 1000 declared bytes → rejected before anything is appended.
    const over = await putChunk(uploadId, 400, Buffer.alloc(800, 2))
    expect(over.status).toBe(400)
    expect(over.body.error.code).toBe("VALIDATION_ERROR")

    // Session untouched: send the corrected tail, complete, and prove no
    // bytes from the rejected chunk leaked into staging.
    const tail = await putChunk(uploadId, 400, Buffer.alloc(600, 3))
    expect(tail.status).toBe(200)
    expect(tail.body.received).toBe(size)

    const done = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(done.status).toBe(200)
    const written = readFileSync(path.join(PROJECT_DIR, "raw/sources/overflow.bin"))
    expect(written.length).toBe(size)
    expect(written.subarray(0, 400).every((b) => b === 1)).toBe(true)
    expect(written.subarray(400).every((b) => b === 3)).toBe(true)
  })
})

describe("complete guards", () => {
  it("complete before all bytes received → 400", async () => {
    const uploadId = await initUpload("early.bin", 2000, "raw/sources/early.bin")
    const first = await putChunk(uploadId, 0, Buffer.alloc(1000, 7))
    expect(first.status).toBe(200)

    const res = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })

  it("unknown uploadId → NOT_FOUND on chunk and complete", async () => {
    const bogus = "00000000-0000-0000-0000-000000000000"
    const chunk = await putChunk(bogus, 0, Buffer.from("x"))
    expect(chunk.status).toBe(404)
    expect(chunk.body.error.code).toBe("NOT_FOUND")

    const complete = await request(app).post(files(`/upload/${bogus}/complete`))
    expect(complete.status).toBe(404)
    expect(complete.body.error.code).toBe("NOT_FOUND")
  })

  it("destPath traversal → FORBIDDEN at complete, nothing written", async () => {
    // safeJoin runs at complete time (plans/chunked-upload.md), so init and
    // the chunk succeed; only the finalize is rejected.
    const uploadId = await initUpload("evil.bin", 100, "../evil.bin")
    const first = await putChunk(uploadId, 0, Buffer.alloc(100, 9))
    expect(first.status).toBe(200)

    const res = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("FORBIDDEN")
    expect(existsSync(path.resolve(PROJECT_DIR, "..", "evil.bin"))).toBe(false)
    expect(frames).toHaveLength(0)
  })
})

describe("caps", () => {
  it("init with fileSize above the cap → 413 FILE_TOO_LARGE (LLM_WIKI_MAX_UPLOAD_MB=5)", async () => {
    const res = await request(app)
      .post(files("/upload/init"))
      .send({ fileName: "huge.bin", fileSize: 6 * 1024 * 1024, destPath: "raw/sources/huge.bin" })
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe("FILE_TOO_LARGE")
  })

  it("multipart upload above the env cap → 413 FILE_TOO_LARGE (MulterError mapping)", async () => {
    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/ingest/upload`)
      .attach("file", Buffer.alloc(6 * 1024 * 1024), "big.bin")
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe("FILE_TOO_LARGE")
  })
})

describe("overwrite semantics", () => {
  it("overwriting an existing file emits file:modified and replaces content", async () => {
    const dest = "raw/sources/versioned.bin"
    const absDest = path.join(PROJECT_DIR, dest)
    writeFileSync(absDest, Buffer.from("old content"))

    const content = crypto.randomBytes(512)
    const uploadId = await initUpload("versioned.bin", content.length, dest)
    const first = await putChunk(uploadId, 0, content)
    expect(first.status).toBe(200)

    const done = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(done.status).toBe(200)
    expect(done.body).toEqual({ path: dest, size: content.length })

    expect(frames).toHaveLength(1)
    expect(frames[0].type).toBe(EventTypes.FILE_MODIFIED)
    expect(frames[0].projectId).toBeNull()
    expect(frames[0].payload).toEqual({ projectId, path: dest, size: content.length })
    expect(readFileSync(absDest).equals(content)).toBe(true)
  })
})

describe("cross-project isolation", () => {
  it("a session is invisible to another project's routes (chunk and complete)", async () => {
    const uploadId = await initUpload("isolated.bin", CHUNK, "raw/sources/isolated.bin")

    const chunk = await putChunk(uploadId, 0, Buffer.alloc(CHUNK, 5), otherProjectId)
    expect(chunk.status).toBe(404)
    expect(chunk.body.error.code).toBe("NOT_FOUND")

    const complete = await request(app)
      .post(`/api/v2/projects/${otherProjectId}/files/upload/${uploadId}/complete`)
    expect(complete.status).toBe(404)
    expect(complete.body.error.code).toBe("NOT_FOUND")
  })
})

describe("TTL sweep", () => {
  it("sweepExpiredChunkedUploads drops sessions idle past the TTL", async () => {
    const chunked = await import("../src/uploads/chunked.js")
    const uploadId = await initUpload("stale.bin", 100, "raw/sources/stale.bin")
    const first = await putChunk(uploadId, 0, Buffer.alloc(100, 4))
    expect(first.status).toBe(200)

    const session = chunked.getChunkedUpload(uploadId)
    expect(session).toBeTruthy()
    // Age the session past the TTL and sweep.
    session.lastActivityAt = Date.now() - chunked.CHUNKED_UPLOAD_TTL_MS - 1000
    chunked.sweepExpiredChunkedUploads()

    expect(chunked.getChunkedUpload(uploadId)).toBeUndefined()
    const res = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(res.status).toBe(404)
  })
})
