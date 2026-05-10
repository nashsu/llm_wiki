import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock fs so the tests don't touch real disk.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileExists: vi.fn(),
}))

import { checkIngestCache, INGEST_PIPELINE_VERSION, saveIngestCache } from "./ingest-cache"
import { readFile, writeFile, fileExists } from "@/commands/fs"

const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockFileExists = vi.mocked(fileExists)

beforeEach(() => {
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockFileExists.mockReset()
  mockWriteFile.mockResolvedValue(undefined as unknown as void)
})

describe("ingest-cache — checkIngestCache", () => {
  it("returns null when no entry exists", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ entries: {} }))
    const result = await checkIngestCache("/project", "foo.pdf", "content")
    expect(result).toBeNull()
  })

  it("returns cached filesWritten when hash matches AND all files exist", async () => {
    // Pre-seed cache with a hash matching "hello".
    // We compute the expected hash by running saveIngestCache first in
    // a controlled round-trip, then feeding the same JSON back in.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])

    mockFileExists.mockResolvedValue(true)
    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toEqual(["wiki/sources/foo.md", "wiki/entities/bar.md"])
  })

  it("returns null when hash matches but a cached file no longer exists on disk", async () => {
    // Prime cache, then simulate user deleting one of the written files.
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", [
      "wiki/sources/foo.md",
      "wiki/entities/bar.md",
    ])

    // wiki/entities/bar.md has been deleted since the cache was written.
    mockFileExists.mockImplementation(async (p: string) => {
      return !p.includes("entities/bar.md")
    })

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })

  it("returns null when the content hash no longer matches (cache stale on content change)", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"])

    const result = await checkIngestCache("/project", "foo.pdf", "different content")
    expect(result).toBeNull()
  })

  it("returns null when the cache was produced by an older ingest pipeline", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"], "quality-v1")

    mockFileExists.mockResolvedValue(true)

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })

  it("persists the current ingest pipeline version", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })

    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"])

    expect(JSON.parse(persisted).entries["foo.pdf"].pipelineVersion).toBe(INGEST_PIPELINE_VERSION)
  })

  it("returns null if fileExists itself throws (safer to re-ingest than to trust)", async () => {
    let persisted = ""
    mockReadFile.mockImplementation(async () => persisted || JSON.stringify({ entries: {} }))
    mockWriteFile.mockImplementation(async (_p: string, c: string) => {
      persisted = c
    })
    await saveIngestCache("/project", "foo.pdf", "hello", ["wiki/sources/foo.md"])

    mockFileExists.mockRejectedValue(new Error("stat failed"))

    const result = await checkIngestCache("/project", "foo.pdf", "hello")
    expect(result).toBeNull()
  })
})
