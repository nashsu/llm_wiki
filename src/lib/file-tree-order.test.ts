import { describe, expect, it } from "vitest"
import type { FileNode } from "@/types/wiki"
import { flattenFilesNaturally } from "./file-tree-order"

function file(path: string): FileNode {
  return { name: path.split("/").pop()!, path, is_dir: false }
}

function dir(path: string, children?: FileNode[]): FileNode {
  return { name: path.split("/").pop()!, path, is_dir: true, children }
}

describe("flattenFilesNaturally", () => {
  it("uses directory-first natural ordering at every tree level without mutation", () => {
    const nestedChildren = [file("/p/chapter 10/0.10 nested.pdf"), file("/p/chapter 10/0.2 nested.pdf")]
    const tree = [
      file("/p/0.10 root.pdf"),
      dir("/p/chapter 10", nestedChildren),
      file("/p/0.2 root.pdf"),
      dir("/p/chapter 2", [dir("/p/chapter 2/part 1", [file("/p/chapter 2/part 1/0.1 nested.pdf")])]),
      file("/p/0.1 root.pdf"),
    ]
    const originalRootOrder = tree.map((node) => node.path)
    const originalNestedOrder = nestedChildren.map((node) => node.path)

    expect(flattenFilesNaturally(tree).map((node) => node.path)).toEqual([
      "/p/chapter 2/part 1/0.1 nested.pdf",
      "/p/chapter 10/0.2 nested.pdf",
      "/p/chapter 10/0.10 nested.pdf",
      "/p/0.1 root.pdf",
      "/p/0.2 root.pdf",
      "/p/0.10 root.pdf",
    ])
    expect(tree.map((node) => node.path)).toEqual(originalRootOrder)
    expect(nestedChildren.map((node) => node.path)).toEqual(originalNestedOrder)
  })

  it("ignores empty directories and handles an empty tree", () => {
    expect(flattenFilesNaturally([dir("/p/empty", []), dir("/p/unloaded"), file("/p/a.pdf")]))
      .toEqual([file("/p/a.pdf")])
    expect(flattenFilesNaturally([])).toEqual([])
  })
})
