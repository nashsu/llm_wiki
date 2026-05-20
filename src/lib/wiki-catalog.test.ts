import { describe, expect, it, vi, beforeEach } from "vitest"
import type { FileNode } from "@/types/wiki"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
}))

import { listDirectory, readFile } from "@/commands/fs"
import {
  flattenWikiMdFiles,
  indexSectionForWikiRel,
  listWikiCatalogPages,
} from "./wiki-catalog"

const mockListDirectory = vi.mocked(listDirectory)
const mockReadFile = vi.mocked(readFile)

describe("flattenWikiMdFiles", () => {
  it("collects markdown files recursively", () => {
    const tree: FileNode[] = [
      {
        name: "wiki",
        path: "/p/wiki",
        is_dir: true,
        children: [
          { name: "index.md", path: "/p/wiki/index.md", is_dir: false },
          {
            name: "entities",
            path: "/p/wiki/entities",
            is_dir: true,
            children: [
              { name: "foo.md", path: "/p/wiki/entities/foo.md", is_dir: false },
            ],
          },
        ],
      },
    ]
    const files = flattenWikiMdFiles(tree[0].children ?? [])
    expect(files.map((f) => f.name)).toEqual(["index.md", "foo.md"])
  })
})

describe("indexSectionForWikiRel", () => {
  it("maps folders to template sections", () => {
    expect(indexSectionForWikiRel("entities/acme")).toBe("Entities")
  })
})

describe("listWikiCatalogPages", () => {
  beforeEach(() => {
    mockListDirectory.mockReset()
    mockReadFile.mockReset()
  })

  it("skips structural filenames and reads frontmatter title", async () => {
    mockListDirectory.mockResolvedValue([
      { name: "index.md", path: "/p/wiki/index.md", is_dir: false },
      { name: "entities", path: "/p/wiki/entities", is_dir: true, children: [
        { name: "acme.md", path: "/p/wiki/entities/acme.md", is_dir: false },
      ] },
    ])
    mockReadFile.mockResolvedValue(
      "---\ntype: entity\ntitle: Acme Corp\n---\n\n# Acme\n",
    )

    const pages = await listWikiCatalogPages("/p")
    expect(pages).toEqual([
      {
        linkTarget: "entities/acme",
        section: "Entities",
        title: "Acme Corp",
      },
    ])
  })

  it("returns empty when wiki root is missing", async () => {
    mockListDirectory.mockRejectedValue(new Error("ENOENT"))
    expect(await listWikiCatalogPages("/p")).toEqual([])
  })
})
