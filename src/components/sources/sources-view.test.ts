import { describe, expect, it } from "vitest"
import type { FileNode } from "@/types/wiki"
import {
  filterSourceTreeByIngestStatus,
  filterSourceTreeByQuery,
  summarizeImportOutcome,
} from "./sources-view"

const TREE: FileNode[] = [
  {
    name: "Books",
    path: "/project/raw/sources/Books",
    is_dir: true,
    children: [
      { name: "BookA.md", path: "/project/raw/sources/Books/BookA.md", is_dir: false },
      { name: "三阶段治疗模型.pdf", path: "/project/raw/sources/Books/三阶段治疗模型.pdf", is_dir: false },
    ],
  },
  { name: "notes.txt", path: "/project/raw/sources/notes.txt", is_dir: false },
]

describe("filterSourceTreeByIngestStatus", () => {
  const STATUSES = new Map<string, "ingested" | "not-ingested" | "processing">([
    ["/project/raw/sources/Books/BookA.md", "ingested"],
    ["/project/raw/sources/notes.txt", "ingested"],
    ["/project/raw/sources/Books/三阶段治疗模型.pdf", "processing"],
  ])

  it("returns every node for the 'all' mode", () => {
    expect(filterSourceTreeByIngestStatus(TREE, STATUSES, "all")).toEqual(TREE)
  })

  it("keeps ingested files and their parent folders", () => {
    const result = filterSourceTreeByIngestStatus(TREE, STATUSES, "ingested")
    expect(result.map((node) => node.name)).toEqual(["Books", "notes.txt"])
    expect(result[0].children?.map((node) => node.name)).toEqual(["BookA.md"])
  })

  it("keeps in-progress files ('processing' counts as not ingested)", () => {
    const result = filterSourceTreeByIngestStatus(TREE, STATUSES, "not-ingested")
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Books")
    expect(result[0].children?.map((node) => node.name)).toEqual(["三阶段治疗模型.pdf"])
  })

  it("drops folders whose descendants all miss the filter", () => {
    const onlyBookIngested = new Map<string, "ingested" | "not-ingested" | "processing">([
      ["/project/raw/sources/Books/BookA.md", "ingested"],
    ])
    const result = filterSourceTreeByIngestStatus(TREE, onlyBookIngested, "ingested")
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Books")
    expect(result[0].children?.map((node) => node.name)).toEqual(["BookA.md"])
  })

  it("treats a missing status as not-ingested", () => {
    const result = filterSourceTreeByIngestStatus(TREE, new Map(), "not-ingested")
    expect(result).toEqual(TREE)
    expect(result).not.toBe(TREE)
  })

  it("returns an empty tree when nothing is ingested", () => {
    expect(filterSourceTreeByIngestStatus(TREE, new Map(), "ingested")).toEqual([])
  })
})

describe("filterSourceTreeByQuery", () => {
  it("keeps parent folders while removing non-matching siblings", () => {
    const result = filterSourceTreeByQuery(TREE, "booka")
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Books")
    expect(result[0].children?.map((node) => node.name)).toEqual(["BookA.md"])
  })

  it("matches Unicode names and normalized path segments", () => {
    expect(filterSourceTreeByQuery(TREE, "治疗模型")[0].children?.[0].name)
      .toBe("三阶段治疗模型.pdf")
    expect(filterSourceTreeByQuery(TREE, "BOOKS")).toEqual([TREE[0]])
  })

  it("matches a full Windows-style path with backslashes", () => {
    // list_directory returns forward-slash paths, but a user pasting a
    // Windows path types backslashes. The filter folds \ to / so both match.
    const result = filterSourceTreeByQuery(TREE, "\\project\\raw\\sources\\Books\\BookA.md")
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Books")
    expect(result[0].children?.map((node) => node.name)).toEqual(["BookA.md"])
  })

  it("returns a new top-level array for an empty query without mutating nodes", () => {
    const result = filterSourceTreeByQuery(TREE, "  ")
    expect(result).toEqual(TREE)
    expect(result).not.toBe(TREE)
  })

  it("returns an empty tree when no source matches", () => {
    expect(filterSourceTreeByQuery(TREE, "missing source")).toEqual([])
  })
})

describe("summarizeImportOutcome", () => {
  it("stays silent when every selected file was imported", () => {
    expect(
      summarizeImportOutcome({ imported: ["/project/raw/sources/a.md"], skipped: [] }, null),
    ).toBeNull()
  })

  it("reports which files were left out of a partial import", () => {
    expect(
      summarizeImportOutcome(
        {
          imported: ["/project/raw/sources/a.md"],
          skipped: [{ name: "審查資料範例.pdf", reason: "too-large", detail: "142.8 MB" }],
        },
        null,
      ),
    ).toEqual({
      importedCount: 1,
      skipped: [{ name: "審查資料範例.pdf", reason: "too-large", detail: "142.8 MB" }],
      error: null,
    })
  })

  it("surfaces a thrown import error that today only reaches the console", () => {
    expect(
      summarizeImportOutcome(null, new Error("Cannot import the project folder")),
    ).toEqual({
      importedCount: 0,
      skipped: [],
      error: "Cannot import the project folder",
    })
  })

  it("reports nothing imported when the picker yielded no usable file", () => {
    expect(
      summarizeImportOutcome({ imported: [], skipped: [{ name: "a.py", reason: "unsupported-type" }] }, null),
    ).toEqual({
      importedCount: 0,
      skipped: [{ name: "a.py", reason: "unsupported-type" }],
      error: null,
    })
  })
})
