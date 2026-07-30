// Shared Zod schemas for the v2 API (Phase 2.1.10).
//
// Cross-cutting shapes reused by every route group: the error envelope
// (architecture.md §4.6), pagination, and the health/version responses. Keeping
// these in one place means the OpenAPI spec (openapi.js) and every router agree
// on the wire format.

import { z } from "zod"

// ── Error envelope (architecture.md §4.6) ─────────────────────────────────
// Every error response is `{ error: { code, message, details } }`. `code` is one
// of the stable ErrorCode strings; `details` carries structured context (Zod
// issues, provider info) or null.
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().nullable(),
  }),
})

// ── Pagination ────────────────────────────────────────────────────────────
// Cursor-free offset pagination. Callers pass ?limit=&offset=; responses echo
// the window plus the total so clients can page without a second round-trip.
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

export const PaginatedMetaSchema = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
})

// ── System responses ──────────────────────────────────────────────────────
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  commands: z.number().int(),
})

export const VersionResponseSchema = z.object({
  version: z.string(),
  node: z.string(),
  platform: z.string(),
})
