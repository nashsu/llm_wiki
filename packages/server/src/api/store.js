// Store API router for the web client's @tauri-apps/plugin-store shim.
// Mounts on /api/store so the web client's store.js shim can read/write
// settings, recent projects, etc. over HTTP.
//
// Uses the same store.js backend as the legacy index.js server, so when
// the web server runs on the SAME host as the desktop, both clients see
// the same data.

import { Router } from "express"
import { readStore, writeStore, readStoreKey, writeStoreKey, deleteStoreKey } from "../store.js"
import { SHARED_STORE_NAME } from "../config.js"
import { emit } from "../events.js"
import { EventTypes } from "../events/bus.js"

const router = Router()

// Writes to the shared settings store (app-state.json) are settings changes:
// emit settings:changed so sse-sync refetches settings in every connected
// tab. Other store names (recent-projects, UI state, …) are not settings
// and deliberately emit nothing (plans/sse-taxonomy.md).
function emitSettingsChanged(name, keys) {
  if (name !== SHARED_STORE_NAME) return
  emit(EventTypes.SETTINGS_CHANGED, { keys })
}

// GET /api/store/:name — read entire store
router.get("/:name", (req, res) => {
  const obj = readStore(req.params.name)
  res.json(obj)
})

// PUT /api/store/:name — write entire store
router.put("/:name", (req, res) => {
  const merged = writeStore(req.params.name, req.body)
  // writeStore merges only object bodies (non-objects merge as {}).
  const keys = req.body && typeof req.body === "object" ? Object.keys(req.body) : []
  emitSettingsChanged(req.params.name, keys)
  res.json(merged)
})

// GET /api/store/:name/:key — read one key
router.get("/:name/:key", (req, res) => {
  const value = readStoreKey(req.params.name, req.params.key)
  res.json(value === undefined ? null : value)
})

// PUT /api/store/:name/:key — write one key
router.put("/:name/:key", (req, res) => {
  const result = writeStoreKey(req.params.name, req.params.key, req.body)
  emitSettingsChanged(req.params.name, [req.params.key])
  res.json(result)
})

// DELETE /api/store/:name/:key — delete one key
router.delete("/:name/:key", (req, res) => {
  const existed = deleteStoreKey(req.params.name, req.params.key)
  emitSettingsChanged(req.params.name, [req.params.key])
  res.json(existed)
})

export default router
