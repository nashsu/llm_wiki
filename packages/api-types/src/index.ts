/**
 * @llm-wiki/api-types — the LLM Wiki REST API contract.
 *
 * Single source of truth (issue #20; V1_CHARTERED_ARCHITECTURE.md §6.1,
 * Decision 8): the Zod schemas here are exactly what the server validates
 * requests with (it imports the built JS), and the web client consumes the
 * `z.infer` types — so the wire format cannot drift between server and
 * client. The hand-mirrored error enum is gone; the server's `ErrorCode`
 * is derived from {@link ERROR_CODES}.
 *
 * Usage:
 *   import { CreateProjectSchema, type CreateProject, ERROR_CODES, type ApiErrorCode }
 *     from '@llm-wiki/api-types'
 */

// Zod OpenAPI wiring MUST be evaluated before any schema module: the OpenAPI
// registry calls schema.openapi() when registering, so Zod has to be extended
// first. Importing it here (the package's only entry point) guarantees that.
import "./zod-setup.js"

// Runtime re-exports so the server shares THIS package's single zod +
// zod-to-openapi instances instead of depending on them directly. Duplicating
// either library across packages breaks identity-sensitive machinery:
// zod-to-openapi's registry cannot tag schemas built by a *different* zod
// instance with refIds (so OpenAPI components get inlined instead of emitted
// as $refs), and `err instanceof ZodError` fails across distinct zod copies.
export { z, ZodError } from "zod"
export type { ZodSchema, ZodType } from "zod"
export {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi"

// Stable error codes + envelope types (SSOT; server derives ErrorCode from these).
export * from "./errors.js"

// Runtime Zod schemas + inferred types, grouped as they were on the server.
export * from "./schemas/common.js"
export * from "./schemas/auth.js"
export * from "./schemas/projects.js"
export * from "./schemas/files.js"
export * from "./schemas/chat.js"
export * from "./schemas/graph.js"
export * from "./schemas/ingest.js"
export * from "./schemas/maintenance.js"
export * from "./schemas/reviews.js"
export * from "./schemas/search.js"
export * from "./schemas/settings.js"
