// Stage 1 of plans/sse-taxonomy.md: settings:changed emission.
//
// Writes to the shared settings store must publish a settings:changed frame
// ({ keys }) onto the bus via the legacy emit() bridge — envelope
// { type, projectId: null, payload: { keys } } — so sse-sync refetches
// settings in every connected tab. Covered sites:
//   - api/settings.js: POST / (keys of merged body), PUT /:key, DELETE /:key
//   - api/store.js v2 shim: PUT /:name, PUT /:name/:key, DELETE /:name/:key,
//     gated on name === SHARED_STORE_NAME (non-shared names emit NOTHING)
//
// emit() republishes onto the bus synchronously, so frames are captured by
// the time each supertest request resolves (same bus-frame pattern as
// api-chat-writes.test.js).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-settevents-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")
const { eventBus, EventTypes } = await import("../src/events/bus.js")
const { SHARED_STORE_NAME } = await import("../src/config.js")

/** settings:changed envelopes captured off the internal bus. */
let frames = []
let unsubscribe = null

beforeAll(() => {
  unsubscribe = eventBus.subscribe((env) => {
    if (env.type === EventTypes.SETTINGS_CHANGED) frames.push(env)
  })
})

afterAll(() => {
  unsubscribe?.()
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  frames = []
})

/** All settings:changed frames ride the emit() bridge: projectId stays null. */
function expectSettingsFrames(expectedKeysList) {
  expect(frames).toHaveLength(expectedKeysList.length)
  for (let i = 0; i < expectedKeysList.length; i++) {
    expect(frames[i].type).toBe("settings:changed")
    expect(frames[i].projectId).toBeNull()
    expect(frames[i].payload).toEqual({ keys: expectedKeysList[i] })
  }
}

describe("api/settings.js emits settings:changed", () => {
  it("POST / emits the merged body's keys", async () => {
    const res = await request(app)
      .post("/api/v2/settings")
      .send({ values: { outputLanguage: "English", zoomLevel: 1.25 } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ written: 2 })
    expectSettingsFrames([["outputLanguage", "zoomLevel"]])
  })

  it("PUT /:key emits [key]", async () => {
    const res = await request(app)
      .put("/api/v2/settings/outputLanguage")
      .send({ value: "Chinese" })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ key: "outputLanguage", value: "Chinese" })
    expectSettingsFrames([["outputLanguage"]])
  })

  it("DELETE /:key emits [key] after a successful delete", async () => {
    const res = await request(app).delete("/api/v2/settings/zoomLevel")
    expect(res.status).toBe(204)
    expectSettingsFrames([["zoomLevel"]])
  })

  it("DELETE /:key of a missing key 404s and emits nothing", async () => {
    const res = await request(app).delete("/api/v2/settings/neverSetKey123")
    expect(res.status).toBe(404)
    expectSettingsFrames([])
  })
})

describe("api/store.js shim emits settings:changed only for the shared store", () => {
  it(`PUT /:name/:key on ${SHARED_STORE_NAME} emits [key]`, async () => {
    // Mirrors src/web/http-api.ts storePutKey: JSON.stringify(value) raw body.
    const res = await request(app)
      .put(`/api/store/${SHARED_STORE_NAME}/theme`)
      .set("Content-Type", "application/json")
      .send('"dark"')
    expect(res.status).toBe(200)
    expectSettingsFrames([["theme"]])
  })

  it(`PUT /:name on ${SHARED_STORE_NAME} emits the body keys`, async () => {
    const res = await request(app)
      .put(`/api/store/${SHARED_STORE_NAME}`)
      .send({ sidebarCollapsed: true, recentLimit: 5 })
    expect(res.status).toBe(200)
    expectSettingsFrames([["sidebarCollapsed", "recentLimit"]])
  })

  it(`DELETE /:name/:key on ${SHARED_STORE_NAME} emits [key]`, async () => {
    const res = await request(app).delete(`/api/store/${SHARED_STORE_NAME}/theme`)
    expect(res.status).toBe(200)
    expect(res.body).toBe(true)
    expectSettingsFrames([["theme"]])
  })

  it("non-shared store names emit NOTHING on all three write routes", async () => {
    const putKey = await request(app)
      .put("/api/store/ui-state.json/theme")
      .set("Content-Type", "application/json")
      .send('"dark"')
    expect(putKey.status).toBe(200)

    const putWhole = await request(app)
      .put("/api/store/ui-state.json")
      .send({ panel: "left" })
    expect(putWhole.status).toBe(200)

    const del = await request(app).delete("/api/store/ui-state.json/theme")
    expect(del.status).toBe(200)

    expectSettingsFrames([])
  })
})
