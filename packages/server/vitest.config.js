import { defineConfig } from "vitest/config"

// Vitest config for the v2 server integration tests (Phase 2.7).
// Runs only the server's own *.test.js files; isolated from the root frontend
// suite. Each test file sets LLM_WIKI_DATA_DIR to a temp dir before importing
// the app so tests never touch real user data.
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    // Run serially: tests share the singleton DB + worker pool, and parallel
    // files would race on ports/data dirs.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
