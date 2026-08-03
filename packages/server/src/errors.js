// Structured API error for the v2 Express server.
//
// Every error that reaches the client is normalized by middleware/error.js into
// the envelope `{ error: { code, message, details } }` (V1_CHARTERED_ARCHITECTURE.md §4.6).
// Handlers throw ApiError with one of the stable codes below; anything else is
// mapped to INTERNAL_ERROR so internals never leak.
//
// The code list itself lives in @llm-wiki/api-types (issue #20) — the server
// DERIVES ErrorCode from it, so server and web client can never drift.

import { ERROR_CODES } from "@llm-wiki/api-types"

/** Stable API error codes, derived from the api-types SSOT (do not edit here). */
export const ErrorCode = Object.freeze({ ...ERROR_CODES })

const STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  CONFLICT: 409,
  FILE_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  WORKER_BUSY: 503,
}

export class ApiError extends Error {
  /**
   * @param {keyof typeof ErrorCode} code one of the stable error codes
   * @param {string} [message] human-readable; defaults to the code
   * @param {unknown} [details] structured detail (Zod issues, provider info…)
   */
  constructor(code, message, details) {
    super(message || code)
    this.name = "ApiError"
    this.code = code
    this.status = STATUS[code] || 500
    this.details = details
  }
}

export function statusForCode(code) {
  return STATUS[code] || 500
}
