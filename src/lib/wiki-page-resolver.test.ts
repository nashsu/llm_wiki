import { describe, it, expect } from "vitest"
import type { FileNode } from "@/types/wiki"
import {
  buildProjectPathIndexFromTree,
  createEmptyProjectPathIndex,
  findInTreeByName,
  resolveRelatedSlug,
  resolveSourceName,
  unwrapWikilink,
} from "./wiki-page-resolver"

const PP = "/p"
const WIKI = `${PP}/wiki`
const SOURCES = `${PP}/raw/sources`

function file(path: string): FileNode {
  const name = path.split("/").pop()!
  return { name, path, is_dir: false }
}
function dir(path: string, children: FileNode[]): FileNode {
  const name = path.split("/").pop()!
  return { name, path, is_dir: true, children }
}

const TREE: FileNode[] = [
  dir(`${PP}/wiki`, [
    dir(`${WIKI}/entities`, [file(`${WIKI}/entities/foo.md`)]),
    dir(`${WIKI}/concepts`, [file(`${WIKI}/concepts/bar.md`)]),
    dir(`${WIKI}/queries`, [file(`${WIKI}/queries/what-is-foo.md`)]),
    dir(`${WIKI}/sources`, [file(`${WIKI}/sources/paper.md`)]),
  ]),
  dir(`${PP}/raw`, [
    dir(`${SOURCES}`, [
      file(`${SOURCES}/report.pdf`),
      dir(`${SOURCES}/year-2025`, [
        file(`${SOURCES}/year-2025/q1.pdf`),
        file(`${SOURCES}/year-2025/notes.md`),
      ]),
    ]),
  ]),
]

const INDEX = buildProjectPathIndexFromTree(TREE)

const DUP_TREE: FileNode[] = [
  dir(`${PP}/raw`, [
    dir(`${SOURCES}`, [file(`${SOURCES}/dup.md`)]),
  ]),
  dir(`${PP}/wiki`, [
    dir(`${WIKI}/a`, [file(`${WIKI}/a/dup.md`)]),
    dir(`${WIKI}/b`, [file(`${WIKI}/b/dup.md`)]),
    dir(`${WIKI}/dir-only.md`, []),
  ]),
]

const DUP_INDEX = buildProjectPathIndexFromTree(DUP_TREE)

const STRAY_CHILDREN_INDEX = buildProjectPathIndexFromTree([
  {
    name: "file-with-children.md",
    path: `${WIKI}/file-with-children.md`,
    is_dir: false,
    children: [file(`${WIKI}/should-not-index.md`)],
  },
])

describe("unwrapWikilink", () => {
  it("unwraps a bare [[target]]", () => {
    expect(unwrapWikilink("[[nh3-n]]")).toEqual({ slug: "nh3-n", label: "nh3-n" })
  })

  it("unwraps [[target|alias]] and uses alias as label", () => {
    expect(unwrapWikilink("[[nh3-n|NH3-N (氨氮)]]")).toEqual({
      slug: "nh3-n",
      label: "NH3-N (氨氮)",
    })
  })

  it("trims whitespace inside the wikilink", () => {
    expect(unwrapWikilink("[[ nh3-n | 氨氮 ]]")).toEqual({
      slug: "nh3-n",
      label: "氨氮",
    })
  })

  it("returns input unchanged for non-wikilink strings", () => {
    expect(unwrapWikilink("nh3-n")).toEqual({ slug: "nh3-n", label: "nh3-n" })
    expect(unwrapWikilink("wiki/entities/nh3-n.md")).toEqual({
      slug: "wiki/entities/nh3-n.md",
      label: "wiki/entities/nh3-n.md",
    })
  })

  it("does not match partial brackets", () => {
    expect(unwrapWikilink("[[broken")).toEqual({ slug: "[[broken", label: "[[broken" })
    expect(unwrapWikilink("broken]]")).toEqual({ slug: "broken]]", label: "broken]]" })
  })

  it("returns target when alias is empty pipe", () => {
    expect(unwrapWikilink("[[nh3-n|]]")).toEqual({ slug: "nh3-n", label: "nh3-n" })
  })
})

describe("findInTreeByName", () => {
  it("returns null on an empty tree", () => {
    expect(findInTreeByName(createEmptyProjectPathIndex(), "foo.md", "/wiki/")).toBeNull()
  })

  it("finds a file at the top of a subtree", () => {
    expect(findInTreeByName(INDEX, "foo.md", `${WIKI}/`)).toBe(`${WIKI}/entities/foo.md`)
  })

  it("recurses into nested directories", () => {
    expect(findInTreeByName(INDEX, "q1.pdf", `${SOURCES}/`)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("respects pathContains as a subtree filter", () => {
    // "notes.md" exists under raw/sources/year-2025 but not under wiki/.
    expect(findInTreeByName(INDEX, "notes.md", `${WIKI}/`)).toBeNull()
    expect(findInTreeByName(INDEX, "notes.md", `${SOURCES}/`)).toBe(
      `${SOURCES}/year-2025/notes.md`,
    )
  })

  it("returns null when nothing matches", () => {
    expect(findInTreeByName(INDEX, "missing.md", `${WIKI}/`)).toBeNull()
  })

  it("can resolve from the lightweight project path index", () => {
    expect(findInTreeByName(INDEX, "foo.md", `${WIKI}/`)).toBe(`${WIKI}/entities/foo.md`)
    expect(findInTreeByName(INDEX, "q1.pdf", `${SOURCES}/`)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("preserves first-match DFS order for duplicate filenames in the index", () => {
    expect(findInTreeByName(DUP_INDEX, "dup.md", `${WIKI}/`)).toBe(`${WIKI}/a/dup.md`)
  })

  it("skips earlier duplicate filenames outside the requested path scope", () => {
    expect(findInTreeByName(DUP_INDEX, "dup.md", `${SOURCES}/`)).toBe(`${SOURCES}/dup.md`)
    expect(findInTreeByName(DUP_INDEX, "dup.md", `${WIKI}/`)).toBe(`${WIKI}/a/dup.md`)
  })

  it("never returns directories from filename lookups in the index", () => {
    expect(findInTreeByName(DUP_INDEX, "dir-only.md", `${WIKI}/`)).toBeNull()
  })

  it("does not descend into malformed file nodes that carry children", () => {
    expect(findInTreeByName(STRAY_CHILDREN_INDEX, "file-with-children.md", `${WIKI}/`)).toBe(
      `${WIKI}/file-with-children.md`,
    )
    expect(findInTreeByName(STRAY_CHILDREN_INDEX, "should-not-index.md", `${WIKI}/`)).toBeNull()
  })
})

describe("resolveRelatedSlug", () => {
  it("appends .md and finds entities by bare slug", () => {
    expect(resolveRelatedSlug(INDEX, "foo", WIKI)).toBe(`${WIKI}/entities/foo.md`)
  })

  it("finds queries with hyphenated slugs", () => {
    expect(resolveRelatedSlug(INDEX, "what-is-foo", WIKI)).toBe(
      `${WIKI}/queries/what-is-foo.md`,
    )
  })

  it("accepts bare filename with .md extension", () => {
    expect(resolveRelatedSlug(INDEX, "foo.md", WIKI)).toBe(`${WIKI}/entities/foo.md`)
  })

  it("accepts a project-relative wiki path", () => {
    expect(resolveRelatedSlug(INDEX, "wiki/entities/foo.md", WIKI)).toBe(
      `${WIKI}/entities/foo.md`,
    )
  })

  it("accepts a project-relative path under nested wiki subfolder", () => {
    expect(resolveRelatedSlug(INDEX, "wiki/concepts/bar.md", WIKI)).toBe(
      `${WIKI}/concepts/bar.md`,
    )
  })

  it("returns null when slug doesn't exist", () => {
    expect(resolveRelatedSlug(INDEX, "ghost", WIKI)).toBeNull()
  })

  it("returns null when path-like ref doesn't exist", () => {
    expect(resolveRelatedSlug(INDEX, "wiki/entities/ghost.md", WIKI)).toBeNull()
  })

  it("never returns a path under raw/sources, even if a matching .md exists there", () => {
    expect(resolveRelatedSlug(INDEX, "notes", WIKI)).toBeNull()
  })

  it("rejects path-like refs that point outside wiki/", () => {
    expect(resolveRelatedSlug(INDEX, "raw/sources/year-2025/notes.md", WIKI)).toBeNull()
  })

  it("resolves related slugs from the project path index", () => {
    expect(resolveRelatedSlug(INDEX, "foo", WIKI)).toBe(`${WIKI}/entities/foo.md`)
    expect(resolveRelatedSlug(INDEX, "wiki/concepts/bar.md", WIKI)).toBe(
      `${WIKI}/concepts/bar.md`,
    )
  })
})

describe("resolveSourceName", () => {
  it("finds a top-level source file", () => {
    expect(resolveSourceName(INDEX, "report.pdf", SOURCES)).toBe(
      `${SOURCES}/report.pdf`,
    )
  })

  it("finds a source nested in a subfolder", () => {
    expect(resolveSourceName(INDEX, "q1.pdf", SOURCES)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("returns null when filename doesn't exist", () => {
    expect(resolveSourceName(INDEX, "ghost.pdf", SOURCES)).toBeNull()
  })

  it("prefers wiki/sources/<name>.md over raw/sources for bare .md refs", () => {
    // paper.md only exists under wiki/sources, so it should resolve there.
    expect(resolveSourceName(INDEX, "paper.md", SOURCES)).toBe(
      `${WIKI}/sources/paper.md`,
    )
  })

  it("accepts a project-relative path", () => {
    expect(resolveSourceName(INDEX, "raw/sources/year-2025/q1.pdf", SOURCES)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("accepts a raw/sources relative source identity", () => {
    expect(resolveSourceName(INDEX, "year-2025/q1.pdf", SOURCES)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("accepts a project-relative wiki/sources path", () => {
    expect(resolveSourceName(INDEX, "wiki/sources/paper.md", SOURCES)).toBe(
      `${WIKI}/sources/paper.md`,
    )
  })

  it("resolves source names from the project path index", () => {
    expect(resolveSourceName(INDEX, "report.pdf", SOURCES)).toBe(`${SOURCES}/report.pdf`)
    expect(resolveSourceName(INDEX, "year-2025/q1.pdf", SOURCES)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
  })

  it("resolves path-like source refs from the project path index", () => {
    expect(resolveSourceName(INDEX, "raw/sources/year-2025/q1.pdf", SOURCES)).toBe(
      `${SOURCES}/year-2025/q1.pdf`,
    )
    expect(resolveSourceName(INDEX, "wiki/sources/paper.md", SOURCES)).toBe(
      `${WIKI}/sources/paper.md`,
    )
  })
})
