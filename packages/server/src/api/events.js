// Events API router (Phase 2.3.11)
// Global SSE stream. The client opens one EventSource on GET /api/v2/events and
// receives every broadcast event as a default `message` carrying a JSON envelope
// { event, payload }. Fire-and-forget: the server does not buffer events; on
// reconnect the client checks /api/v2/health for a version change to decide
// whether a full refresh is needed (smart reconnect, decision #13). The
// heartbeat (": ping" every 25s) keeps connections alive through proxies.
//
// Reuses the shared events.js bus so v2 SSE clients receive the same broadcasts
// the legacy /api/events stream does (one bus, both transports).

import { Router } from "express"
import { addSseClient, clientCount } from "../events.js"

const router = Router()

// GET /api/v2/events — SSE global stream
router.get("/", (req, res) => {
  // Express's res extends http.ServerResponse, so addSseClient (which uses
  // writeHead/write) works unchanged. It registers the client + heartbeat and
  // cleans up on close.
  addSseClient(res)
})

// GET /api/v2/events/count — number of connected SSE clients (diagnostic)
router.get("/count", (req, res) => {
  res.json({ clients: clientCount() })
})

export default router
