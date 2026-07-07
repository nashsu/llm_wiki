/**
 * HTTP API client for the LLM Wiki Python backend.
 *
 * Replaces Tauri ``invoke()`` calls with standard ``fetch()`` requests
 * to the Python sidecar server running at ``localhost:19828``.
 *
 * Usage::
 *
 *   import { apiGet, apiPost, apiDelete } from "@/lib/api-client"
 *
 *   const templates = await apiGet("/api/projects/templates")
 *   await apiPost("/api/projects/create", { name, templateId: "default", path })
 *
 * Streaming (SSE)::
 *
 *   for await (const event of apiStream("/api/chat/{path}/stream", body)) {
 *     console.log(event)
 *   }
 */

import { API_SERVER_BASE_URL } from "@/lib/api-server-constants"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  /** HTTP status code (``0`` for network errors). */
  status: number
  /** Response body detail (parsed JSON or raw text). */
  detail: unknown

  constructor(status: number, detail: unknown) {
    const message = typeof detail === "string" ? detail : JSON.stringify(detail)
    super(`API error ${status}: ${message}`)
    this.name = "ApiError"
    this.status = status
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail: unknown
    try {
      detail = await response.json()
    } catch {
      detail = await response.text().catch(() => response.statusText)
    }
    throw new ApiError(response.status, detail)
  }
  // 204 No Content
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Perform a GET request and parse the JSON response. */
export async function apiGet<T = unknown>(endpoint: string): Promise<T> {
  const url = `${API_SERVER_BASE_URL}${endpoint}`
  const response = await fetch(url)
  return handleResponse<T>(response)
}

/** Perform a POST request with an optional JSON body. */
export async function apiPost<T = unknown>(
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const url = `${API_SERVER_BASE_URL}${endpoint}`
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return handleResponse<T>(response)
}

/** Perform a PUT request with an optional JSON body. */
export async function apiPut<T = unknown>(
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const url = `${API_SERVER_BASE_URL}${endpoint}`
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return handleResponse<T>(response)
}

/** Perform a DELETE request. */
export async function apiDelete<T = unknown>(endpoint: string): Promise<T> {
  const url = `${API_SERVER_BASE_URL}${endpoint}`
  const response = await fetch(url, { method: "DELETE" })
  return handleResponse<T>(response)
}

/**
 * Stream Server-Sent Events (SSE) from a POST endpoint.
 *
 * Yields parsed JSON objects from each ``data:`` line. The generator
 * completes when the server sends ``{"type": "done"}`` or closes the
 * connection.
 */
export async function* apiStream<T = unknown>(
  endpoint: string,
  body: unknown,
): AsyncGenerator<T, void, void> {
  const url = `${API_SERVER_BASE_URL}${endpoint}`
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let detail: unknown
    try {
      detail = await response.json()
    } catch {
      detail = await response.text().catch(() => response.statusText)
    }
    throw new ApiError(response.status, detail)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new ApiError(0, "Response body is not readable")

  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6).trim()
          if (payload) {
            const event = JSON.parse(payload) as T
            yield event
          }
        }
      }
    }

    // Process remaining buffer
    const trimmed = buffer.trim()
    if (trimmed.startsWith("data: ")) {
      const payload = trimmed.slice(6).trim()
      if (payload) {
        const event = JSON.parse(payload) as T
        yield event
      }
    }
  } finally {
    reader.releaseLock()
  }
}
