/**
 * @llm-wiki/api-types
 *
 * TypeScript types and constants for the LLM Wiki REST API. This is the single
 * source of truth for the stable error code, the error envelope shape, and any
 * other types that both the server and web client need to agree on.
 *
 * The types mirror the server's JS definitions (packages/server/src/errors.js)
 * but live here so the web client (and MCP server) don't hand-duplicate them.
 *
 * Usage:
 *   import { ApiErrorCode, ERROR_CODES, type ApiErrorBody } from '@llm-wiki/api-types'
 */

/**
 * Stable error codes returned by the server in the
 * `{ error: { code, message, details } }` envelope.
 *
 * Keep in sync with packages/server/src/errors.js ErrorCode object.
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

/** The server's error envelope: `{ error: { code, message, details } }`. */
export interface ApiErrorBody {
  code: ApiErrorCode | string
  message: string
  details: unknown
}