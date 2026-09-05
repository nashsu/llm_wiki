/**
 * Browser implementation of the host backend, talking to `llm-wiki-server`
 * (see `src-tauri/src/web/mod.rs`). Same origin as the page; every call
 * carries the session cookie set by the login screen.
 *
 *   invoke()      → POST /web/rpc/{command}
 *   listen()      → one shared EventSource on GET /web/events
 *   fileSrc()     → GET /web/file?path=…
 *   getFetch()    → POST /web/proxy (server-side outbound request)
 *   loadStore()   → web_store_* RPC commands (same app-state.json file)
 *   dialog.open() → browser upload (files) or the server folder picker (dirs)
 */

import { useWikiStore } from "@/stores/wiki-store"
import { isProxyActive } from "@/lib/proxy-config"
import { requestWebDialog } from "./web-dialog-store"
import type {
  Backend,
  BackendEvent,
  KeyValueStore,
  OpenDialogOptions,
  UnlistenFn,
} from "./types"

export const WEB_API_BASE = "/web"

// ── invoke ──────────────────────────────────────────────────────────────────

interface RpcEnvelope<T> {
  ok: boolean
  result?: T
  error?: string
}

export class WebAuthRequiredError extends Error {
  constructor() {
    super("Authentication required")
    this.name = "WebAuthRequiredError"
  }
}

const authListeners = new Set<() => void>()

/** Subscribe to "the server said 401" so the app can show the login screen. */
export function onWebAuthRequired(listener: () => void): UnlistenFn {
  authListeners.add(listener)
  return () => authListeners.delete(listener)
}

function notifyAuthRequired(): void {
  for (const listener of authListeners) listener()
}

async function rpc<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${WEB_API_BASE}/rpc/${encodeURIComponent(command)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
    credentials: "same-origin",
  })
  if (response.status === 401) {
    notifyAuthRequired()
    throw new WebAuthRequiredError()
  }
  let envelope: RpcEnvelope<T>
  try {
    envelope = (await response.json()) as RpcEnvelope<T>
  } catch {
    throw `HTTP ${response.status} from ${command}`
  }
  if (!envelope.ok) {
    // Tauri rejects invoke() with the raw error string; keep that contract
    // so existing `String(err)` / `err instanceof Error` handling behaves.
    throw envelope.error ?? `Command ${command} failed`
  }
  return envelope.result as T
}

// ── listen ──────────────────────────────────────────────────────────────────

type Handler = (event: BackendEvent<unknown>) => void

const handlers = new Map<string, Set<Handler>>()
let eventSource: EventSource | null = null
let nextEventId = 1

function ensureEventSource(): void {
  if (eventSource || typeof EventSource === "undefined") return
  eventSource = new EventSource(`${WEB_API_BASE}/events`, { withCredentials: true })
  eventSource.onmessage = (message) => {
    let envelope: { event: string; payload: unknown }
    try {
      envelope = JSON.parse(message.data)
    } catch {
      return
    }
    const listeners = handlers.get(envelope.event)
    if (!listeners || listeners.size === 0) return
    const event: BackendEvent<unknown> = {
      event: envelope.event,
      id: nextEventId++,
      payload: envelope.payload,
    }
    for (const listener of Array.from(listeners)) {
      try {
        listener(event)
      } catch (err) {
        console.error(`[backend/web] listener for "${envelope.event}" threw:`, err)
      }
    }
  }
  eventSource.onerror = () => {
    // EventSource reconnects on its own. A 401 mid-stream shows up as an
    // error too; probe auth so the login screen appears if needed.
    void fetch(`${WEB_API_BASE}/auth/me`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((info: { authenticated?: boolean }) => {
        if (info.authenticated === false) notifyAuthRequired()
      })
      .catch(() => undefined)
  }
}

function listen<T>(event: string, handler: (event: BackendEvent<T>) => void): Promise<UnlistenFn> {
  ensureEventSource()
  let set = handlers.get(event)
  if (!set) {
    set = new Set()
    handlers.set(event, set)
  }
  const wrapped = handler as Handler
  set.add(wrapped)
  return Promise.resolve(() => {
    set?.delete(wrapped)
    if (set && set.size === 0) handlers.delete(event)
  })
}

// ── files ───────────────────────────────────────────────────────────────────

function fileSrc(absolutePath: string): string {
  return `${WEB_API_BASE}/file?path=${encodeURIComponent(absolutePath)}`
}

function downloadUrl(absolutePath: string): string {
  return `${fileSrc(absolutePath)}&download=1`
}

// ── proxied fetch ───────────────────────────────────────────────────────────

const PASSTHROUGH_STATUS_WITHOUT_BODY = new Set([101, 204, 205, 304])

function headersToObject(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  if (!init) return out
  new Headers(init).forEach((value, key) => {
    out[key] = value
  })
  return out
}

function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

async function bodyToPayload(
  body: BodyInit | null | undefined,
): Promise<{ body?: string; bodyBase64?: string }> {
  if (body == null) return {}
  if (typeof body === "string") return { body }
  // Blob / ArrayBuffer / FormData / URLSearchParams / ReadableStream:
  // materialize through a Response and ship as base64.
  const bytes = new Uint8Array(await new Response(body).arrayBuffer())
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return { bodyBase64: btoa(binary) }
}

/**
 * `fetch`-compatible function that performs the request from the server.
 * Network-level failures reject with a `TypeError("Failed to fetch")` so the
 * app's `isFetchNetworkError()` heuristics keep working.
 */
const proxiedFetch: typeof globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : null
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  const method = init?.method ?? request?.method ?? "GET"
  const headers = headersToObject(init?.headers ?? request?.headers)
  const payload = await bodyToPayload(init?.body ?? (request ? await request.clone().text() : null))
  const proxy = useWikiStore.getState().proxyConfig
  const acceptInvalidCerts = isProxyActive(proxy) && proxy.acceptInvalidCerts === true

  let response: Response
  try {
    response = await fetch(`${WEB_API_BASE}/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, method, headers, acceptInvalidCerts, ...payload }),
      credentials: "same-origin",
      signal: init?.signal ?? request?.signal ?? undefined,
    })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err
    throw new TypeError("Failed to fetch")
  }
  if (response.status === 401) {
    notifyAuthRequired()
    throw new TypeError("Failed to fetch")
  }
  if (response.headers.get("x-proxy-error")) {
    const detail = await response.text().catch(() => "")
    console.warn("[backend/web] proxy request failed:", detail)
    throw new TypeError("Failed to fetch")
  }
  const status = Number(response.headers.get("x-proxy-status") ?? response.status)
  let upstreamHeaders: Record<string, string> = {}
  const encoded = response.headers.get("x-proxy-headers")
  if (encoded) {
    try {
      upstreamHeaders = JSON.parse(decodeBase64Utf8(encoded))
    } catch {
      upstreamHeaders = {}
    }
  }
  const body = PASSTHROUGH_STATUS_WITHOUT_BODY.has(status) ? null : response.body
  return new Response(body, { status, headers: upstreamHeaders })
}

// ── settings store ──────────────────────────────────────────────────────────

const storeCache = new Map<string, KeyValueStore>()

function createStore(): KeyValueStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await rpc<T | null>("web_store_get", { key })
      return value === null || value === undefined ? undefined : value
    },
    set: (key, value) => rpc<void>("web_store_set", { key, value: value ?? null }),
    delete: (key) => rpc<boolean>("web_store_delete", { key }),
    clear: () => rpc<void>("web_store_clear"),
    save: async () => {
      /* every set() is persisted immediately */
    },
    async entries<T>(): Promise<[string, T][]> {
      const all = await rpc<Record<string, T>>("web_store_entries")
      return Object.entries(all)
    },
  }
}

// ── dialogs ─────────────────────────────────────────────────────────────────

const OPEN_FILE_ACCEPT_FALLBACK = ""

function acceptFromFilters(options: OpenDialogOptions): string {
  const extensions = options.filters?.flatMap((f) => f.extensions) ?? []
  if (extensions.length === 0 || extensions.includes("*")) return OPEN_FILE_ACCEPT_FALLBACK
  return extensions.map((ext) => `.${ext.replace(/^\./, "")}`).join(",")
}

/** Open the browser's file chooser and upload the selection to the server. */
export function pickAndUploadFiles(options: OpenDialogOptions & { folder?: boolean }): Promise<string[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = options.multiple !== false || options.folder === true
    input.accept = acceptFromFilters(options)
    if (options.folder) input.setAttribute("webkitdirectory", "")
    input.style.display = "none"
    let settled = false
    const finish = (value: string[] | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? [])
      if (files.length === 0) return finish(null)
      try {
        finish(await uploadFiles(files, options.folder === true))
      } catch (err) {
        console.error("[backend/web] upload failed:", err)
        finish(null)
      }
    })
    // Cancel is not reported reliably across browsers; treat focus return
    // without a change event as cancel after a grace period.
    window.addEventListener(
      "focus",
      () => {
        setTimeout(() => {
          if (!settled && (input.files?.length ?? 0) === 0) finish(null)
        }, 1500)
      },
      { once: true },
    )
    document.body.appendChild(input)
    input.click()
  })
}

export async function uploadFiles(files: File[], preserveRelativePaths: boolean): Promise<string[]> {
  const form = new FormData()
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    const fieldName = preserveRelativePaths && relative ? `dir:${relative}` : "file"
    form.append(fieldName, file, file.name)
  }
  const response = await fetch(`${WEB_API_BASE}/upload`, {
    method: "POST",
    body: form,
    credentials: "same-origin",
  })
  if (response.status === 401) {
    notifyAuthRequired()
    throw new WebAuthRequiredError()
  }
  const result = (await response.json()) as {
    ok: boolean
    error?: string
    batchDir?: string
    files?: { path: string }[]
  }
  if (!result.ok) throw new Error(result.error ?? "Upload failed")
  if (preserveRelativePaths && result.batchDir) {
    // Folder upload: hand back the batch directory (plus the top-level
    // folder the browser prefixed, when there is exactly one).
    const first = files[0] as File & { webkitRelativePath?: string }
    const top = first?.webkitRelativePath?.split("/")[0]
    const separator = result.batchDir.includes("\\") ? "\\" : "/"
    return [top ? `${result.batchDir}${separator}${top}` : result.batchDir]
  }
  return (result.files ?? []).map((f) => f.path)
}

async function openDialog(options: OpenDialogOptions): Promise<string | string[] | null> {
  if (options.directory) {
    const picked = await requestWebDialog({ kind: "directory", options })
    return picked
  }
  const uploaded = await pickAndUploadFiles(options)
  if (!uploaded) return null
  return options.multiple ? uploaded : (uploaded[0] ?? null)
}

async function saveDialog(options: { defaultPath?: string }): Promise<string | null> {
  const info = await rpc<{ dataDir: string; pathSeparator: string }>("web_runtime_info")
  const name = (options.defaultPath ?? "export").split(/[\\/]/).pop() || "export"
  const sep = info.pathSeparator || "/"
  const stamp = Date.now().toString(36)
  return `${info.dataDir}${sep}downloads${sep}${stamp}${sep}${name}`
}

async function messageDialog(text: string, options?: { title?: string }): Promise<void> {
  await requestWebDialog({ kind: "message", text, title: options?.title })
}

// ── backend ─────────────────────────────────────────────────────────────────

export const webBackend: Backend = {
  kind: "web",
  invoke: rpc,
  listen,
  fileSrc,
  getFetch: () => Promise.resolve(proxiedFetch),
  async loadStore(name: string): Promise<KeyValueStore> {
    let store = storeCache.get(name)
    if (!store) {
      store = createStore()
      storeCache.set(name, store)
    }
    return store
  },
  dialog: {
    open: openDialog,
    save: saveDialog,
    message: messageDialog,
  },
  async openUrl(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer")
  },
  async openPath(): Promise<void> {
    throw new Error("Opening server paths is not available from the browser")
  },
  async deliverFile(path: string): Promise<void> {
    const anchor = document.createElement("a")
    anchor.href = downloadUrl(path)
    anchor.download = path.split(/[\\/]/).pop() ?? "download"
    anchor.style.display = "none"
    document.body.appendChild(anchor)
    anchor.click()
    setTimeout(() => anchor.remove(), 0)
  },
  autostart: {
    supported: false,
    enable: async () => undefined,
    disable: async () => undefined,
    isEnabled: async () => false,
  },
}
