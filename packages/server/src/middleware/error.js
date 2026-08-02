// Global error handler for the v2 Express server.
//
// Mounted last in the middleware chain. Normalizes every error into the
// envelope `{ error: { code, message, details } }` (V1_CHARTERED_ARCHITECTURE.md §4.6):
//   - ApiError      → its own code/status/details
//   - ZodError      → VALIDATION_ERROR with the issue array as details
//   - anything else → INTERNAL_ERROR (message scrubbed so internals don't leak)

import { ZodError } from "zod"
import { ApiError, ErrorCode, statusForCode } from "../errors.js"

/** Express error middleware (4-arg signature). */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    })
  }
  if (err instanceof ZodError) {
    return res.status(statusForCode(ErrorCode.VALIDATION_ERROR)).json({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: "Request validation failed",
        details: err.issues,
      },
    })
  }
  // Unexpected. Log server-side (with stack) but return a scrubbed envelope.
  console.error("[v2] unhandled error:", err)
  return res.status(500).json({
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: "Internal server error",
      details: null,
    },
  })
}
