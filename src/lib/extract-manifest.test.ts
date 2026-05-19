import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  loadExtractManifest,
  saveExtractManifest,
  extractManifestPath,
} from "./extract-manifest"
import type { SavedImage } from "./extract-source-images"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  fileExists: vi.fn(),
}))

import { readFile, writeFileAtomic, fileExists } from "@/commands/fs"

const mockReadFile = vi.mocked(readFile)
const mockWriteFileAtomic = vi.mocked(writeFileAtomic)
const mockFileExists = vi.mocked(fileExists)

const SOURCE = "same bytes"
const HASH =
  "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3" // sha256("123")

const IMAGE: SavedImage = {
  index: 1,
  mimeType: "image/png",
  page: 5,
  width: 200,
  height: 100,
  relPath: "media/book/img-1.png",
  absPath: "/proj/wiki/media/book/img-1.png",
  sha256: "abc",
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("extract-manifest", () => {
  it("returns null when manifest file is missing", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"))
    expect(await loadExtractManifest("/proj", "book.pdf", SOURCE)).toBeNull()
  })

  it("returns images when hash matches and files exist", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        contentHash: HASH,
        images: [IMAGE],
        updatedAt: 1,
      }),
    )
    mockFileExists.mockResolvedValue(true)
    // "123" → known hash; use matching content
    const content = "123"
    const result = await loadExtractManifest("/proj", "book.pdf", content)
    expect(result).toEqual([IMAGE])
  })

  it("returns null when a listed image file is missing", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        contentHash: HASH,
        images: [IMAGE],
        updatedAt: 1,
      }),
    )
    mockFileExists.mockResolvedValue(false)
    expect(await loadExtractManifest("/proj", "book.pdf", "123")).toBeNull()
  })

  it("saveExtractManifest writes under .llm-wiki with content hash", async () => {
    await saveExtractManifest("/proj", "book.pdf", "123", [IMAGE])
    expect(mockWriteFileAtomic).toHaveBeenCalledWith(
      extractManifestPath("/proj", "book.pdf"),
      expect.stringContaining('"contentHash"'),
    )
  })
})
