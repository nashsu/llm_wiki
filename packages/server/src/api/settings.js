// Settings API router (Phase 2.3.10)
// Key-value settings backed by the shared plugin-store (store.js), so settings
// stay synchronized with the desktop app on the same host (the shared-data
// promise). Reads are mtime-aware; writes are key-level read-modify-write under
// a file lock so an unrelated key the desktop changed is never clobbered.

import { Router } from "express"
import { validate } from "../middleware/validate.js"
import {
  SettingKeyParamSchema,
  SettingWriteBodySchema,
  SettingWriteManyBodySchema,
} from "../schemas/settings.js"
import {
  readStore,
  writeStore,
  readStoreKey,
  writeStoreKey,
  deleteStoreKey,
} from "../store.js"
import { SHARED_STORE_NAME } from "../config.js"
import { ApiError, ErrorCode } from "../errors.js"

const router = Router()

// GET /api/v2/settings — read all settings
router.get("/", (req, res, next) => {
  try {
    res.json({ settings: readStore(SHARED_STORE_NAME) })
  } catch (err) {
    next(err)
  }
})

// POST /api/v2/settings — write multiple settings at once (merge)
router.post("/", validate({ body: SettingWriteManyBodySchema }), (req, res, next) => {
  try {
    const { values } = req.validated.body
    writeStore(SHARED_STORE_NAME, values)
    res.json({ written: Object.keys(values).length })
  } catch (err) {
    next(err)
  }
})

// GET /api/v2/settings/:key — read one setting
router.get("/:key", validate({ params: SettingKeyParamSchema }), (req, res, next) => {
  try {
    const { key } = req.validated.params
    const value = readStoreKey(SHARED_STORE_NAME, key)
    if (value === undefined) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Setting '${key}' not found`)
    }
    res.json({ key, value })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v2/settings/:key — write one setting
router.put(
  "/:key",
  validate({ params: SettingKeyParamSchema, body: SettingWriteBodySchema }),
  (req, res, next) => {
    try {
      const { key } = req.validated.params
      const { value } = req.validated.body
      writeStoreKey(SHARED_STORE_NAME, key, value)
      res.json({ key, value })
    } catch (err) {
      next(err)
    }
  }
)

// DELETE /api/v2/settings/:key — delete one setting
router.delete("/:key", validate({ params: SettingKeyParamSchema }), (req, res, next) => {
  try {
    const { key } = req.validated.params
    const existed = deleteStoreKey(SHARED_STORE_NAME, key)
    if (!existed) throw new ApiError(ErrorCode.NOT_FOUND, `Setting '${key}' not found`)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

export default router
