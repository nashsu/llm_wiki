import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMock = vi.hoisted(() => {
  let now = 1_000
  const files = new Map<string, { content: string; mtime: number }>()
  return {
    files,
    readFile: vi.fn(async (path: string) => {
      const file = files.get(path)
      if (!file) throw new Error(`missing ${path}`)
      return file.content
    }),
    writeFile: vi.fn(async (path: string, contents: string) => {
      files.set(path, { content: contents, mtime: ++now })
    }),
    fileExists: vi.fn(async (path: string) => files.has(path)),
    fileModifiedMs: vi.fn(async (path: string) => files.get(path)?.mtime ?? null),
    convertWithMarkitdown: vi.fn(
      async (_path: string): Promise<{
        ok: boolean
        markdown?: string | null
        error?: string | null
        timedOut: boolean
      }> => ({
        ok: true,
        markdown: "converted markdown",
        error: null,
        timedOut: false,
      }),
    ),
    deleteFile: vi.fn(async (path: string) => {
      files.delete(path)
    }),
    reset: () => {
      now = 1_000
      files.clear()
    },
    touch: (path: string, content: string, mtime: number) => {
      files.set(path, { content, mtime })
      now = Math.max(now, mtime)
    },
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: fsMock.readFile,
  writeFile: fsMock.writeFile,
  fileExists: fsMock.fileExists,
  fileModifiedMs: fsMock.fileModifiedMs,
  convertWithMarkitdown: fsMock.convertWithMarkitdown,
  deleteFile: fsMock.deleteFile,
}))

import {
  convertedMarkdownPath,
  deleteConvertedSourceCache,
  loadSourceForIngest,
  rawSourcesRelativePath,
} from "./source-conversion"

const PROJECT = "D:/project"
const RAW = "D:/project/raw/sources/folder/report.pdf"
const CONVERTED = "D:/project/.llm-wiki/converted/folder/report.pdf.md"

beforeEach(() => {
  fsMock.reset()
  vi.clearAllMocks()
})

describe("source conversion", () => {
  it("converts raw/sources files with MarkItDown and caches markdown", async () => {
    fsMock.touch(RAW, "native text", 10)

    const loaded = await loadSourceForIngest(PROJECT, RAW)

    expect(loaded).toMatchObject({
      content: "converted markdown\n",
      method: "markitdown",
      convertedPath: CONVERTED,
    })
    expect(fsMock.convertWithMarkitdown).toHaveBeenCalledWith(RAW)
    expect(fsMock.files.get(CONVERTED)?.content).toBe("converted markdown\n")
  })

  it("reuses converted cache only when it is newer than the raw source", async () => {
    fsMock.touch(RAW, "native text", 10)
    fsMock.touch(CONVERTED, "cached markdown", 20)

    const loaded = await loadSourceForIngest(PROJECT, RAW)

    expect(loaded).toMatchObject({
      content: "cached markdown",
      method: "converted-cache",
    })
    expect(fsMock.convertWithMarkitdown).not.toHaveBeenCalled()
  })

  it("regenerates stale converted cache", async () => {
    fsMock.touch(RAW, "native text", 30)
    fsMock.touch(CONVERTED, "stale markdown", 20)

    const loaded = await loadSourceForIngest(PROJECT, RAW)

    expect(loaded.content).toBe("converted markdown\n")
    expect(loaded.method).toBe("markitdown")
    expect(fsMock.convertWithMarkitdown).toHaveBeenCalledWith(RAW)
  })

  it("falls back to native readFile when MarkItDown fails", async () => {
    fsMock.touch(RAW, "native text", 10)
    fsMock.convertWithMarkitdown.mockResolvedValueOnce({
      ok: false,
      markdown: null,
      error: "missing markitdown",
      timedOut: false,
    })

    const loaded = await loadSourceForIngest(PROJECT, RAW)

    expect(loaded).toMatchObject({
      content: "native text",
      method: "native",
      error: "missing markitdown",
    })
  })

  it("does not invoke MarkItDown outside raw/sources", async () => {
    const outside = "D:/project/wiki/queries/search.md"
    fsMock.touch(outside, "query text", 10)

    const loaded = await loadSourceForIngest(PROJECT, outside)

    expect(loaded).toMatchObject({
      content: "query text",
      method: "native",
    })
    expect(fsMock.convertWithMarkitdown).not.toHaveBeenCalled()
  })

  it("rejects unsafe raw/sources relative paths", () => {
    expect(rawSourcesRelativePath(PROJECT, "D:/project/raw/sources/../x.pdf")).toBeNull()
    expect(rawSourcesRelativePath(PROJECT, "D:/project/raw/sources/.cache/x.pdf")).toBeNull()
    expect(convertedMarkdownPath(PROJECT, RAW)).toBe(CONVERTED)
  })

  it("deletes the matching converted cache", async () => {
    fsMock.touch(CONVERTED, "cached markdown", 20)

    await deleteConvertedSourceCache(PROJECT, RAW)

    expect(fsMock.deleteFile).toHaveBeenCalledWith(CONVERTED)
    expect(fsMock.files.has(CONVERTED)).toBe(false)
  })
})
