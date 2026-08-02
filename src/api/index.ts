// Barrel for the typed v2 API client. Re-exports every module as a namespace
// plus the core client primitives at the top level.
//
// Usage:
//   import { projects, files, ApiError } from "@/api"
//   const list = await projects.listProjects()

export * as projects from "./projects"
export * as files from "./files"
export * as search from "./search"
export * as chat from "./chat"
export * as ingest from "./ingest"
export * as settings from "./settings"
export * as events from "./events"
export * as auth from "./auth"
export * as adapter from "./adapter"

// Core client primitives (request helper, ApiError, token management).
export {
  request,
  ApiError,
  getBaseUrl,
  getToken,
  setToken,
  resolveUrl,
  buildQuery,
  TOKEN_STORAGE_KEY,
} from "./client"
export type {
  ApiErrorCode,
  ApiErrorBody,
  RequestOptions,
} from "./client"
