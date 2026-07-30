// Marker so shared (non-shim) code can detect it is running in the browser
// web build and skip desktop-only behavior (e.g. the clip-server poller).
export const IS_WEB_BUILD = true
;(globalThis as { __LLM_WIKI_WEB__?: boolean }).__LLM_WIKI_WEB__ = true

// Transport layer for the browser web client. Talks to the llm-wiki-server
// backend over same-origin HTTP + SSE. Only used in the web build (wired in
// via Vite aliases); the desktop Tauri build never imports this module.

const API_BASE = "" // same origin; the server serves both the SPA and the API

export class ServerCommandError extends Error {}

/** Invoke a backend command. Mirrors Tauri's `invoke`: resolves with the
 *  result value or rejects with an Error carrying the backend's message. */
export async function invokeHttp<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/api/invoke/${encodeURIComponent(command)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  })
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : `Command '${command}' failed (${res.status})`
    throw new ServerCommandError(message)
  }
  return parsed as T
}

export async function storeGet(name: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/store/${encodeURIComponent(name)}`)
  if (!res.ok) return {}
  return (await res.json()) as Record<string, unknown>
}

export async function storePut(name: string, value: Record<string, unknown>): Promise<void> {
  await fetch(`${API_BASE}/api/store/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value ?? {}),
  })
}

export async function storeGetKey(name: string, key: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/store/${encodeURIComponent(name)}/${encodeURIComponent(key)}`)
  if (!res.ok) return undefined
  const text = await res.text()
  if (!text || text === "null") return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

export async function storePutKey(name: string, key: string, value: unknown): Promise<void> {
  await fetch(`${API_BASE}/api/store/${encodeURIComponent(name)}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  })
}

export async function storeDeleteKey(name: string, key: string): Promise<void> {
  await fetch(`${API_BASE}/api/store/${encodeURIComponent(name)}/${encodeURIComponent(key)}`, { method: "DELETE" })
}

export interface HomeInfo {
  home: string
  cwd: string
  separator: string
  platform: string
}

let homeCache: HomeInfo | null = null
export async function getHome(): Promise<HomeInfo> {
  if (!homeCache) {
    const res = await fetch(`${API_BASE}/api/home`)
    homeCache = (await res.json()) as HomeInfo
  }
  return homeCache
}

/** URL that streams a server-side file to the browser (image previews etc.). */
export function rawFileUrl(path: string): string {
  return `${API_BASE}/api/raw?path=${encodeURIComponent(path)}`
}

// ── SSE event bus ─────────────────────────────────────────────────────────
type EventCallback = (payload: unknown) => void
const listeners = new Map<string, Set<EventCallback>>()
let eventSource: EventSource | null = null

function ensureEventSource() {
  if (eventSource) return
  eventSource = new EventSource(`${API_BASE}/api/events`)
  eventSource.onmessage = (msg) => {
    try {
      const { event, payload } = JSON.parse(msg.data) as { event: string; payload: unknown }
      const set = listeners.get(event)
      if (set) for (const cb of [...set]) {
        try { cb(payload) } catch (err) { console.error(`[events] listener for '${event}' threw`, err) }
      }
    } catch { /* ignore malformed frames */ }
  }
  eventSource.onerror = () => {
    // EventSource auto-reconnects; nothing to do but stay quiet.
  }
}

export function subscribeEvent(event: string, cb: EventCallback): () => void {
  ensureEventSource()
  let set = listeners.get(event)
  if (!set) { set = new Set(); listeners.set(event, set) }
  set.add(cb)
  return () => { set!.delete(cb) }
}
