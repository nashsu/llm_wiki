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
import { useChatStore, type MessageReference } from "@/stores/chat-store"
import { useFileSyncStore } from "@/stores/file-sync-store"
import { useServerIngestStore } from "@/stores/server-ingest-store"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { loadOutputLanguage } from "@/lib/project-store"
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

// File-event tree refreshs are trailing-debounced: chat/writes emits several
// file:* frames per save (one per FILE block plus the post-write image
// injection), and the tree refresh is idempotent but not free. Only THIS path
// is debounced — ingest:complete and the version-change reconnect keep their
// direct refreshWiki behavior.
const FILE_REFRESH_DEBOUNCE_MS = 400
let fileRefreshTimer: ReturnType<typeof setTimeout> | null = null

function handleFileEvent(): void {
  if (fileRefreshTimer !== null) clearTimeout(fileRefreshTimer)
  fileRefreshTimer = setTimeout(() => {
    fileRefreshTimer = null
    refreshWiki()
  }, FILE_REFRESH_DEBOUNCE_MS)
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
      // Cache only POSITIVE resolutions: a null result (projects row not
      // materialized yet) must be retried on the next event, otherwise all
      // ingest frames for this project would be silently dropped until a
      // project switch / SSE restart.
      if (match) {
        resolvedForUuid = current.id
        resolvedNumericId = match.id
      }
      return match?.id ?? null
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

/**
 * Narrow the wire `references` array of a chat:done payload (server-side
 * reference objects) into MessageReference entries. Mirrors the kind/source
 * mapping of chat-panel's backendReferenceToMessageReference so cross-tab
 * finalized messages match what the owning tab rendered.
 */
function toMessageReferences(value: unknown): MessageReference[] | undefined {
  if (!Array.isArray(value)) return undefined
  const references: MessageReference[] = []
  for (const item of value) {
    const ref = asRecord(item)
    const title = str(ref.title)
    const path = str(ref.path)
    if (!title || !path) continue
    const kind = str(ref.kind)
    const isWiki = kind === "wiki" || path.startsWith("wiki/")
    const isWeb = kind === "web" || /^https?:\/\//i.test(path)
    const isWorkspace = kind === "workspace" || path.startsWith("agent-workspace/")
    const source =
      isWorkspace ? "Workspace"
        : kind === "anytxt" ? "AnyTXT"
          : isWeb ? "Web"
            : kind === "source" ? "Source"
              : kind === "graph" ? "Graph"
                : undefined
    const snippet = str(ref.snippet)
    // Mirror chat-panel's backendReferenceToMessageReference exactly: it maps
    // knowledgeContext.relatedTo → graphRelations, so cross-tab finalized
    // messages carry the same reference metadata the owning tab rendered.
    const relatedTo = asRecord(ref.knowledgeContext).relatedTo
    const graphRelations = Array.isArray(relatedTo)
      ? relatedTo.filter((item): item is string => typeof item === "string")
      : undefined
    references.push({
      title,
      path,
      kind: isWiki ? "wiki" : isWorkspace ? "workspace" : "external",
      ...(source !== undefined ? { source } : {}),
      ...(isWeb ? { url: path } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(graphRelations !== undefined && graphRelations.length > 0 ? { graphRelations } : {}),
    })
  }
  return references.length > 0 ? references : undefined
}

/**
 * Chat taxonomy frames (chat:delta / chat:toolStart / chat:toolEnd / chat:done).
 *
 * Scoping: frames apply only when `payload.sessionId` is a conversation
 * present in the chat-store — this drops other-project and unknown frames.
 *
 * Conversation lock (the foreign-conversation leak fix): the chat store has
 * ONE global stream buffer, so once a conversation is previewing through
 * this layer, frames for any OTHER conversation are dropped — foreign deltas
 * would render live under the wrong conversation, and a foreign chat:done
 * would clear isStreaming/streamingContent mid-flight for the streaming run
 * (including an owned run this tab renders via agent-event). The lock is
 * adopted on the first applied delta and released by the streaming
 * conversation's chat:done (or stopSseSync).
 *
 * Ownership guard (the double-apply fix): chat-panel tombstones runs it
 * starts locally in the store's `ownedRunIds`. This tab already renders
 * those runs via agent-event, so their wire frames are skipped — applying
 * them again would double tokens and messages. A tab that did NOT start the
 * run applies chat:delta → appendStreamToken (live preview) and chat:done →
 * finalizeStreamForConversation (the done frame carries the full content, so
 * a tab that missed the deltas still finalizes). A chat:done with empty
 * content is the terminal dual of a CANCELLED run: streaming resets without
 * a message (parity with the owning tab's abort-like catch path). Tombstones
 * are never cleared on finalize — only on conversation delete — so they
 * survive the done-frame race on the shared SSE stream.
 */
// Which conversation currently owns the global stream preview (see above).
let streamingConversationId: string | null = null

function handleChat(evt: ServerEvent): void {
  const store = useChatStore.getState()
  const p = asRecord(evt.payload)
  const sessionId = str(p.sessionId)
  const knownConversation =
    store.conversations.some((c) => c.id === sessionId) || sessionId === store.activeConversationId
  if (!sessionId || !knownConversation) return

  const runId = str(p.runId)
  if (runId && store.ownedRunIds.includes(runId)) return

  switch (evt.event) {
    case "chat:delta": {
      // Charter key is `text`; token/delta/content are legacy fallbacks.
      const token = str(p.text) ?? str(p.token) ?? str(p.delta) ?? str(p.content) ?? ""
      if (!token) return
      // Conversation lock: only the conversation that owns the current
      // preview may append tokens. When nothing is previewing yet AND the
      // global buffer is free, adopt the frame's conversation. If the buffer
      // is busy with an owned run (this tab streams via agent-event, so
      // streamingConversationId is null while store.isStreaming is true),
      // foreign deltas are dropped instead of clobbering it.
      if (streamingConversationId === null) {
        if (store.isStreaming) return
        streamingConversationId = sessionId
      } else if (streamingConversationId !== sessionId) {
        return
      }
      if (!store.isStreaming) store.setStreaming(true)
      store.appendStreamToken(token)
      return
    }
    case "chat:done": {
      // Conversation lock: only the streaming conversation may finalize or
      // reset the global stream state. A late done for another conversation
      // is dropped wholesale — it must not clear an active preview (or an
      // owned run's buffer). With no conversation previewing, a done still
      // finalizes when the buffer is free: it carries the full content, so a
      // tab that missed every delta (e.g. reconnected mid-run) still records
      // the message.
      if (streamingConversationId !== null) {
        if (streamingConversationId !== sessionId) return
      } else if (store.isStreaming) {
        return
      }
      streamingConversationId = null
      // Charter key is `content` (the run's full accumulated text, so a tab
      // that missed deltas can finalize); fall back to the stream buffer for
      // content-less frames (parity with the pre-taxonomy handler).
      const content = str(p.content) ?? store.streamingContent
      if (content === "") {
        // Terminal dual of a CANCELLED run (the server's error site duals a
        // textless terminal chat:done): end the preview without adding a
        // message — parity with the owning tab's abort-like catch path, which
        // resets streaming and discards the buffer. Without this frame a
        // non-owning tab would stay stuck in isStreaming forever (its send
        // paths are locked while streaming).
        if (store.isStreaming) store.setStreaming(false)
        return
      }
      store.finalizeStreamForConversation(sessionId, content, toMessageReferences(p.references))
      return
    }
    case "chat:toolStart":
    case "chat:toolEnd":
      // Explicit no-op — taxonomy fidelity on the wire. Tool steps have no
      // store target today: the owning tab renders them from agent-event,
      // and cross-tab sync is tokens-only (plans/sse-taxonomy.md, "Known
      // accepted degradations").
      return
  }
}

function handleSettingsChanged(): void {
  // Warm the settings cache; consumers re-read on next access. Errors are
  // non-fatal — the next reconnect retries.
  void getSettings().catch(() => {})
  // The refetch alone leaves the Zustand mirrors of shared settings stale in
  // this tab (they hydrate at boot / on save only). Invalidate them so a
  // change made in another tab, the desktop app, or the API is reflected
  // without a reload (charter §4.7: settings:changed drives store
  // invalidation; plans/sse-taxonomy.md).
  void applySyncedSettings().catch(() => {})
}

/**
 * Re-read the settings mirrored in the Zustand stores through the app's
 * normal settings read path (plugin-store → server). A per-project output
 * language wins over the host-global key (settings-dialog write shape);
 * neither present falls back to "auto" (boot parity, App.tsx).
 */
async function applySyncedSettings(): Promise<void> {
  const projectId = useWikiStore.getState().project?.id
  const projectOverride = projectId ? await loadOutputLanguage(projectId) : null
  const lang = projectOverride ?? (await loadOutputLanguage()) ?? "auto"
  useWikiStore.getState().setOutputLanguage(lang)
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

function dispatch(raw: ServerEvent): void {
  // Resolve legacy Tauri-style event names (emitted by the legacy events.js
  // bridge on the v2 bus) to v2 names before dispatching, so events from both
  // producer generations reach the stores. Handlers receive the RESOLVED
  // envelope — their internal event-name switches must not have to know the
  // legacy aliases.
  const name = LEGACY_EVENT_MAP[raw.event] || raw.event
  const evt: ServerEvent = name === raw.event ? raw : { event: name, payload: raw.payload }
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
    case "chat:toolStart":
    case "chat:toolEnd":
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
  // Release the chat preview lock: on reconnect, frames belong to whatever
  // conversation streams first again.
  streamingConversationId = null
  // Drop a pending file-refresh debounce so it cannot fire against a stale
  // project after disconnect (e.g. project switch).
  if (fileRefreshTimer !== null) {
    clearTimeout(fileRefreshTimer)
    fileRefreshTimer = null
  }
  if (disconnect) {
    disconnect()
    disconnect = null
  }
}
