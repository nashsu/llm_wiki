// Stage 2 of plans/sse-taxonomy.md: file:* emission on the v2 routes.
// Stage 4 extends the maintenance surface: rebuild-index also emits ONE
// aggregate graph:updated ({ projectId, nodesChanged, edgesChanged }).
//
// All frames ride the legacy emit() bridge, so the bus envelope keeps
// projectId: null and attribution rides in payload.projectId (same shape as
// ingest:*). Covered sites:
//   - api/files.js POST /files/upload — pre-write stat decides created vs
//     modified; size reflects the written bytes (utf-8 AND base64)
//   - api/ingest.js POST /upload — the raw/sources file is always
//     file:created (timestamp+random name), alongside ingest:queued
//   - api/maintenance.js POST /rebuild-index — ONE file:modified for
//     wiki/index.md after the tmp-rename
//   - api/maintenance.js POST /file-history/restore — file:modified for the
//     restored path
// A rejected write (path traversal) emits nothing. The orchestrator cancel
// cleanup (file:deleted) is covered in orchestrator.test.js.
//
// emit() republishes onto the bus synchronously, so frames are captured by
// the time each supertest request resolves (same bus-frame pattern as
// api-settings-events.test.js). The orchestrator module is import-safe (its
// boot block only starts under `node index-v2.js`), so the ingest upload
// enqueues without ever running a pipeline.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-fileevents-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")
const { eventBus, EventTypes } = await import("../src/events/bus.js")

const FILE_EVENT_TYPES = new Set([
  EventTypes.FILE_CREATED,
  EventTypes.FILE_MODIFIED,
  EventTypes.FILE_DELETED,
])

const PROJECT_DIR = path.join(DATA_DIR, "proj")
let projectId

/** file:* envelopes captured off the internal bus. */
let frames = []
/** ingest:queued envelopes (parity check: the pre-existing emit survives). */
let queuedFrames = []
/** graph:updated envelopes (stage 4). */
let graphFrames = []
let unsubscribe = null

beforeAll(async () => {
  unsubscribe = eventBus.subscribe((env) => {
    if (FILE_EVENT_TYPES.has(env.type)) frames.push(env)
    else if (env.type === EventTypes.INGEST_QUEUED) queuedFrames.push(env)
    else if (env.type === EventTypes.GRAPH_UPDATED) graphFrames.push(env)
  })
  const res = await request(app)
    .post("/api/v2/projects")
    .send({ name: "File Events Project", path: PROJECT_DIR })
  expect(res.status).toBe(201)
  projectId = res.body.project.id
})

afterAll(() => {
  unsubscribe?.()
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  frames = []
  queuedFrames = []
  graphFrames = []
})

/** All file:* frames ride the emit() bridge: envelope projectId stays null. */
function expectFileFrame(index, type, payload) {
  expect(frames[index]).toBeTruthy()
  expect(frames[index].type).toBe(type)
  expect(frames[index].projectId).toBeNull()
  expect(frames[index].payload).toEqual(payload)
}

const uploadUrl = () => `/api/v2/projects/${projectId}/files/upload`

// Tests run serially in declaration order; the overwrite test builds on the
// file created by the first test (api-v2.test.js uses the same pattern).
describe("api/files.js POST /files/upload", () => {
  it("emits file:created for a new file (utf-8 size in bytes)", async () => {
    const content = "# New Idea\nFirst version — ünïcode counts bytes.\n"
    const res = await request(app)
      .post(uploadUrl())
      .send({ path: "wiki/concepts/new-idea.md", content })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId,
      path: "wiki/concepts/new-idea.md",
      size: Buffer.byteLength(content, "utf-8"),
    })
  })

  it("emits file:modified when the upload overwrites an existing file", async () => {
    const content = "# New Idea\nSecond version.\n"
    const res = await request(app)
      .post(uploadUrl())
      .send({ path: "wiki/concepts/new-idea.md", content })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_MODIFIED, {
      projectId,
      path: "wiki/concepts/new-idea.md",
      size: Buffer.byteLength(content, "utf-8"),
    })
  })

  it("reports the DECODED size for base64 uploads", async () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])
    const res = await request(app)
      .post(uploadUrl())
      .send({ path: "raw/assets/blob.bin", content: raw.toString("base64"), encoding: "base64" })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId,
      path: "raw/assets/blob.bin",
      size: raw.length,
    })
  })

  it("emits nothing when the write is rejected (path traversal)", async () => {
    const res = await request(app)
      .post(uploadUrl())
      .send({ path: "../../evil.md", content: "x" })
    expect(res.status).toBe(403)
    expect(frames).toHaveLength(0)
  })
})

describe("api/ingest.js POST /upload", () => {
  it("emits file:created for the raw/sources file alongside ingest:queued", async () => {
    const body = Buffer.from("sample paper text for ingest")
    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/ingest/upload`)
      .attach("file", body, "paper.txt")
    expect(res.status).toBe(201)

    // Timestamp + random suffix ⇒ always a creation, project-relative path
    // under raw/sources/, size = the uploaded bytes.
    expect(frames).toHaveLength(1)
    const relPath = `raw/sources/${path.basename(res.body.filePath)}`
    expect(relPath).toMatch(/^raw\/sources\/\d+_[0-9a-f]{8}_paper\.txt$/)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId,
      path: relPath,
      size: body.length,
    })

    // The pre-existing ingest:queued emit is untouched (parity).
    expect(queuedFrames).toHaveLength(1)
    expect(queuedFrames[0].payload).toMatchObject({ projectId, filePath: res.body.filePath })
  })
})

describe("api/maintenance.js", () => {
  it("POST /rebuild-index emits ONE file:modified for wiki/index.md + ONE graph:updated", async () => {
    // Seed a page carrying wikilinks so the rebuild's best-effort edge count
    // (wikilinks across the processed page contents) is non-zero.
    const linked =
      "---\ntype: concept\ntitle: Linked\n---\n# Linked\nSee [[new-idea]] and [[new-idea|the idea]].\n"
    await request(app)
      .post(uploadUrl())
      .send({ path: "wiki/concepts/linked.md", content: linked })
      .expect(200)
    frames = []
    graphFrames = []

    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/maintenance/rebuild-index`)
    expect(res.status).toBe(200)
    expect(frames).toHaveLength(1)
    const frame = frames[0]
    expect(frame.type).toBe(EventTypes.FILE_MODIFIED)
    expect(frame.projectId).toBeNull()
    expect(frame.payload.projectId).toBe(projectId)
    expect(frame.payload.path).toBe("wiki/index.md")
    expect(frame.payload.size).toBeGreaterThan(0)

    // Stage 4: ONE aggregate graph:updated — nodesChanged = the rebuild's
    // processed page total (new-idea + linked); edgesChanged = the wikilinks
    // counted across those pages while reading them (linked.md carries two).
    expect(graphFrames).toHaveLength(1)
    const graph = graphFrames[0]
    expect(graph.type).toBe(EventTypes.GRAPH_UPDATED)
    expect(graph.projectId).toBeNull()
    expect(graph.payload.projectId).toBe(projectId)
    expect(graph.payload.nodesChanged).toBe(res.body.pages)
    expect(graph.payload.nodesChanged).toBeGreaterThanOrEqual(2)
    expect(graph.payload.edgesChanged).toBe(2)
  })

  it("POST /file-history/restore emits file:modified for the restored path", async () => {
    const rel = "wiki/concepts/versioned.md"
    const v1 = "# Versioned\nFirst version.\n"
    const v2 = "# Versioned\nSecond version.\n"
    // write_file records file-history versions, so two uploads seed the
    // history store with both versions (newest first on read).
    await request(app).post(uploadUrl()).send({ path: rel, content: v1 }).expect(200)
    await request(app).post(uploadUrl()).send({ path: rel, content: v2 }).expect(200)
    frames = []

    const hist = await request(app)
      .get(`/api/v2/projects/${projectId}/maintenance/file-history`)
      .query({ path: rel })
    expect(hist.status).toBe(200)
    const entry = hist.body.history.find((e) => e.content === v1)
    expect(entry).toBeTruthy()

    const res = await request(app)
      .post(`/api/v2/projects/${projectId}/maintenance/file-history/restore`)
      .send({ path: rel, entryId: entry.id })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.content).toBe(v1)
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_MODIFIED, {
      projectId,
      path: rel,
      size: Buffer.byteLength(v1, "utf-8"),
    })
  })
})
