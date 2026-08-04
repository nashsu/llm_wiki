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
import { listProjects } from "@/api/projects"
import { getSettings } from "@/api/settings"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { useServerIngestStore } from "@/stores/server-ingest-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { normalizePath } from "@/lib/path-utils"

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

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
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

// ── current-project identity (UUID → numeric projects-row id) ─────────────
//
// Ingest events carry the server's numeric projects-row id, but the client
// only knows WikiProject.id (a UUID). Resolve the mapping once per project
// via GET /api/v2/projects and cache it at module level; events that cannot
// be attributed to the current project are dropped rather than applied to
// the wrong project's stores.

let resolvedForUuid: string | null = null
let resolvedNumericId: number | null = null
let resolveInFlight: Promise<number | null> | null = null

function invalidateProjectResolution(): void {
  resolvedForUuid = null
  resolvedNumericId = null
}

async function resolveCurrentNumericProjectId(): Promise<number | null> {
  const project = useWikiStore.getState().project
  if (!project) return null
  if (resolvedForUuid === project.id) return resolvedNumericId
  if (resolveInFlight) return resolveInFlight
  resolveInFlight = (async () => {
    try {
      const { projects } = await listProjects()
      const current = useWikiStore.getState().project
      if (!current) return null
      const match = projects.find((p) => p.uuid === current.id)
        ?? projects.find((p) => normalizePath(p.path) === normalizePath(current.path))
      resolvedForUuid = current.id
      resolvedNumericId = match?.id ?? null
      return resolvedNumericId
    } catch {
      return null
    } finally {
      resolveInFlight = null
    }
  })()
  return resolveInFlight
}

async function handleIngest(evt: ServerEvent): Promise<void> {
  const p = asRecord(evt.payload)
  const eventProjectId = num(p.projectId) ?? null
  const currentNumericId = await resolveCurrentNumericProjectId()
  // Project filter: events carry the numeric row id; ignore events for other
  // projects, and drop unattributable events instead of guessing.
  if (currentNumericId === null || (eventProjectId !== null && eventProjectId !== currentNumericId)) {
    return
  }

  const uuid = useWikiStore.getState().project?.id ?? null
  const fileSync = useFileSyncStore.getState()
  const ingest = useServerIngestStore.getState()
  const taskId = num(p.taskId) ?? null

  if (evt.event === "ingest:queued") {
    if (uuid) void ingest.loadQueue(uuid)
    return
  }

  if (evt.event === "ingest:progress") {
    fileSync.setRunning(true)
    fileSync.setLastError(null)
    if (taskId !== null) {
      ingest.patchTask(taskId, {
        status: "processing",
        ...(num(p.progress) !== undefined ? { progress: num(p.progress) } : {}),
      })
    }
    ingest.setRunning(true)
    return
  }

  if (evt.event === "ingest:complete") {
    fileSync.setRunning(false)
    fileSync.setLastError(null)
    refreshWiki()
    if (taskId !== null) ingest.patchTask(taskId, { status: "completed", progress: 100 })
    // Terminal frame: refresh the authoritative list (completed rows stay).
    if (uuid) void useServerIngestStore.getState().loadQueue(uuid)
    return
  }

  if (evt.event === "ingest:error") {
    const errorText = str(p.error) ?? str(p.message) ?? "Ingest failed"
    fileSync.setRunning(false)
    fileSync.setLastError(errorText)
    ingest.setLastError(errorText)
    if (taskId !== null) {
      ingest.patchTask(taskId, {
        // The server keeps retryable failures as "pending" (attempt < max);
        // only the final failure flips the row to "failed".
        status: str(p.status) === "failed" ? "failed" : "pending",
        error: errorText,
      })
    }
    if (uuid) void useServerIngestStore.getState().loadQueue(uuid)
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

/** Legacy Tauri-style event names → v2 names (events.js bridge). */
const LEGACY_EVENT_MAP: Record<string, string> = {
  "project://files-changed": "file:modified",
  "file-sync://changed": "file:modified",
  "file-sync://ingest-progress": "ingest:progress",
  "file-sync://ingest-complete": "ingest:complete",
  "file-sync://ingest-error": "ingest:error",
  "chat://token": "chat:delta",
  "chat://done": "chat:done",
  "graph://updated": "graph:updated",
  "settings://changed": "settings:changed",
}

function dispatch(evt: ServerEvent): void {
  // Resolve legacy Tauri-style event names (emitted by the legacy events.js
  // bridge on the v2 bus) to v2 names before dispatching, so events from both
  // producer generations reach the stores.
  const name = LEGACY_EVENT_MAP[evt.event] || evt.event
  switch (name) {
    case "file:created":
    case "file:modified":
    case "file:deleted":
      handleFileEvent()
      break
    case "ingest:queued":
    case "ingest:progress":
    case "ingest:complete":
    case "ingest:error":
      void handleIngest(evt)
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
  invalidateProjectResolution()
  if (disconnect) {
    disconnect()
    disconnect = null
  }
}
