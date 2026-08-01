// Structured API error for the v2 Express server.
//
// Every error that reaches the client is normalized by middleware/error.js into
// the envelope `{ error: { code, message, details } }` (V1_CHARTERED_ARCHITECTURE.md §4.6).
// Handlers throw ApiError with one of the stable codes below; anything else is
// mapped to INTERNAL_ERROR so internals never leak.
//
// When adding or changing an error code, keep @llm-wiki/api-types in sync
// (packages/api-types/src/index.ts) — the web client imports from there.

export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  CONFLICT: "CONFLICT",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  WORKER_BUSY: "WORKER_BUSY",
}

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
