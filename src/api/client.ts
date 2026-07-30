// Core fetch wrapper for the LLM Wiki v2 REST API.
//
// - Base URL comes from VITE_API_URL (empty string = same origin).
// - Auth token is read from localStorage('llm-wiki-token') and sent as a
//   Bearer header on every request.
// - Errors are parsed from the server's `{ error: { code, message, details } }`
//   envelope (architecture.md §4.6) and surfaced as ApiError.

import type { ApiErrorCode, ApiErrorBody } from "@llm-wiki/api-types"

export const TOKEN_STORAGE_KEY = "llm-wiki-token"

/** Re-export for convenience — most callers only need the ApiError class. */
export type { ApiErrorCode, ApiErrorBody }

/** Error thrown for any non-2xx response from the API. */
export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode | string
  readonly details: unknown

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.code || `Request failed (${status})`)
    this.name = "ApiError"
    this.status = status
    this.code = body.code
    this.details = body.details
  }
}

/** Base URL for all API calls. Empty string means same-origin. */
export function getBaseUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  return env?.VITE_API_URL ?? ""
}

/** Read the auth token from localStorage, or null when unset/unavailable. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

/** Persist the auth token (used by the login flow). */
export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_STORAGE_KEY)
    else localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    /* storage unavailable (e.g. SSR/tests) — ignore */
  }
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** JSON-serializable request body (mutually exclusive with `form`). */
  json?: unknown
  /** FormData body for multipart uploads (mutually exclusive with `json`). */
  form?: FormData
  /** Query parameters; undefined values are omitted. */
  query?: Record<string, string | number | boolean | undefined>
  /** AbortSignal passthrough (also accepted via RequestInit.signal). */
  signal?: AbortSignal
}

/** Build a query string (with leading "?") from a params record. */
export function buildQuery(
  query?: Record<string, string | number | boolean | undefined>,
): string {
  if (!query) return ""
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    usp.set(key, String(value))
  }
  const s = usp.toString()
  return s ? `?${s}` : ""
}

/** Resolve a path (and optional query) against the configured base URL. */
export function resolveUrl(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  return `${getBaseUrl()}${path}${buildQuery(query)}`
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody = {
    code: "INTERNAL_ERROR",
    message: `Request failed (${res.status})`,
    details: null,
  }
  try {
    const text = await res.text()
    if (text) {
      const parsed = JSON.parse(text) as { error?: Partial<ApiErrorBody> }
      if (parsed && typeof parsed === "object" && parsed.error) {
        body = {
          code: parsed.error.code ?? body.code,
          message: parsed.error.message ?? body.message,
          details: parsed.error.details ?? null,
        }
      }
    }
  } catch {
    /* non-JSON error body — keep the generic message */
  }
  return new ApiError(res.status, body)
}

/**
 * Typed fetch wrapper. Resolves with the parsed JSON body as `T`, or rejects
 * with an ApiError carrying the server's error envelope.
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { json, form, query, headers, ...init } = opts

  const finalHeaders = new Headers(headers)
  const token = getToken()
  if (token && !finalHeaders.has("Authorization")) {
    finalHeaders.set("Authorization", `Bearer ${token}`)
  }

  let body: BodyInit | undefined
  if (form !== undefined) {
    body = form
    // Let the browser set the multipart boundary; do not set Content-Type.
  } else if (json !== undefined) {
    body = JSON.stringify(json)
    if (!finalHeaders.has("Content-Type")) {
      finalHeaders.set("Content-Type", "application/json")
    }
  }

  const res = await fetch(resolveUrl(path, query), { ...init, headers: finalHeaders, body })

  if (!res.ok) {
    throw await parseError(res)
  }

  // 204 No Content (and empty bodies) resolve as undefined.
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}
