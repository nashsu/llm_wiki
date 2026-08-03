// Stable API error codes — single source of truth (issue #20).
//
// The server's `ErrorCode` object (packages/server/src/errors.js) is DERIVED
// from ERROR_CODES, and the web client imports the types below — nobody
// hand-mirrors the list anymore (the old "keep in sync" comment is gone).

/**
 * Stable error codes returned by the server in the
 * `{ error: { code, message, details } }` envelope
 * (V1_CHARTERED_ARCHITECTURE.md §4.6).
 */
export const ERROR_CODES = {
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
} as const

/** Stable error code values (union of constant strings). */
export type ApiErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** The server's error envelope body: `{ code, message, details }`. */
export interface ApiErrorBody {
  code: ApiErrorCode | string
  message: string
  details: unknown
}
