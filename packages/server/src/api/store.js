// Store API router for the web client's @tauri-apps/plugin-store shim.
// Mounts on /api/store so the web client's store.js shim can read/write
// settings, recent projects, etc. over HTTP.
//
// Uses the same store.js backend as the legacy index.js server, so when
// the web server runs on the SAME host as the desktop, both clients see
// the same data.

import { Router } from "express"
import { readStore, writeStore, readStoreKey, writeStoreKey, deleteStoreKey } from "../store.js"

const router = Router()

// GET /api/store/:name — read entire store
router.get("/:name", (req, res) => {
  const obj = readStore(req.params.name)
  res.json(obj)
})

// PUT /api/store/:name — write entire store
router.put("/:name", (req, res) => {
  const merged = writeStore(req.params.name, req.body)
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
  res.json(result)
})

// DELETE /api/store/:name/:key — delete one key
router.delete("/:name/:key", (req, res) => {
  const existed = deleteStoreKey(req.params.name, req.params.key)
  res.json(existed)
})

export default router
