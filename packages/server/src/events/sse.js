// SSE connection manager (Phase 2.1.9).
//
// Manages Server-Sent Events connections for real-time updates. Subscribes to
// the internal event bus and forwards every published event to all connected
// clients. Sends a heartbeat every 25 seconds to keep connections alive through
// proxies and load balancers.
//
// Protocol:
//   - Each client connects via GET /api/v2/events
//   - Server sends "event: message\ndata: {json}\n\n" for each event
//   - Heartbeat: "event: ping\ndata: {}\n\n" every 25s
//   - Client reconnects automatically on disconnect (browser EventSource)

import { eventBus } from "./bus.js"

class SSEManager {
  constructor() {
    this.clients = new Set()
    this.heartbeatInterval = null
    this.unsubscribe = null
  }

  /**
   * Add an SSE client (Express response object).
   * Sets up headers, heartbeat, and cleanup on close.
   * @param {import("express").Response} res
   */
  addClient(res) {
    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    })

    // Send initial connection event
    res.write("event: connected\ndata: {}\n\n")

    this.clients.add(res)

    // Start heartbeat if this is the first client
    if (this.clients.size === 1) {
      this.startHeartbeat()
      this.subscribeToBus()
    }

    // Cleanup on close
    res.on("close", () => {
      this.removeClient(res)
    })
  }

  /**
   * Remove an SSE client and stop heartbeat if no clients remain.
   * @param {import("express").Response} res
   */
  removeClient(res) {
    this.clients.delete(res)
    if (this.clients.size === 0) {
      this.stopHeartbeat()
      this.unsubscribeFromBus()
    }
  }

  /**
   * Broadcast an event to all connected clients.
   * @param {object} envelope - Event envelope from the bus
   */
  broadcast(envelope) {
    const data = JSON.stringify(envelope)
    for (const client of this.clients) {
      try {
        client.write(`event: message\ndata: ${data}\n\n`)
      } catch (err) {
        // Client disconnected; remove it
        this.removeClient(client)
      }
    }
  }

  /**
   * Send a heartbeat ping to all clients.
   */
  heartbeat() {
    for (const client of this.clients) {
      try {
        client.write("event: ping\ndata: {}\n\n")
      } catch (err) {
        this.removeClient(client)
      }
    }
  }

  /**
   * Start the heartbeat interval (25 seconds).
   */
  startHeartbeat() {
    if (this.heartbeatInterval) return
    this.heartbeatInterval = setInterval(() => {
      this.heartbeat()
    }, 25000)
  }

  /**
   * Stop the heartbeat interval.
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  /**
   * Subscribe to the internal event bus.
   */
  subscribeToBus() {
    if (this.unsubscribe) return
    this.unsubscribe = eventBus.subscribe((envelope) => {
      this.broadcast(envelope)
    })
  }

  /**
   * Unsubscribe from the internal event bus.
   */
  unsubscribeFromBus() {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  /**
   * Get the number of connected clients.
   * @returns {number}
   */
  getClientCount() {
    return this.clients.size
  }

  /**
   * Gracefully shut down: close all connections and stop heartbeat.
   */
  shutdown() {
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.clients.clear()
    this.stopHeartbeat()
    this.unsubscribeFromBus()
  }
}

// Singleton SSE manager
export const sseManager = new SSEManager()
