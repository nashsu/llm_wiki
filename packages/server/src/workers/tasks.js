// Worker task registry (Phase 2.4).
//
// Named task handlers that run inside worker threads. Each handler receives the
// task args (structured-cloned from the main thread) and returns a
// JSON-serializable result. CPU-heavy work (binary parsing, embedding, graph
// rebuild) lives here so the main thread stays responsive for HTTP/SSE/SQLite.
//
// Handlers must be pure-ish: no SQLite writes (the main thread owns the DB per
// V1_CHARTERED_ARCHITECTURE.md §4.4) — they compute and return data for the main thread to
// persist.

import { preprocessFile } from "../commands/preprocess.js"
import { extractImageCommands } from "../commands/extractImages.js"

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
   * Extract embedded images from a PDF / Office source file off the main
   * thread. Wraps the extractImageCommands handlers (same wire shapes the
   * HTTP command surface uses; Rust camelCase parity — index/relPath/absPath).
   * args: { command, args } — a single generic envelope (chosen over
   * per-command tasks so the registry grows one entry, not four):
   *   command: one of "extract_and_save_pdf_images_cmd",
   *            "extract_and_save_office_images_cmd",
   *            "extract_pdf_images_cmd", "extract_office_images_cmd"
   *   args:    the handler's argument, e.g. { sourcePath, destDir, relTo }
   *            for the extract_and_save_* pair, or { path } for the
   *            extract-only pair. Both are plain strings → structured-
   *            cloneable in both directions.
   * returns: SavedImage[] ({index,mimeType,page,width,height,relPath,
   *          absPath,sha256}) for extract_and_save_*, or
   *          {index,mimeType,page,width,height,dataBase64,sha256}[] records
   *          for the extract-only commands.
   */
  async extractImages(taskArgs) {
    const { command, args } = taskArgs ?? {}
    if (!Object.hasOwn(extractImageCommands, command)) {
      throw new Error(`Unknown image extraction command: ${command}`)
    }
    return extractImageCommands[command](args ?? {})
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
