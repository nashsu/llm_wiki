// REST tests for the chat session endpoints (issue #21).
//
// Covers the session-management surface added on top of the chartered
// chat_sessions / chat_messages tables: create / list / get / rename /
// delete, per-project isolation, and project resolution by both the
// integer projects-table id and the client project UUID (plugin-store
// registry fallback, materializing the projects row on first use).
//
// IMPORTANT: env vars set BEFORE importing the app (it reads LLM_WIKI_DATA_DIR
// at module load). LLM_WIKI_AUTH_MODE=none guarantees open mode regardless of host env.

import { describe, it, expect, afterAll } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-chatsess-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

async function createProject(name) {
  const root = path.join(DATA_DIR, name)
  const res = await request(app).post("/api/v2/projects").send({ name, path: root })
  expect(res.status).toBe(201)
  return res.body.project
}

describe("v2 chat session endpoints", () => {
  it("creates, lists, gets, renames and deletes sessions per project", async () => {
    const p1 = await createProject("chat-proj-one")

    // Create (server generates the uuid).
    const created = await request(app)
      .post(`/api/v2/projects/${p1.id}/chat/sessions`)
      .send({ title: "First session" })
    expect(created.status).toBe(201)
    const session = created.body.session
    expect(session.id).toBeTypeOf("string")
    expect(session.id.length).toBeGreaterThan(0)
    expect(session.projectId).toBe(p1.id)
    expect(session.title).toBe("First session")

    // List.
    const list = await request(app).get(`/api/v2/projects/${p1.id}/chat/sessions`)
    expect(list.status).toBe(200)
    expect(list.body.sessions).toHaveLength(1)
    expect(list.body.sessions[0].id).toBe(session.id)

    // Get one (empty message list for a fresh session).
    const one = await request(app).get(`/api/v2/projects/${p1.id}/chat/sessions/${session.id}`)
    expect(one.status).toBe(200)
    expect(one.body.session.id).toBe(session.id)
    expect(one.body.messages).toEqual([])

    // Rename.
    const renamed = await request(app)
      .patch(`/api/v2/projects/${p1.id}/chat/sessions/${session.id}`)
      .send({ title: "Renamed session" })
    expect(renamed.status).toBe(200)
    expect(renamed.body.session.title).toBe("Renamed session")
    const afterRename = await request(app).get(`/api/v2/projects/${p1.id}/chat/sessions/${session.id}`)
    expect(afterRename.body.session.title).toBe("Renamed session")

    // Delete.
    const del = await request(app).delete(`/api/v2/projects/${p1.id}/chat/sessions/${session.id}`)
    expect(del.status).toBe(204)
    const afterDelete = await request(app).get(`/api/v2/projects/${p1.id}/chat/sessions/${session.id}`)
    expect(afterDelete.status).toBe(404)
    expect(afterDelete.body.error.code).toBe("NOT_FOUND")
    const listAfter = await request(app).get(`/api/v2/projects/${p1.id}/chat/sessions`)
    expect(listAfter.body.sessions).toEqual([])
  })

  it("isolates sessions between projects", async () => {
    const pa = await createProject("chat-proj-a")
    const pb = await createProject("chat-proj-b")

    const created = await request(app)
      .post(`/api/v2/projects/${pa.id}/chat/sessions`)
      .send({ title: "Only in A" })
    expect(created.status).toBe(201)
    const id = created.body.session.id

    // Not visible from project B: neither in the list nor via direct get.
    const listB = await request(app).get(`/api/v2/projects/${pb.id}/chat/sessions`)
    expect(listB.body.sessions).toEqual([])
    const crossGet = await request(app).get(`/api/v2/projects/${pb.id}/chat/sessions/${id}`)
    expect(crossGet.status).toBe(404)
    const crossPatch = await request(app)
      .patch(`/api/v2/projects/${pb.id}/chat/sessions/${id}`)
      .send({ title: "steal" })
    expect(crossPatch.status).toBe(404)
    const crossDelete = await request(app).delete(`/api/v2/projects/${pb.id}/chat/sessions/${id}`)
    expect(crossDelete.status).toBe(404)

    // Still intact in A.
    const getA = await request(app).get(`/api/v2/projects/${pa.id}/chat/sessions/${id}`)
    expect(getA.status).toBe(200)
    expect(getA.body.session.title).toBe("Only in A")
  })

  it("validates inputs", async () => {
    const p = await createProject("chat-proj-validate")
    const badRename = await request(app)
      .post(`/api/v2/projects/${p.id}/chat/sessions`)
      .send({ title: "x" })
    const id = badRename.body.session.id
    const empty = await request(app)
      .patch(`/api/v2/projects/${p.id}/chat/sessions/${id}`)
      .send({ title: "" })
    expect(empty.status).toBe(400)
    expect(empty.body.error.code).toBe("VALIDATION_ERROR")
    const missing = await request(app)
      .patch(`/api/v2/projects/${p.id}/chat/sessions/${id}`)
      .send({})
    expect(missing.status).toBe(400)
  })

  it("resolves the project by client UUID via the plugin-store registry", async () => {
    // Projects opened in the client live in the plugin-store registry, not the
    // projects table. Chat routes must resolve them by UUID and materialize
    // the projects row (chat_sessions' FK target).
    const uuid = "proj-uuid-from-client"
    const root = path.join(DATA_DIR, "registry-proj")
    mkdirSync(path.join(root, ".llm-wiki"), { recursive: true })
    const storeFile = path.join(DATA_DIR, "stores", "app-state.json")
    mkdirSync(path.dirname(storeFile), { recursive: true })
    writeFileSync(storeFile, JSON.stringify({
      projectRegistry: { [uuid]: { id: uuid, path: root } },
    }))

    const created = await request(app)
      .post(`/api/v2/projects/${uuid}/chat/sessions`)
      .send({ title: "Registry session" })
    expect(created.status).toBe(201)
    expect(created.body.session.title).toBe("Registry session")

    const list = await request(app).get(`/api/v2/projects/${uuid}/chat/sessions`)
    expect(list.status).toBe(200)
    expect(list.body.sessions).toHaveLength(1)

    // The row now resolves by its materialized integer id too.
    const numericId = created.body.session.projectId
    expect(numericId).toBeTypeOf("number")
    const byNumeric = await request(app).get(`/api/v2/projects/${numericId}/chat/sessions`)
    expect(byNumeric.status).toBe(200)
    expect(byNumeric.body.sessions).toHaveLength(1)
  })

  it("404s for unknown projects and sessions", async () => {
    const unknownNumeric = await request(app).get("/api/v2/projects/99999/chat/sessions")
    expect(unknownNumeric.status).toBe(404)
    expect(unknownNumeric.body.error.code).toBe("PROJECT_NOT_FOUND")

    const unknownUuid = await request(app).get("/api/v2/projects/no-such-uuid/chat/sessions")
    expect(unknownUuid.status).toBe(404)
    expect(unknownUuid.body.error.code).toBe("PROJECT_NOT_FOUND")

    const p = await createProject("chat-proj-404")
    const missingSession = await request(app).get(`/api/v2/projects/${p.id}/chat/sessions/never-existed`)
    expect(missingSession.status).toBe(404)
    expect(missingSession.body.error.code).toBe("NOT_FOUND")
  })
})
