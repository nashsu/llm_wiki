// SSE sync layer — wires the server event stream to the Zustand stores.
//
// The server broadcasts every domain event over GET /api/v2/events as a JSON
// envelope `{ event, payload }` (see packages/server/src/events/bus.js). This
// module opens one connection via `connectEvents` and dispatches each event to
// the store(s) that own the affected state, so the UI stays live without
// polling. It is server→client only; client actions still go through the REST
// API.
//
// Reconnection: the stream is fire-and-forget (the server buffers nothing), so
// on every reconnect we re-check /api/v2/health. If the server version changed
// while we were away, in-flight state may be stale in ways individual events
// can't describe, so we trigger a full refresh instead of trusting the delta.

import { connectEvents, type ServerEvent } from "@/api/events"
import { request } from "@/api/client"
import { getSettings } from "@/api/settings"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"

interface HealthResponse {
  ok: boolean
  version: string
}

let disconnect: (() => void) | null = null
let lastVersion: string | null = null
let started = false

/** Narrow an unknown payload to a plain record for safe field access. */
function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Refresh the current project's file tree + graph caches (dataVersion). */
function refreshWiki(): void {
  const project = useWikiStore.getState().project
  if (project?.path) {
    void refreshProjectFileTree(project.path, { bumpDataVersion: true })
  } else {
    useWikiStore.getState().bumpDataVersion()
  }
}

function handleFileEvent(): void {
  refreshWiki()
}

function handleIngest(evt: ServerEvent): void {
  const store = useFileSyncStore.getState()
  const p = asRecord(evt.payload)
  if (evt.event === "ingest:progress") {
    store.setRunning(true)
    store.setLastError(null)
  } else if (evt.event === "ingest:complete") {
    store.setRunning(false)
    store.setLastError(null)
    refreshWiki()
  } else if (evt.event === "ingest:error") {
    store.setRunning(false)
    store.setLastError(str(p.error) ?? str(p.message) ?? "Ingest failed")
  }
}

function handleChat(evt: ServerEvent): void {
  const store = useChatStore.getState()
  const p = asRecord(evt.payload)
  if (evt.event === "chat:delta") {
    if (!store.isStreaming) store.setStreaming(true)
    const token = str(p.token) ?? str(p.delta) ?? str(p.content) ?? ""
    if (token) store.appendStreamToken(token)
  } else if (evt.event === "chat:done") {
    const content = str(p.content) ?? store.streamingContent
    store.finalizeStream(content)
  }
}

function handleSettingsChanged(): void {
  // Warm the settings cache; consumers re-read on next access. Errors are
  // non-fatal — the next reconnect retries.
  void getSettings().catch(() => {})
}

function dispatch(evt: ServerEvent): void {
  switch (evt.event) {
    case "file:created":
    case "file:modified":
    case "file:deleted":
      handleFileEvent()
      break
    case "ingest:progress":
    case "ingest:complete":
    case "ingest:error":
      handleIngest(evt)
      break
    case "chat:delta":
    case "chat:done":
      handleChat(evt)
      break
    case "graph:updated":
      // Graph caches key on dataVersion; bumping invalidates + recomputes.
      useWikiStore.getState().bumpDataVersion()
      break
    case "settings:changed":
      handleSettingsChanged()
      break
    default:
      break
  }
}

/**
 * Reconcile against the server on every (re)connect. The first open just
 * records the version; each subsequent open compares it and, if the server
 * changed while we were away, triggers a full refresh.
 */
async function checkVersionOnReconnect(): Promise<void> {
  try {
    const health = await request<HealthResponse>("/api/v2/health")
    if (lastVersion === null) {
      lastVersion = health.version
      return
    }
    if (health.version !== lastVersion) {
      lastVersion = health.version
      refreshWiki()
      void getSettings().catch(() => {})
    }
  } catch {
    /* health check is best-effort */
  }
}

/** Open the SSE stream and start dispatching events to the stores. Idempotent. */
export function startSseSync(): void {
  if (started || disconnect) return
  started = true

  // Check that the v2 server is reachable before opening an EventSource.
  // On legacy-server-only deployments (e.g. the browser test gates) the v2
  // health endpoint won't exist — opening an EventSource to a 404/HTML page
  // produces a console error and a wasted connection.
  void request<HealthResponse>("/api/v2/health")
    .then((health) => {
      if (!started) return
      lastVersion = health.version
      disconnect = connectEvents(dispatch, {
        onOpen: () => {
          void checkVersionOnReconnect()
        },
      })
    })
    .catch(() => {
      // No v2 server available — SSE sync is silently skipped.
      started = false
    })
}

/** Close the SSE stream and stop all dispatching. */
export function stopSseSync(): void {
  started = false
  if (disconnect) {
    disconnect()
    disconnect = null
  }
}
