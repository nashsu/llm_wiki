import { describe, expect, it } from "vitest"
import type { FileNode } from "@/types/wiki"
import { replaceNodeChildren } from "./file-tree-utils"

function file(path: string): FileNode {
  return { name: path.split("/").pop()!, path, is_dir: false }
}

function dir(path: string, children?: FileNode[]): FileNode {
  return { name: path.split("/").pop()!, path, is_dir: true, children }
}

describe("replaceNodeChildren", () => {
  it("replaces children for a top-level directory", () => {
    const tree = [dir("/p/wiki"), file("/p/schema.md")]
    const children = [file("/p/wiki/page.md")]

    const result = replaceNodeChildren(tree, "/p/wiki", children)

    expect(result.matched).toBe(true)
    expect(result.nodes[0]).toEqual({ ...dir("/p/wiki"), children })
    expect(result.nodes[1]).toBe(tree[1])
  })

  it("replaces children for a nested directory without touching siblings", () => {
    const sibling = file("/p/wiki/a.md")
    const tree = [
      dir("/p/wiki", [
        sibling,
        dir("/p/wiki/nested"),
      ]),
    ]
    const children = [file("/p/wiki/nested/b.md")]

    const result = replaceNodeChildren(tree, "/p/wiki/nested", children)

    expect(result.matched).toBe(true)
    expect(result.nodes[0]).not.toBe(tree[0])
    expect(result.nodes[0].children?.[0]).toBe(sibling)
    expect(result.nodes[0].children?.[1]).toEqual({ ...dir("/p/wiki/nested"), children })
  })

  it("returns the original tree when the path is not found", () => {
    const tree = [dir("/p/wiki")]

    const result = replaceNodeChildren(tree, "/p/missing", [file("/p/missing/a.md")])

    expect(result.matched).toBe(false)
    expect(result.nodes).toBe(tree)
  })
})
