// Worker task registry (Phase 2.4).
//
// Named task handlers that run inside worker threads. Each handler receives the
// task args (structured-cloned from the main thread) and returns a
// JSON-serializable result. CPU-heavy work (binary parsing, embedding, graph
// rebuild) lives here so the main thread stays responsive for HTTP/SSE/SQLite.
//
// Handlers must be pure-ish: no SQLite writes (the main thread owns the DB per
// architecture.md §4.4) — they compute and return data for the main thread to
// persist.

import { preprocessFile } from "../commands/preprocess.js"

export const workerTasks = {
  /**
   * Preprocess a source document into text. Reuses the existing preprocess
   * command (PDF/Office/EPUB/etc.) but runs off the main thread.
   * args: { filePath }
   * returns: { text, ... }
   */
  async preprocess(args) {
    const result = await preprocessFile({ path: args.filePath })
    return result
  },

  /**
   * Echo task — verifies the pool round-trips args/results and isolates worker
   * crashes. Used by tests and diagnostics.
   * args: { value }
   * returns: { value, pid, threadId }
   */
  async echo(args) {
    const { threadId } = await import("node:worker_threads")
    return { value: args.value, pid: process.pid, threadId }
  },

  /**
   * Deliberately throw — used to verify the pool surfaces worker errors and
   * recycles the worker.
   */
  async fail(args) {
    throw new Error(args?.message || "intentional worker failure")
  },
}
