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
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  appendFileSync,
} from "node:fs"
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
const chunked = await import("../src/uploads/chunked.js")

const CHUNK = 400 * 1024 // 400KB chunks, three of them per happy-path file
const PROJECT_DIR = path.join(DATA_DIR, "proj")
const OTHER_DIR = path.join(DATA_DIR, "proj-b")
const STAGING_DIR = path.join(DATA_DIR, "upload-staging")
let projectId
let otherProjectId

/**
 * destroyChunkedUpload unlinks staging files fire-and-forget, so poll briefly
 * until the staging directory has actually drained (or never materialized).
 */
async function expectStagingDirEmpty() {
  const deadline = Date.now() + 2000
  for (;;) {
    const entries = existsSync(STAGING_DIR) ? readdirSync(STAGING_DIR) : []
    if (entries.length === 0) return
    if (Date.now() > deadline) {
      throw new Error(`upload-staging did not drain: ${entries.join(", ")}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

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

    // Complete unlinks the staging .part (this is the only live session so
    // far, so the whole staging directory must be empty).
    await expectStagingDirEmpty()
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

    // Cleanup: drop the leftover session + staging (test hygiene).
    chunked.destroyChunkedUpload(chunked.getChunkedUpload(uploadId))
  })

  it("a 0-byte chunk at the right offset is a no-op success", async () => {
    const uploadId = await initUpload("empty-chunk.bin", 100, "raw/sources/empty-chunk.bin")
    const res = await putChunk(uploadId, 0, Buffer.alloc(0))
    expect(res.status).toBe(200)
    expect(res.body.received).toBe(0)
    chunked.destroyChunkedUpload(chunked.getChunkedUpload(uploadId))
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

    // Cleanup: drop the leftover session + staging (test hygiene).
    chunked.destroyChunkedUpload(chunked.getChunkedUpload(uploadId))
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
    // A terminal finalize failure destroys the session (destPath is fixed at
    // init, so it can never complete on retry).
    expect(chunked.getChunkedUpload(uploadId)).toBeUndefined()
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

    // Cleanup: drop the leftover session + staging (test hygiene).
    chunked.destroyChunkedUpload(chunked.getChunkedUpload(uploadId))
  })
})

describe("TTL sweep", () => {
  it("sweepExpiredChunkedUploads drops sessions idle past the TTL", async () => {
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

    // The sweep unlinks the swept session's staging file; every earlier test
    // cleaned up its sessions, so the whole directory must drain.
    await expectStagingDirEmpty()
  })
})

describe("concurrent same-offset chunk PUTs (serialization)", () => {
  it("exactly one append wins per offset; the loser gets the resume channel (3 rounds)", async () => {
    for (let round = 0; round < 3; round++) {
      const content = crypto.randomBytes(2 * CHUNK)
      const dest = `raw/sources/race-${round}.bin`
      const uploadId = await initUpload(`race-${round}.bin`, content.length, dest)

      // Two concurrent PUTs at the SAME offset: before the per-session append
      // chain both passed the offset check and double-appended. Now the
      // serialized second append observes the winner's byte count.
      const [a, b] = await Promise.all([
        putChunk(uploadId, 0, content.subarray(0, CHUNK)),
        putChunk(uploadId, 0, content.subarray(0, CHUNK)),
      ])
      expect([a.status, b.status].sort()).toEqual([200, 400])
      const winner = a.status === 200 ? a : b
      const loser = a.status === 400 ? a : b
      expect(winner.body.received).toBe(CHUNK)
      expect(loser.body.error.code).toBe("VALIDATION_ERROR")
      expect(loser.body.error.details).toEqual({ received: CHUNK })

      const tail = await putChunk(uploadId, CHUNK, content.subarray(CHUNK))
      expect(tail.status).toBe(200)
      expect(tail.body.received).toBe(content.length)

      const done = await request(app).post(files(`/upload/${uploadId}/complete`))
      expect(done.status).toBe(200)
      const written = readFileSync(path.join(PROJECT_DIR, dest))
      expect(crypto.createHash("sha256").update(written).digest("hex"))
        .toBe(crypto.createHash("sha256").update(content).digest("hex"))
    }
  })
})

describe("resume channel beats the body-overflow bound", () => {
  it("resending the FINAL chunk (all bytes on disk) → 400 WITH details.received, then complete succeeds", async () => {
    const content = crypto.randomBytes(2 * CHUNK)
    const uploadId = await initUpload("final-resend.bin", content.length, "raw/sources/final-resend.bin")
    for (let i = 0; i < 2; i++) {
      const res = await putChunk(uploadId, i * CHUNK, content.subarray(i * CHUNK, (i + 1) * CHUNK))
      expect(res.status).toBe(200)
    }

    // The final chunk's 200 was "lost" and the client resends it: offset is
    // stale and the remaining-bytes bound is 0 — the offset check must win
    // so the 400 carries details.received === fileSize and resume survives.
    const resend = await putChunk(uploadId, CHUNK, content.subarray(CHUNK))
    expect(resend.status).toBe(400)
    expect(resend.body.error.code).toBe("VALIDATION_ERROR")
    expect(resend.body.error.details).toEqual({ received: content.length })

    const done = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(done.status).toBe(200)
    expect(readFileSync(path.join(PROJECT_DIR, "raw/sources/final-resend.bin")).equals(content)).toBe(true)
  })

  it("wrong offset + oversize body → resume-channel 400 with details.received, session stays usable", async () => {
    const size = 2000
    const uploadId = await initUpload("wrong-and-over.bin", size, "raw/sources/wrong-and-over.bin")
    const first = await putChunk(uploadId, 0, Buffer.alloc(1000, 1))
    expect(first.status).toBe(200)

    // Offset 0 ≠ received 1000 AND the 1500-byte body overflows the 1000
    // remaining bytes: the offset check answers BEFORE the overflow bound.
    const bad = await putChunk(uploadId, 0, Buffer.alloc(1500, 2))
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("VALIDATION_ERROR")
    expect(bad.body.error.details).toEqual({ received: 1000 })

    const tail = await putChunk(uploadId, 1000, Buffer.alloc(1000, 3))
    expect(tail.status).toBe(200)
    expect(tail.body.received).toBe(size)

    const done = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(done.status).toBe(200)
    const written = readFileSync(path.join(PROJECT_DIR, "raw/sources/wrong-and-over.bin"))
    expect(written.length).toBe(size)
    expect(written.subarray(0, 1000).every((b) => b === 1)).toBe(true)
    expect(written.subarray(1000).every((b) => b === 3)).toBe(true)
  })
})

describe("complete verifies the real staging size", () => {
  it("staging larger than fileSize → INTERNAL_ERROR, session + staging destroyed", async () => {
    const uploadId = await initUpload("tamper.bin", 100, "raw/sources/tamper.bin")
    const first = await putChunk(uploadId, 0, Buffer.alloc(100, 6))
    expect(first.status).toBe(200)

    // Corrupt the staging state out-of-band: received still claims 100 bytes.
    const session = chunked.getChunkedUpload(uploadId)
    appendFileSync(session.stagingPath, Buffer.alloc(16, 0xff))

    const res = await request(app).post(files(`/upload/${uploadId}/complete`))
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe("INTERNAL_ERROR")

    // Corrupt state is unrecoverable: session dropped, staging unlinked,
    // nothing written to the project.
    expect(chunked.getChunkedUpload(uploadId)).toBeUndefined()
    expect(existsSync(path.join(PROJECT_DIR, "raw/sources/tamper.bin"))).toBe(false)
    await expectStagingDirEmpty()
  })
})
