// Server-Sent Events (SSE) event bus.
//
// The browser client's `listen(name, cb)` shim opens a single shared
// EventSource on GET /api/events. Every event is broadcast as a default
// `message` carrying a JSON envelope { event, payload }; the client-side
// shim demultiplexes by `event` name. We use the default message type
// (rather than named SSE events) so arbitrary Tauri event names such as
// "file-sync://changed" need no escaping.
//
// This is the LEGACY transport (raw node:http, used by index.js and the web
// shim). The v2 Express server uses events/sse.js + events/bus.js instead. To
// keep both client generations seeing the same events, emit() also republishes
// onto the internal eventBus (events/bus.js), which the v2 SSE manager forwards
// to its clients. One set of producers, two transports.

import { eventBus } from "./events/bus.js"

/** @type {Set<import("node:http").ServerResponse>} */
const clients = new Set()

/** Register an SSE client response. Keeps the socket open until it closes. */
export function addSseClient(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  })
  // Send an initial comment so proxies flush headers immediately.
  res.write(": connected\n\n")
  clients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n") } catch { /* socket gone */ }
  }, 25000)
  res.on("close", () => {
    clearInterval(heartbeat)
    clients.delete(res)
  })
}

/**
 * Broadcast a named event with a JSON-serializable payload to all clients.
 * Mirrors Tauri's `app.emit(event, payload)` semantics used across the app.
 * Also republishes onto the internal eventBus so v2 SSE clients (events/sse.js)
 * receive the same event.
 */
export function emit(event, payload = null) {
  const data = `data: ${JSON.stringify({ event, payload })}\n\n`
  for (const res of clients) {
    try { res.write(data) } catch { clients.delete(res) }
  }
  // Bridge to the v2 internal bus. The legacy `event` name becomes the bus
  // `type`; projectId is not tracked here so it stays null.
  try {
    eventBus.publish(event, { projectId: null, payload: payload ?? {} })
  } catch { /* bus not ready; legacy clients still got the event */ }
}

export function clientCount() {
  return clients.size
}
