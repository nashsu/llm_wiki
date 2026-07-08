import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
}))

import { readFile } from "@/commands/fs"
import {
  buildPageCatalog,
  flattenWikiMarkdownFiles,
  pagePathToSlug,
} from "./page-catalog"

const mockReadFile = vi.mocked(readFile)

function file(path: string): FileNode {
  return {
    name: path.replace(/\\/g, "/").split("/").pop()!,
    path,
    is_dir: false,
  }
}

function dir(path: string, children: FileNode[]): FileNode {
  return {
    name: path.replace(/\\/g, "/").split("/").pop()!,
    path,
    is_dir: true,
    children,
  }
}

beforeEach(() => {
  mockReadFile.mockReset()
})

describe("flattenWikiMarkdownFiles", () => {
  it("returns only nested markdown pages under the project wiki", () => {
    const tree: FileNode[] = [
      dir("/project/wiki", [
        file("/project/wiki/index.md"),
        file("/project/wiki/readme.txt"),
        dir("/project/wiki/entities", [
          file("/project/wiki/entities/zeta.md"),
        ]),
        dir("/project/wiki/concepts", [
          file("/project/wiki/concepts/alpha.md"),
          file("/project/wiki/concepts/index.md"),
        ]),
      ]),
      dir("/project/raw", [
        dir("/project/raw/sources", [
          file("/project/raw/sources/source.md"),
        ]),
      ]),
      file("/project/wiki-copy/outside.md"),
    ]

    expect(flattenWikiMarkdownFiles(tree, "/project")).toEqual([
      "/project/wiki/entities/zeta.md",
      "/project/wiki/concepts/alpha.md",
      "/project/wiki/concepts/index.md",
    ])
  })

  it("matches normal absolute file paths when projectPath has a trailing slash", () => {
    const tree = [
      dir("/project/wiki", [file("/project/wiki/concepts/attention.md")]),
    ]

    expect(flattenWikiMarkdownFiles(tree, "/project/")).toEqual([
      "/project/wiki/concepts/attention.md",
    ])
  })
})

describe("pagePathToSlug", () => {
  it("uses the markdown basename without its extension", () => {
    expect(pagePathToSlug("/project/wiki/concepts/attention.md")).toBe(
      "attention",
    )
    expect(pagePathToSlug("C:\\project\\wiki\\entities\\OpenAI.md")).toBe(
      "OpenAI",
    )
  })
})

describe("buildPageCatalog", () => {
  it("builds sorted entries from usable frontmatter values", async () => {
    const alphaPath = "/project/wiki/concepts/alpha.md"
    const betaPath = "/project/wiki/entities/beta.md"
    const fallbackPath = "/project/wiki/concepts/fallback.md"
    const tree = [
      dir("/project/wiki", [
        file(fallbackPath),
        file(betaPath),
        file("/project/wiki/index.md"),
        file(alphaPath),
      ]),
      file("/project/raw/sources/source.md"),
    ]

    mockReadFile.mockImplementation(async (path) => {
      if (path === alphaPath) {
        return [
          "---",
          "title: Alpha Page",
          "type: concept",
          "tags:",
          "  - first",
          "  - '  second  '",
          "  - '   '",
          "---",
          "Alpha body",
        ].join("\n")
      }
      if (path === betaPath) {
        return [
          "---",
          "title: Beta Page",
          "type: entity",
          "tags: 'beta, featured, , reference '",
          "---",
          "Beta body",
        ].join("\n")
      }
      return [
        "---",
        "title: '   '",
        "type:",
        "  - invalid",
        "tags: ''",
        "---",
        "Fallback body",
      ].join("\n")
    })

    await expect(buildPageCatalog(tree, "/project")).resolves.toEqual([
      {
        slug: "alpha",
        title: "Alpha Page",
        type: "concept",
        tags: ["first", "second"],
        path: alphaPath,
      },
      {
        slug: "beta",
        title: "Beta Page",
        type: "entity",
        tags: ["beta", "featured", "reference"],
        path: betaPath,
      },
      {
        slug: "fallback",
        title: "fallback",
        type: "",
        tags: [],
        path: fallbackPath,
      },
    ])
    expect(mockReadFile).toHaveBeenCalledTimes(3)
    expect(mockReadFile).toHaveBeenCalledWith(alphaPath)
    expect(mockReadFile).toHaveBeenCalledWith(betaPath)
    expect(mockReadFile).toHaveBeenCalledWith(fallbackPath)
  })

  it("uses the slug and empty metadata when frontmatter is absent", async () => {
    const path = "/project/wiki/queries/no-frontmatter.md"
    mockReadFile.mockResolvedValue("# No frontmatter")

    await expect(
      buildPageCatalog([file(path)], "/project/"),
    ).resolves.toEqual([
      {
        slug: "no-frontmatter",
        title: "no-frontmatter",
        type: "",
        tags: [],
        path,
      },
    ])
  })
})
