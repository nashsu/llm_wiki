// Auth API router (Phase 2.3.2)
// Token-based auth (decision #14). No username/password — the client presents
// the configured API token. POST /auth/login validates a token against the
// effective auth config (env or shared store) so the web client's "API Token +
// Connect" login screen can verify credentials before storing them.
// GET /auth/status reports whether auth is required/configured (public, used by
// the client to decide whether to show the login screen).

import { Router } from "express"
import crypto from "node:crypto"
import { validate } from "../middleware/validate.js"
import { LoginRequestSchema } from "../schemas/auth.js"
import { resolveAuth } from "../auth/config.js"
import { ApiError, ErrorCode } from "../errors.js"
import { constantTimeEq } from "../lib/crypto-utils.js"

const router = Router()

// GET /api/v2/auth/status — public; reports auth posture for the client
router.get("/status", (req, res) => {
  const a = resolveAuth()
  res.json({
    authRequired: a.authConfigured && !a.allowUnauth,
    authConfigured: a.authConfigured,
    allowUnauthenticated: a.allowUnauth,
  })
})

// POST /api/v2/auth/login — validate a token
router.post("/login", validate({ body: LoginRequestSchema }), (req, res, next) => {
  try {
    const { token } = req.validated.body
    const a = resolveAuth()
    // No token configured → server is open; any login succeeds (local mode).
    if (!a.authConfigured || a.allowUnauth) {
      return res.json({ success: true, message: "Authenticated (open mode)" })
    }
    if (constantTimeEq(token, a.token)) {
      return res.json({ success: true, message: "Authenticated" })
    }
    throw new ApiError(ErrorCode.UNAUTHORIZED, "Invalid token")
  } catch (err) {
    next(err)
  }
})

export default router
