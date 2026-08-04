// Global error handler for the v2 Express server.
//
// Mounted last in the middleware chain. Normalizes every error into the
// envelope `{ error: { code, message, details } }` (V1_CHARTERED_ARCHITECTURE.md §4.6):
//   - ApiError      → its own code/status/details
//   - ZodError      → VALIDATION_ERROR with the issue array as details
//   - MulterError LIMIT_FILE_SIZE → FILE_TOO_LARGE (413)
//   - anything else → INTERNAL_ERROR (message scrubbed so internals don't leak)

// NOTE: ZodError comes from @llm-wiki/api-types (not a direct zod dep) so it
// is the SAME class instance that the schemas throw — `instanceof` fails
// across duplicate zod copies.
import { ZodError } from "@llm-wiki/api-types"
// Multer is imported only for its MulterError class (same default-import
// style as api/ingest.js): an oversize multipart upload must surface as a
// 413 FILE_TOO_LARGE, not the scrubbed 500 it used to fall through to
// (issue #14 P2).
import multer from "multer"
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
  // Multer's own LIMIT_FILE_SIZE fires when a multipart upload exceeds the
  // configured limits.fileSize — map it to the stable FILE_TOO_LARGE envelope
  // BEFORE the generic fallback below.
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(statusForCode(ErrorCode.FILE_TOO_LARGE)).json({
      error: {
        code: ErrorCode.FILE_TOO_LARGE,
        message: "File exceeds the maximum upload size",
        details: null,
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
