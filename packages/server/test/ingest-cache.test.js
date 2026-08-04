// Tests for the server-side ingest cache (port of src/lib/ingest-cache.test.ts
// for issue #14's server-driven ingest).
//
// The client suite mocked @/commands/fs in memory; on the server the cache
// talks to node:fs, so the same behavioral assertions run against real temp
// project dirs: hash+existence hit, stale-on-content-change,
// missing-file-stale, fail-safe null when the existence check itself fails.
// Pure fs logic — no DB, so no LLM_WIKI_DATA_DIR setup is needed.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  checkIngestCache,
  saveIngestCache,
  removeFromIngestCache,
  moveIngestCacheEntry,
} from "../src/ingest/cache.js"

// Known SHA-256 of "hello" (UTF-8) — computed independently of the ported
// code, so it pins that node:crypto produces the same hex digest as the
// client's TextEncoder + crypto.subtle.digest("SHA-256", ...).
const SHA256_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

let project
const cleanups = []

function makeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), "llmwiki-cache-test-"))
  cleanups.push(dir)
  return dir
}

function readCacheFile(proj) {
  return JSON.parse(readFileSync(path.join(proj, ".llm-wiki", "ingest-cache.json"), "utf8"))
}

beforeEach(() => {
  project = makeProject()
})

afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop(), { recursive: true, force: true })
})

describe("ingest-cache — checkIngestCache", () => {
  it("returns null when no entry exists", async () => {
    mkdirSync(path.join(project, ".llm-wiki"), { recursive: true })
    writeFileSync(
      path.join(project, ".llm-wiki", "ingest-cache.json"),
      JSON.stringify({ entries: {} }),
    )
    const result = await checkIngestCache(project, "foo.pdf", "content")
    expect(result).toBeNull()
  })

  it("returns null when the cache file itself is missing (fresh project)", async () => {
    const result = await checkIngestCache(project, "foo.pdf", "content")
    expect(result).toBeNull()
  })

  it("returns cached filesWritten when hash matches AND all files exist", async () => {
    await saveIngestCache(project, "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])
    // Both previously-written files are still on disk.
    for (const rel of ["wiki/sources/foo.md", "wiki/entities/bar.md"]) {
      mkdirSync(path.join(project, path.dirname(rel)), { recursive: true })
      writeFileSync(path.join(project, rel), "page\n")
    }

    const result = await checkIngestCache(project, "foo.pdf", "hello")
    expect(result).toEqual(["wiki/sources/foo.md", "wiki/entities/bar.md"])
  })

  it("returns null when hash matches but a cached file no longer exists on disk", async () => {
    await saveIngestCache(project, "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])
    // wiki/entities/bar.md has been deleted since the cache was written.
    mkdirSync(path.join(project, "wiki/sources"), { recursive: true })
    writeFileSync(path.join(project, "wiki/sources/foo.md"), "page\n")

    const result = await checkIngestCache(project, "foo.pdf", "hello")
    expect(result).toBeNull()
  })

  it("returns null when the content hash no longer matches (cache stale on content change)", async () => {
    await saveIngestCache(project, "foo.pdf", "hello", ["wiki/sources/foo.md"])
    mkdirSync(path.join(project, "wiki/sources"), { recursive: true })
    writeFileSync(path.join(project, "wiki/sources/foo.md"), "page\n")

    const result = await checkIngestCache(project, "foo.pdf", "different content")
    expect(result).toBeNull()
  })

  it("returns null if the existence check itself throws (safer to re-ingest than to trust)", async () => {
    // A NUL byte in the recorded path makes node:fs stat reject with a
    // validation error (not ENOENT) — the ported fail-safe must treat that
    // as "cannot trust the cache" and return null, exactly like the client
    // did when fileExists rejected.
    await saveIngestCache(project, "foo.pdf", "hello", ["wiki/sources/bad\0name.md"])

    const result = await checkIngestCache(project, "foo.pdf", "hello")
    expect(result).toBeNull()
  })
})

describe("ingest-cache — persisted JSON shape", () => {
  it("saves .llm-wiki/ingest-cache.json keyed by source name with hash/timestamp/filesWritten", async () => {
    await saveIngestCache(project, "foo.pdf", "hello", ["wiki/sources/foo.md"])

    const cache = readCacheFile(project)
    expect(Object.keys(cache)).toEqual(["entries"])
    const entry = cache.entries["foo.pdf"]
    expect(entry.hash).toBe(SHA256_HELLO)
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof entry.timestamp).toBe("number")
    expect(entry.filesWritten).toEqual(["wiki/sources/foo.md"])
  })

  it("hits against a cache file written with an externally computed sha256 (client compatibility)", async () => {
    // Pre-seed the cache exactly the way the browser client would write it:
    // hash = SHA-256 over the UTF-8 bytes of the content, lowercase hex.
    mkdirSync(path.join(project, ".llm-wiki"), { recursive: true })
    writeFileSync(
      path.join(project, ".llm-wiki", "ingest-cache.json"),
      JSON.stringify({
        entries: {
          "foo.pdf": {
            hash: SHA256_HELLO,
            timestamp: 1_000_000_000_000,
            filesWritten: ["wiki/sources/foo.md"],
          },
        },
      }),
    )
    mkdirSync(path.join(project, "wiki/sources"), { recursive: true })
    writeFileSync(path.join(project, "wiki/sources/foo.md"), "page\n")

    const result = await checkIngestCache(project, "foo.pdf", "hello")
    expect(result).toEqual(["wiki/sources/foo.md"])
  })

  it("keeps absolute filesWritten paths as-is instead of joining them onto the project", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "llmwiki-cache-abs-"))
    cleanups.push(outside)
    const absFile = path.join(outside, "absolute.md")
    writeFileSync(absFile, "page\n")

    await saveIngestCache(project, "foo.pdf", "hello", [absFile])
    const result = await checkIngestCache(project, "foo.pdf", "hello")
    expect(result).toEqual([absFile])
  })
})

describe("ingest-cache — entry removal and moves", () => {
  it("removeFromIngestCache drops the entry (next check misses)", async () => {
    await saveIngestCache(project, "foo.pdf", "hello", ["wiki/sources/foo.md"])
    mkdirSync(path.join(project, "wiki/sources"), { recursive: true })
    writeFileSync(path.join(project, "wiki/sources/foo.md"), "page\n")

    await removeFromIngestCache(project, "foo.pdf")
    expect(readCacheFile(project).entries["foo.pdf"]).toBeUndefined()
    expect(await checkIngestCache(project, "foo.pdf", "hello")).toBeNull()
  })

  it("moveIngestCacheEntry renames the key and rewrites moved filesWritten", async () => {
    await saveIngestCache(project, "project-a/config.yaml", "hello", [
      "wiki/sources/old.md",
      "wiki/entities/kept.md",
    ])

    await moveIngestCacheEntry(
      project,
      "project-a/config.yaml",
      "archive/config.yaml",
      new Map([["wiki/sources/old.md", "wiki/sources/new.md"]]),
    )

    const entries = readCacheFile(project).entries
    expect(entries["project-a/config.yaml"]).toBeUndefined()
    expect(entries["archive/config.yaml"].filesWritten).toEqual([
      "wiki/sources/new.md",
      "wiki/entities/kept.md",
    ])
    expect(entries["archive/config.yaml"].hash).toBe(SHA256_HELLO)
  })

  it("moveIngestCacheEntry is a no-op for identical identities", async () => {
    await saveIngestCache(project, "same.yaml", "hello", ["wiki/sources/same.md"])
    await moveIngestCacheEntry(project, "same.yaml", "same.yaml")
    const entries = readCacheFile(project).entries
    expect(entries["same.yaml"].filesWritten).toEqual(["wiki/sources/same.md"])
  })
})
