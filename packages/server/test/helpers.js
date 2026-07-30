// Test helper for v2 server integration tests (Phase 2.7).
//
// Provides an isolated temp data dir. The test file must set
// process.env.LLM_WIKI_DATA_DIR to the returned dir BEFORE importing the app,
// because the app reads its config at module load.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/** Create a fresh isolated temp data dir. */
export function makeTempDataDir() {
  return mkdtempSync(path.join(tmpdir(), "llmwiki-test-"))
}

/** Recursively remove a temp data dir. */
export function removeTempDataDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
}
