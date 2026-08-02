// Worker thread pool (Phase 2.1.7).
//
// Manages a fixed-size pool of worker threads (os.cpus().length - 1 by default).
// Tasks are dispatched to idle workers; when all are busy, tasks queue until a
// worker frees up. A worker that crashes is respawned in its own slot (the pool
// never grows). The main thread correlates responses by message id.
//
// All SQLite writes stay on the main thread (V1_CHARTERED_ARCHITECTURE.md §4.4); workers only
// compute and return data.

import { Worker } from "node:worker_threads"
import { cpus } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKER_SCRIPT = path.join(__dirname, "worker.js")

class WorkerPool {
  constructor(size = Math.max(1, cpus().length - 1)) {
    this.size = size
    this.slots = new Array(size).fill(null) // index -> Worker
    this.idle = new Set()                   // idle Worker instances
    this.queue = []                         // pending { id, task, args }
    this.nextId = 1
    this.pending = new Map()                // id -> { resolve, reject }
    this.terminating = false

    for (let i = 0; i < size; i++) {
      this.slots[i] = this.spawnWorker(i)
    }
  }

  /** Spawn a worker bound to a fixed slot index; returns the Worker. */
  spawnWorker(index) {
    const worker = new Worker(WORKER_SCRIPT)
    worker.__slot = index

    worker.on("message", (msg) => {
      const { id, result, error } = msg
      const pending = this.pending.get(id)
      if (pending) {
        this.pending.delete(id)
        if (error) pending.reject(new Error(error.message))
        else pending.resolve(result)
      }
      // Return to idle and drain the queue.
      this.idle.add(worker)
      this.processQueue()
    })

    worker.on("error", (err) => {
      console.error(`[worker-pool] worker ${index} error:`, err.message)
      this.recycle(index)
    })

    worker.on("exit", (code) => {
      if (this.terminating) return
      if (code !== 0) {
        console.error(`[worker-pool] worker ${index} exited with code ${code}; respawning`)
        this.recycle(index)
      }
    })

    this.idle.add(worker)
    return worker
  }

  /** Replace a dead worker in its slot, failing any in-flight tasks on it. */
  recycle(index) {
    const dead = this.slots[index]
    if (dead) {
      this.idle.delete(dead)
      try { dead.removeAllListeners() } catch { /* noop */ }
    }
    if (!this.terminating) {
      this.slots[index] = this.spawnWorker(index)
    }
  }

  processQueue() {
    while (this.queue.length > 0 && this.idle.size > 0) {
      const worker = this.idle.values().next().value
      this.idle.delete(worker)
      const { id, task, args } = this.queue.shift()
      worker.postMessage({ id, task, args })
    }
  }

  /**
   * Run a named task on the pool.
   * @param {string} task task name from workers/tasks.js
   * @param {object} args structured-cloneable arguments
   * @returns {Promise<any>} the task result
   */
  run(task, args = {}) {
    if (this.terminating) return Promise.reject(new Error("Worker pool is terminating"))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.queue.push({ id, task, args })
      this.processQueue()
    })
  }

  stats() {
    return {
      size: this.size,
      idle: this.idle.size,
      busy: this.size - this.idle.size,
      queued: this.queue.length,
      pending: this.pending.size,
    }
  }

  async terminate() {
    this.terminating = true
    // Fail anything still queued/pending so callers don't hang.
    for (const { reject } of this.pending.values()) {
      reject(new Error("Worker pool terminated"))
    }
    this.pending.clear()
    this.queue = []
    const workers = this.slots.filter(Boolean)
    this.slots = new Array(this.size).fill(null)
    this.idle.clear()
    await Promise.all(workers.map((w) => w.terminate()))
  }
}

// Singleton pool (lazy).
let pool = null

export function getWorkerPool() {
  if (!pool) pool = new WorkerPool()
  return pool
}

/** Convenience: run a named task on the shared pool. */
export function runInWorker(task, args = {}) {
  return getWorkerPool().run(task, args)
}

export function workerPoolStats() {
  return pool ? pool.stats() : { size: 0, idle: 0, busy: 0, queued: 0, pending: 0 }
}

export async function terminateWorkerPool() {
  if (pool) {
    await pool.terminate()
    pool = null
  }
}
