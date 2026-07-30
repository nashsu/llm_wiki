// Internal event bus (Phase 2.1.8).
//
// A process-wide EventEmitter that decouples event PRODUCERS (ingest pipeline,
// file watcher, graph indexer, agent runtime) from the SSE TRANSPORT. Producers
// call publish() with a typed event; the SSE layer subscribes and forwards to
// connected clients. This keeps business logic free of any HTTP/SSE knowledge
// and lets multiple consumers (SSE today; logging/metrics later) react to the
// same events.
//
// Event envelope (matches architecture.md §4.7):
//   { type, projectId, payload, ts }
// where `type` is one of the stable event names below.

import { EventEmitter } from "node:events"

// Stable event type names (architecture.md §4.7). Producers should use these
// constants so typos don't silently drop events.
export const EventTypes = {
  FILE_CREATED: "file:created",
  FILE_MODIFIED: "file:modified",
  FILE_DELETED: "file:deleted",
  INGEST_PROGRESS: "ingest:progress",
  INGEST_COMPLETE: "ingest:complete",
  INGEST_ERROR: "ingest:error",
  INGEST_QUEUED: "ingest:queued",
  CHAT_DELTA: "chat:delta",
  CHAT_TOOL_START: "chat:toolStart",
  CHAT_TOOL_END: "chat:toolEnd",
  CHAT_DONE: "chat:done",
  GRAPH_UPDATED: "graph:updated",
  SETTINGS_CHANGED: "settings:changed",
}

class EventBus extends EventEmitter {
  constructor() {
    super()
    // Many SSE clients + producers can attach; lift the default 10-listener cap.
    this.setMaxListeners(0)
  }

  /**
   * Publish a typed event onto the bus.
   * @param {string} type one of EventTypes
   * @param {object} [opts]
   * @param {number} [opts.projectId]
   * @param {object} [opts.payload]
   */
  publish(type, { projectId = null, payload = {} } = {}) {
    const envelope = { type, projectId, payload, ts: Date.now() }
    this.emit("event", envelope)
    this.emit(type, envelope)
    return envelope
  }

  /** Subscribe to every event (used by the SSE layer). Returns an unsubscribe fn. */
  subscribe(listener) {
    this.on("event", listener)
    return () => this.off("event", listener)
  }
}

// Singleton bus shared across the server process.
export const eventBus = new EventBus()

/** Convenience wrapper around eventBus.publish. */
export function publish(type, opts) {
  return eventBus.publish(type, opts)
}
