// Worker thread entry point (Phase 2.1.7).
//
// Each worker listens for { id, task, args } messages, runs the named task from
// the registry, and posts back { id, result } or { id, error }. The pool on the
// main thread correlates responses by id.

import { parentPort } from "node:worker_threads"
import { workerTasks } from "./tasks.js"

if (!parentPort) {
  throw new Error("worker.js must be run as a worker thread")
}

parentPort.on("message", async (msg) => {
  const { id, task, args } = msg
  try {
    const handler = workerTasks[task]
    if (!handler) {
      throw new Error(`Unknown worker task: ${task}`)
    }
    const result = await handler(args)
    parentPort.postMessage({ id, result })
  } catch (err) {
    parentPort.postMessage({
      id,
      error: {
        message: err.message,
        stack: err.stack,
      },
    })
  }
})
