/**
 * Unit tests for the pure helpers backing the SourcesView delete
 * flow. The React component (`SourceTree`) calls these and turns
 * their output into state updates / handler dispatches; testing
 * the helpers in isolation pins behavior without needing a DOM
 * test environment.
 */
import { describe, it, expect } from "vitest"
import {
  collectAllFilesIncludingDot,
  decideDeleteClick,
} from "./sources-tree-delete"
import type { FileNode } from "@/types/wiki"

function file(path: string): FileNode {
  const name = path.split("/").pop() ?? path
  return { name, path, is_dir: false }
}

function dir(path: string, children: FileNode[]): FileNode {
  const name = path.split("/").pop() ?? path
  return { name, path, is_dir: true, children }
}

describe("collectAllFilesIncludingDot", () => {
  it("returns empty list for an empty folder", () => {
    expect(collectAllFilesIncludingDot(dir("/p", []))).toEqual([])
  })

  it("returns all leaf files of a single-level folder", () => {
    const tree = dir("/p", [file("/p/a.pdf"), file("/p/b.docx")])
    const out = collectAllFilesIncludingDot(tree)
    expect(out.map((n) => n.path)).toEqual(["/p/a.pdf", "/p/b.docx"])
  })

  it("recurses into subdirectories of arbitrary depth", () => {
    // /p/a.pdf
    // /p/sub/b.docx
    // /p/sub/deep/c.md
    // /p/sub/deep/even-deeper/d.txt
    const tree = dir("/p", [
      file("/p/a.pdf"),
      dir("/p/sub", [
        file("/p/sub/b.docx"),
        dir("/p/sub/deep", [
          file("/p/sub/deep/c.md"),
          dir("/p/sub/deep/even-deeper", [file("/p/sub/deep/even-deeper/d.txt")]),
        ]),
      ]),
    ])
    const out = collectAllFilesIncludingDot(tree)
    expect(out.map((n) => n.path)).toEqual([
      "/p/a.pdf",
      "/p/sub/b.docx",
      "/p/sub/deep/c.md",
      "/p/sub/deep/even-deeper/d.txt",
    ])
  })

  it("does not include directory nodes themselves in the result", () => {
    const tree = dir("/p", [dir("/p/sub", [file("/p/sub/x.md")])])
    const out = collectAllFilesIncludingDot(tree)
    expect(out.every((n) => !n.is_dir)).toBe(true)
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe("/p/sub/x.md")
  })

  it("handles a directory with no children property (defensive)", () => {
    // listDirectory normalizes empty dirs to children: [], but the
    // FileNode type allows `children?: FileNode[]` — make sure we
    // don't crash on undefined.
    const tree: FileNode = { name: "p", path: "/p", is_dir: true }
    expect(collectAllFilesIncludingDot(tree)).toEqual([])
  })

  it("walks deeply-nested folder containing a single file 10 levels down", () => {
    // Build /p/0/1/2/3/4/5/6/7/8/9/leaf.txt programmatically.
    let leaf: FileNode = file("/p/0/1/2/3/4/5/6/7/8/9/leaf.txt")
    for (let i = 9; i >= 0; i--) {
      const path = "/p/" + Array.from({ length: i + 1 }, (_, k) => k).join("/")
      leaf = dir(path, [leaf])
    }
    // `leaf` is now the outer /p/0 dir wrapping all of it.
    const root = dir("/p", [leaf])
    const out = collectAllFilesIncludingDot(root)
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe("/p/0/1/2/3/4/5/6/7/8/9/leaf.txt")
  })
})

describe("decideDeleteClick", () => {
  const fileNode = file("/p/a.pdf")
  const folderNode = dir("/p/sub", [file("/p/sub/x.md")])

  it("arms the button on first click (no pending state)", () => {
    expect(decideDeleteClick(null, fileNode)).toEqual({
      kind: "arm",
      path: "/p/a.pdf",
    })
  })

  it("arms a different node when the pending path doesn't match", () => {
    // User had `/p/a.pdf` armed but now clicked `/p/b.pdf` — the
    // newer click wins and `b` becomes the armed one.
    const otherFile = file("/p/b.pdf")
    expect(decideDeleteClick("/p/a.pdf", otherFile)).toEqual({
      kind: "arm",
      path: "/p/b.pdf",
    })
  })

  it("fires file delete on second click of the same FILE node", () => {
    expect(decideDeleteClick("/p/a.pdf", fileNode)).toEqual({
      kind: "fire-file",
      node: fileNode,
    })
  })

  it("fires folder delete on second click of the same FOLDER node", () => {
    expect(decideDeleteClick("/p/sub", folderNode)).toEqual({
      kind: "fire-folder",
      node: folderNode,
    })
  })

  it("treats node identity by path, not object identity", () => {
    // Two FileNode objects with the same path should still match —
    // the file tree gets re-allocated on every loadSources() call,
    // so object-identity equality would break confirmation across
    // re-renders.
    const reAllocated = file("/p/a.pdf")
    expect(decideDeleteClick("/p/a.pdf", reAllocated)).toEqual({
      kind: "fire-file",
      node: reAllocated,
    })
  })

  it("never returns a no-op — every click produces an actionable result", () => {
    // Any combination of (pending, clicked) must produce one of
    // the three action kinds, never `undefined` or a "do nothing"
    // signal. Tested against the three meaningful scenarios above
    // — this is a regression guard for accidentally adding an
    // early-return path.
    const results = [
      decideDeleteClick(null, fileNode),
      decideDeleteClick("other", fileNode),
      decideDeleteClick(fileNode.path, fileNode),
      decideDeleteClick(folderNode.path, folderNode),
    ]
    for (const r of results) {
      expect(["arm", "fire-file", "fire-folder"]).toContain(r.kind)
    }
  })
})
