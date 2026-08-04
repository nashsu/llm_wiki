// Stage 3 of plans/sse-taxonomy.md: file:* emission from the legacy invoke
// writers (commands/fs.js) + the chat/writes post-write image injection.
//
// All frames ride the legacy emit() bridge, so the bus envelope keeps
// projectId: null and attribution rides in payload.projectId — resolved by
// findProjectByPathPrefix (longest-prefix match against projects.path; null
// when unresolved). The payload path is the path as given (exception:
// createMissingWikiPage reports its returned project-relative path).
// Covered sites:
//   - writeFile / writeFileBase64 / writeFileAtomic — created vs modified
//     via pre-write existence; the atomic writer emits ONCE for the final
//     path after the rename (the .tmp never emits)
//   - applyTextSelectionEdit — always modified (target pre-existence is
//     enforced by the command itself)
//   - createMissingWikiPage — created with the project-relative path
//   - deleteFile — deleted ONLY on an actual removal (missing ⇒ silent no-op)
//   - copyFile — created for the destination; copyDirectory — created per
//     created path (the same list the command returns)
//   - api/files.js upload keeps emitting its OWN single frame: the route
//     passes suppressFileEvents so the writer-level emit doesn't duplicate it
//   - the legacy /api/invoke bridge emits through the same writers (S5 shape)
//   - chat/writes image injection — file:modified for wiki/sources/<slug>.md
//     after injectImagesIntoSourceSummary rewrites it post-write
//
// The resolver is unit-tested against seeded projects rows. The writers are
// called directly with temp dirs (same bus-frame pattern as
// file-events.test.js). For the chat-writes flow streamChat and
// extractSourceImagesOnceByKey are mocked while the REAL
// injectImagesIntoSourceSummary performs the rewrite.

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { streamChatMock, extractImagesMock } = vi.hoisted(() => ({
  streamChatMock: vi.fn(),
  extractImagesMock: vi.fn(),
}))

vi.mock("../src/ingest/llm.js", () => ({
  streamChat: (...args) => streamChatMock(...args),
  USAGE_LIMIT_BACKOFF_MS: 15 * 60 * 1000,
  isUsageLimitError: vi.fn(() => false),
  IngestLlmError: class IngestLlmError extends Error {
    constructor(message, { usageLimit = false, timeout = false } = {}) {
      super(message)
      this.name = "IngestLlmError"
      this.usageLimit = usageLimit
      this.timeout = timeout
    }
  },
}))

vi.mock("../src/ingest/orchestrator.js", () => ({
  MAX_ATTEMPTS: 3,
  startIngestOrchestrator: vi.fn(),
  stopIngestOrchestrator: vi.fn(),
  kickIngestOrchestrator: vi.fn(),
  cancelIngestTask: vi.fn(async () => true),
  activeIngestTaskCount: () => 0,
  __resetOrchestratorForTests: vi.fn(),
}))

// Partial mock: the extraction step is scripted (a .md source yields no real
// images), while the REAL injectImagesIntoSourceSummary performs the rewrite.
vi.mock("../src/ingest/images.js", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    extractSourceImagesOnceByKey: (...args) => extractImagesMock(...args),
  }
})

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-fswriters-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")
const { eventBus, EventTypes } = await import("../src/events/bus.js")
const { fsCommands } = await import("../src/commands/fs.js")
const { createProject, deleteProject, findProjectByPathPrefix } = await import("../src/store/projects.js")
const { writeStoreKey } = await import("../src/store.js")

const FILE_EVENT_TYPES = new Set([
  EventTypes.FILE_CREATED,
  EventTypes.FILE_MODIFIED,
  EventTypes.FILE_DELETED,
])

/** file:* envelopes captured off the internal bus. */
let frames = []
let unsubscribe = null

const PROJ_DIR = path.join(DATA_DIR, "proj")
let proj

beforeAll(() => {
  unsubscribe = eventBus.subscribe((env) => {
    if (FILE_EVENT_TYPES.has(env.type)) frames.push(env)
  })
  mkdirSync(path.join(PROJ_DIR, "wiki"), { recursive: true })
  proj = createProject({ name: "Writers", path: PROJ_DIR })
})

afterAll(() => {
  unsubscribe?.()
  deleteProject(proj.id)
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  frames = []
  streamChatMock.mockReset()
  extractImagesMock.mockReset()
})

/** All file:* frames ride the emit() bridge: envelope projectId stays null. */
function expectFileFrame(index, type, payload) {
  expect(frames[index]).toBeTruthy()
  expect(frames[index].type).toBe(type)
  expect(frames[index].projectId).toBeNull()
  expect(frames[index].payload).toEqual(payload)
}

describe("findProjectByPathPrefix (resolver)", () => {
  const ROOT = path.join(DATA_DIR, "resolver")
  let projAlpha, projNested, projSlash

  beforeAll(() => {
    projAlpha = createProject({ name: "alpha", path: path.join(ROOT, "alpha") })
    projNested = createProject({ name: "nested", path: path.join(ROOT, "alpha", "nested") })
    // Stored WITH a trailing separator — must behave identically to the
    // un-slashed form.
    projSlash = createProject({ name: "slash", path: `${path.join(ROOT, "beta")}/` })
  })

  afterAll(() => {
    deleteProject(projAlpha.id)
    deleteProject(projNested.id)
    deleteProject(projSlash.id)
  })

  it("matches the project root exactly", () => {
    expect(findProjectByPathPrefix(path.join(ROOT, "alpha"))?.id).toBe(projAlpha.id)
  })

  it("matches files under the project root", () => {
    expect(findProjectByPathPrefix(path.join(ROOT, "alpha", "wiki", "page.md"))?.id).toBe(projAlpha.id)
  })

  it("prefers the LONGEST matching prefix (nested project wins)", () => {
    expect(findProjectByPathPrefix(path.join(ROOT, "alpha", "nested", "deep", "file.md"))?.id)
      .toBe(projNested.id)
  })

  it("matches only at path boundaries (/a/b does not claim /a/bc)", () => {
    expect(findProjectByPathPrefix(path.join(ROOT, "alphas", "x.md"))).toBeNull()
  })

  it("normalizes trailing separators on stored rows and on the query", () => {
    expect(findProjectByPathPrefix(path.join(ROOT, "beta", "sub", "f.md"))?.id).toBe(projSlash.id)
    expect(findProjectByPathPrefix(path.join(ROOT, "beta"))?.id).toBe(projSlash.id)
    expect(findProjectByPathPrefix(`${path.join(ROOT, "alpha")}/`)?.id).toBe(projAlpha.id)
  })

  it("is case-sensitive", () => {
    expect(findProjectByPathPrefix(path.join(ROOT, "ALPHA", "x.md"))).toBeNull()
  })

  it("normalizes '..' segments before prefix matching", () => {
    // Raw strings on purpose (path.join would normalize them away): the
    // resolver must agree with where the write actually lands.
    // /…/alpha/../beta/sub/f.md resolves INTO beta — the raw prefix match
    // would have attributed it to alpha (PR #29 review round 2).
    const intoBeta = `${path.join(ROOT, "alpha")}/../beta/sub/f.md`
    expect(findProjectByPathPrefix(intoBeta)?.id).toBe(projSlash.id)
    // Traversal that stays inside alpha still matches alpha.
    const insideAlpha = `${path.join(ROOT, "alpha", "wiki")}/../page.md`
    expect(findProjectByPathPrefix(insideAlpha)?.id).toBe(projAlpha.id)
    // Longest-prefix still wins after normalization.
    const intoNested = `${path.join(ROOT, "alpha", "nested")}/../../alpha/nested/deep/f.md`
    expect(findProjectByPathPrefix(intoNested)?.id).toBe(projNested.id)
    // Traversal escaping every registered root resolves to nothing.
    expect(findProjectByPathPrefix(`${ROOT}/alpha/../../outside/x.md`)).toBeNull()
  })

  it("returns null when nothing matches or the input is unusable", () => {
    expect(findProjectByPathPrefix("/definitely/not/registered")).toBeNull()
    expect(findProjectByPathPrefix("")).toBeNull()
    expect(findProjectByPathPrefix(null)).toBeNull()
    expect(findProjectByPathPrefix(undefined)).toBeNull()
  })
})

describe("commands/fs.js writers emit file:* frames", () => {
  it("write_file emits file:created for a new file (path as given + size)", async () => {
    const p = path.join(PROJ_DIR, "wiki", "created.md")
    const contents = "# Created\nFirst version.\n"
    await fsCommands.write_file({ path: p, contents })
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId: proj.id,
      path: p,
      size: Buffer.byteLength(contents, "utf-8"),
    })
  })

  it("write_file emits file:modified when the file pre-exists", async () => {
    const p = path.join(PROJ_DIR, "wiki", "created.md") // written by the previous test
    const contents = "# Created\nSecond version.\n"
    await fsCommands.write_file({ path: p, contents })
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_MODIFIED, {
      projectId: proj.id,
      path: p,
      size: Buffer.byteLength(contents, "utf-8"),
    })
  })

  it("write_file_base64 reports the DECODED byte size", async () => {
    const p = path.join(PROJ_DIR, "wiki", "blob.bin")
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])
    await fsCommands.write_file_base64({ path: p, base64: raw.toString("base64") })
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId: proj.id,
      path: p,
      size: raw.length,
    })
  })

  it("write_file_atomic emits ONCE for the final path after the rename", async () => {
    const p = path.join(PROJ_DIR, "wiki", "atomic.md")
    const contents = "# Atomic\n"
    await fsCommands.write_file_atomic({ path: p, contents })
    // Exactly one frame: the .tmp never emits.
    expect(frames).toHaveLength(1)
    expect(frames[0].payload.path).toBe(p)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId: proj.id,
      path: p,
      size: Buffer.byteLength(contents, "utf-8"),
    })

    frames = []
    const updated = "# Atomic v2\n"
    await fsCommands.write_file_atomic({ path: p, contents: updated })
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_MODIFIED, {
      projectId: proj.id,
      path: p,
      size: Buffer.byteLength(updated, "utf-8"),
    })
  })

  it("apply_text_selection_edit always emits file:modified", async () => {
    const filePath = path.join(PROJ_DIR, "wiki", "selection.md")
    writeFileSync(filePath, "alpha beta gamma")
    const updated = await fsCommands.apply_text_selection_edit({
      projectPath: PROJ_DIR,
      filePath,
      prefix: "alpha ",
      selectedText: "beta",
      suffix: " gamma",
      replacement: "BETA-EDITED",
    })
    expect(updated).toBe("alpha BETA-EDITED gamma")
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_MODIFIED, {
      projectId: proj.id,
      path: filePath,
      size: Buffer.byteLength(updated, "utf-8"),
    })
  })

  it("create_missing_wiki_page emits created with the project-relative path", async () => {
    const rel = await fsCommands.create_missing_wiki_page({
      projectPath: PROJ_DIR,
      title: "Fresh Concept",
      content: "",
    })
    // safeMissingPageStem preserves spaces (desktop parity).
    expect(rel).toBe("wiki/concepts/Fresh Concept.md")
    const abs = path.join(PROJ_DIR, rel)
    expect(existsSync(abs)).toBe(true)
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId: proj.id,
      path: rel,
      size: statSync(abs).size,
    })
  })

  it("delete_file emits deleted ONLY when a removal actually happened", async () => {
    const p = path.join(PROJ_DIR, "wiki", "doomed.md")
    writeFileSync(p, "short-lived")
    await fsCommands.delete_file({ path: p })
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_DELETED, { projectId: proj.id, path: p })

    // The file is gone now: the command silently no-ops ⇒ no frame.
    frames = []
    await fsCommands.delete_file({ path: p })
    expect(frames).toHaveLength(0)

    // Directories are removable too (recursive) and emit for the dir path.
    const dir = path.join(PROJ_DIR, "wiki", "doomed-dir")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "inner.md"), "inner")
    frames = []
    await fsCommands.delete_file({ path: dir })
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_DELETED, { projectId: proj.id, path: dir })
  })

  it("copy_file emits created for the destination", async () => {
    const source = path.join(PROJ_DIR, "wiki", "created.md")
    const destination = path.join(PROJ_DIR, "wiki", "copies", "copy-of-created.md")
    await fsCommands.copy_file({ source, destination })
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, { projectId: proj.id, path: destination })
  })

  it("copy_directory emits created per created path (its returned list)", async () => {
    const source = path.join(PROJ_DIR, "copy-src")
    mkdirSync(path.join(source, "sub"), { recursive: true })
    writeFileSync(path.join(source, "a.txt"), "a")
    writeFileSync(path.join(source, "sub", "b.txt"), "b")
    const destination = path.join(PROJ_DIR, "copied-tree")

    const created = await fsCommands.copy_directory({ source, destination })
    expect(created.length).toBe(4) // dest dir, a.txt, sub dir, sub/b.txt
    expect(frames).toHaveLength(created.length)
    for (const frame of frames) {
      expect(frame.type).toBe(EventTypes.FILE_CREATED)
      expect(frame.projectId).toBeNull()
      expect(frame.payload.projectId).toBe(proj.id)
    }
    expect(frames.map((f) => f.payload.path).sort()).toEqual([...created].sort())
  })

  it("leaves payload.projectId null when no project claims the path", async () => {
    const looseDir = mkdtempSync(path.join(DATA_DIR, "loose-"))
    const p = path.join(looseDir, "orphan.md")
    await fsCommands.write_file({ path: p, contents: "no project here" })
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId: null,
      path: p,
      size: Buffer.byteLength("no project here", "utf-8"),
    })
  })
})

describe("routes that share the writers", () => {
  it("legacy /api/invoke bridge emits through the writers (S5 shape)", async () => {
    const p = path.join(PROJ_DIR, "wiki", "bridge.md")
    const res = await request(app)
      .post("/api/invoke/write_file")
      .send({ path: p, contents: "via the bridge" })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId: proj.id,
      path: p,
      size: Buffer.byteLength("via the bridge", "utf-8"),
    })
  })

  it("POST /files/upload keeps its OWN single frame (writer emit suppressed)", async () => {
    const content = "uploaded content"
    const res = await request(app)
      .post(`/api/v2/projects/${proj.id}/files/upload`)
      .send({ path: "wiki/upload.md", content })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    // Exactly ONE frame: the route's project-relative frame, NOT a second
    // absolute-path frame from the writer.
    expect(frames).toHaveLength(1)
    expectFileFrame(0, EventTypes.FILE_CREATED, {
      projectId: proj.id,
      path: "wiki/upload.md",
      size: Buffer.byteLength(content, "utf-8"),
    })
  })
})

describe("chat/writes image injection", () => {
  const sessionId = "conv_fswriters_inject"

  beforeAll(() => {
    mkdirSync(path.join(PROJ_DIR, "raw", "sources"), { recursive: true })
    writeFileSync(path.join(PROJ_DIR, "raw", "sources", "doc.md"), "# Doc\nHello world.\n")
    writeStoreKey("app-state.json", "llmConfig", {
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
    })
    writeStoreKey("app-state.json", "multimodalConfig", { enabled: true })
  })

  /**
   * Subscribe to the internal bus BEFORE the request so no frame is missed
   * (same pattern as api-chat-writes.test.js).
   */
  function watchEvents(watchedSessionId) {
    const frames_ = []      // agent-event payloads { sessionId, runId, event }
    const fileEvents = []   // { type, projectId, payload } file:* envelopes
    let resolveDone
    const donePromise = new Promise((resolve) => { resolveDone = resolve })
    const unsub = eventBus.subscribe((env) => {
      if (env.type === "agent-event") {
        const p = env.payload ?? {}
        if (p.sessionId !== watchedSessionId) return
        frames_.push(p)
        if (p.event?.type === "done") resolveDone()
      } else if (FILE_EVENT_TYPES.has(env.type)) {
        fileEvents.push({ type: env.type, projectId: env.projectId, payload: env.payload })
      }
    })
    return {
      frames: frames_,
      fileEvents,
      async waitDone(timeoutMs = 5000) {
        await Promise.race([
          donePromise,
          new Promise((_, rej) => setTimeout(
            () => rej(new Error(`timed out waiting for done frame (got ${frames_.length} frames)`)),
            timeoutMs,
          )),
        ])
        unsub()
      },
      unsub,
    }
  }

  it("emits file:modified for wiki/sources/<slug>.md after the rewrite", async () => {
    const sourceContent = [
      "---",
      "type: source",
      "title: Doc",
      "created: 2026-08-04",
      "updated: 2026-08-04",
      "tags: []",
      "related: []",
      "sources: []",
      "---",
      "",
      "# Doc summary",
      "",
    ].join("\n")
    const scriptedOutput = [
      "---FILE: wiki/sources/doc.md---",
      sourceContent,
      "---END FILE---",
    ].join("\n")
    streamChatMock.mockImplementationOnce(async (_c, _m, opts = {}) => {
      opts.onToken?.(scriptedOutput)
      return scriptedOutput
    })
    // Scripted extraction: one saved image (a .md source yields none for
    // real). The real injectImagesIntoSourceSummary performs the rewrite.
    extractImagesMock.mockResolvedValueOnce([
      { relPath: "media/doc/img-1.png", sha256: "deadbeef", page: 1 },
    ])

    const watcher = watchEvents(sessionId)
    try {
      const res = await request(app)
        .post(`/api/v2/projects/${proj.id}/chat/writes`)
        .send({ sessionId, sourcePath: "raw/sources/doc.md" })
      expect(res.status).toBe(200)
      await watcher.waitDone()
    } finally {
      watcher.unsub()
    }

    // The FILE-block emit loop emits created for the summary page; the
    // post-write injection then rewrites it ⇒ a file:modified follows.
    const docFrames = watcher.fileEvents.filter((e) => e.payload.path === "wiki/sources/doc.md")
    expect(docFrames.map((e) => e.type)).toEqual([
      EventTypes.FILE_CREATED,
      EventTypes.FILE_MODIFIED,
    ])
    for (const e of docFrames) {
      expect(e.projectId).toBeNull() // emit() bridge envelope
      expect(e.payload.projectId).toBe(proj.id)
    }

    // The real injection actually rewrote the page.
    const page = readFileSync(path.join(PROJ_DIR, "wiki", "sources", "doc.md"), "utf8")
    expect(page).toContain("# Doc summary")
    expect(page).toContain("## Embedded Images")
    expect(page).toContain("![](../media/doc/img-1.png)")
  })

  it("emits file:created when the injection writes a stub page (page did not exist)", async () => {
    // PR #29 review round 2: created-vs-modified follows pre-write existence.
    // No FILE blocks land the summary page, so the injection's stub branch
    // CREATES wiki/sources/doc2.md ⇒ file:created, not file:modified.
    const stubSessionId = "conv_fswriters_inject_stub"
    writeFileSync(path.join(PROJ_DIR, "raw", "sources", "doc2.md"), "# Doc2\nHello.\n")
    streamChatMock.mockImplementationOnce(async () => "No files generated.")
    extractImagesMock.mockResolvedValueOnce([
      { relPath: "media/doc2/img-1.png", sha256: "deadbeef", page: 1 },
    ])

    const watcher = watchEvents(stubSessionId)
    try {
      const res = await request(app)
        .post(`/api/v2/projects/${proj.id}/chat/writes`)
        .send({ sessionId: stubSessionId, sourcePath: "raw/sources/doc2.md" })
      expect(res.status).toBe(200)
      await watcher.waitDone()
    } finally {
      watcher.unsub()
    }

    const docFrames = watcher.fileEvents.filter((e) => e.payload.path === "wiki/sources/doc2.md")
    expect(docFrames.map((e) => e.type)).toEqual([EventTypes.FILE_CREATED])
    expect(docFrames[0].projectId).toBeNull() // emit() bridge envelope
    expect(docFrames[0].payload.projectId).toBe(proj.id)
    // The stub really landed on disk.
    expect(existsSync(path.join(PROJ_DIR, "wiki", "sources", "doc2.md"))).toBe(true)
  })

  it("emits nothing when the injection fails (swallowed write error)", async () => {
    // PR #29 review round 2: injectImagesIntoSourceSummary swallows its own
    // write errors and reports null ⇒ no file:* frame for a write that never
    // happened. Sabotage: the summary path is a DIRECTORY, so both the read
    // (→ treated as missing) and the stub write (EISDIR) fail.
    const failSessionId = "conv_fswriters_inject_fail"
    writeFileSync(path.join(PROJ_DIR, "raw", "sources", "doc3.md"), "# Doc3\n")
    mkdirSync(path.join(PROJ_DIR, "wiki", "sources", "doc3.md"), { recursive: true })
    streamChatMock.mockImplementationOnce(async () => "No files generated.")
    extractImagesMock.mockResolvedValueOnce([
      { relPath: "media/doc3/img-1.png", sha256: "deadbeef", page: 1 },
    ])

    const watcher = watchEvents(failSessionId)
    try {
      const res = await request(app)
        .post(`/api/v2/projects/${proj.id}/chat/writes`)
        .send({ sessionId: failSessionId, sourcePath: "raw/sources/doc3.md" })
      expect(res.status).toBe(200)
      await watcher.waitDone()
    } finally {
      watcher.unsub()
    }

    expect(watcher.fileEvents.filter((e) => e.payload.path === "wiki/sources/doc3.md")).toEqual([])
  })
})
