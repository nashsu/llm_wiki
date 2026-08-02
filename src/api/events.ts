// SSE event stream — GET /api/v2/events
//
// The server broadcasts every event as a default `message` carrying a JSON
// envelope `{ event, payload }` (see packages/server/src/api/events.js). This
// module wraps EventSource with JSON parsing, token auth (via query param,
// since EventSource cannot set headers), and auto-reconnect with backoff.

import { getBaseUrl, getToken } from "./client"

/** A parsed server-sent event envelope. */
export interface ServerEvent {
  event: string
  payload: unknown
}

export type EventListener = (evt: ServerEvent) => void

export interface ConnectOptions {
  onError?: (err: Event) => void
  onOpen?: () => void
  /** Max reconnect delay in ms (default 30000). */
  maxBackoff?: number
}

/**
 * Open the SSE connection and invoke `onEvent` for every parsed envelope.
 * Returns a `disconnect()` function that stops reconnection and closes the
 * stream.
 */
export function connectEvents(onEvent: EventListener, opts: ConnectOptions = {}): () => void {
  const maxBackoff = opts.maxBackoff ?? 30_000
  let source: EventSource | null = null
  let attempts = 0
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const url = buildEventsUrl()

  function open(): void {
    if (closed) return
    const es = new EventSource(url)
    source = es

    es.onopen = () => {
      attempts = 0
      opts.onOpen?.()
    }

    es.onmessage = (msg: MessageEvent) => {
      const parsed = tryParse(msg.data)
      if (parsed) onEvent(parsed)
    }

    es.onerror = (err: Event) => {
      opts.onError?.(err)
      es.close()
      source = null
      scheduleReconnect()
    }
  }

  function scheduleReconnect(): void {
    if (closed) return
    // Exponential backoff: 1s, 2s, 4s, … capped at maxBackoff.
    const delay = Math.min(1000 * 2 ** attempts, maxBackoff)
    attempts += 1
    reconnectTimer = setTimeout(open, delay)
  }

  function disconnect(): void {
    closed = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (source) {
      source.close()
      source = null
    }
  }

  open()
  return disconnect
}

function buildEventsUrl(): string {
  const base = `${getBaseUrl()}/api/v2/events`
  const token = getToken()
  // EventSource cannot set Authorization headers; pass the token as a query
  // param when auth is present. The server accepts ?token= for SSE.
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

function tryParse(data: string): ServerEvent | null {
  try {
    const parsed = JSON.parse(data) as Partial<ServerEvent>
    if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
      return { event: parsed.event, payload: parsed.payload ?? null }
    }
    return null
  } catch {
    return null
  }
}
