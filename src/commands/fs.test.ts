import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

import { createDirectory, listDirectory, writeFile, writeFileAtomic } from "./fs"

describe("fs command path guards", () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it("rejects relative write paths before invoking Tauri", async () => {
    await expect(writeFile("wiki/sources/stray.md", "content")).rejects.toThrow(
      /absolute path/i,
    )

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("rejects relative atomic write paths before invoking Tauri", async () => {
    await expect(writeFileAtomic("wiki/sources/stray.md", "content")).rejects.toThrow(
      /absolute path/i,
    )

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("rejects relative directory paths before invoking Tauri", async () => {
    await expect(createDirectory("wiki/sources")).rejects.toThrow(/absolute path/i)

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("allows absolute write paths", async () => {
    mocks.invoke.mockResolvedValue(undefined)

    await writeFile("/tmp/project/wiki/sources/page.md", "content")

    expect(mocks.invoke).toHaveBeenCalledWith("write_file", {
      path: "/tmp/project/wiki/sources/page.md",
      contents: "content",
    })
  })

  it("deduplicates matching in-flight listDirectory requests only while pending", async () => {
    const tree = [{
      name: "wiki",
      path: "/tmp/project/wiki",
      is_dir: true,
      children: [{ name: "page.md", path: "/tmp/project/wiki/page.md", is_dir: false }],
    }]
    let resolveTree: (value: typeof tree) => void = () => {}
    mocks.invoke.mockImplementationOnce(
      () => new Promise<typeof tree>((resolve) => {
        resolveTree = resolve
      }),
    )

    const first = listDirectory("/tmp/project", { maxDepth: 2 })
    const second = listDirectory("/tmp/project", { maxDepth: 2 })

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith("list_directory", {
      path: "/tmp/project",
      includeHidden: false,
      maxDepth: 2,
    })

    resolveTree(tree)
    const [firstTree, secondTree] = await Promise.all([first, second])
    expect(firstTree).toEqual(tree)
    expect(secondTree).toEqual(tree)
    expect(firstTree).not.toBe(secondTree)
    expect(firstTree[0]).not.toBe(secondTree[0])
    expect(firstTree[0].children?.[0]).not.toBe(secondTree[0].children?.[0])
    secondTree[0].name = "mutated"
    secondTree[0].children![0].name = "mutated-child.md"
    expect(firstTree[0].name).toBe("wiki")
    expect(firstTree[0].children?.[0]?.name).toBe("page.md")

    mocks.invoke.mockResolvedValueOnce([])
    await listDirectory("/tmp/project", { maxDepth: 2 })

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it("does not clone single-caller listDirectory results", async () => {
    const tree = [{ name: "wiki", path: "/tmp/project/wiki", is_dir: true }]
    mocks.invoke.mockResolvedValueOnce(tree)

    await expect(listDirectory("/tmp/project")).resolves.toBe(tree)
  })

  it("does not deduplicate listDirectory requests with different options", async () => {
    mocks.invoke.mockResolvedValue([])

    await Promise.all([
      listDirectory("/tmp/project", { maxDepth: 2 }),
      listDirectory("/tmp/project", { maxDepth: 3 }),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it("does not deduplicate listDirectory requests with different paths", async () => {
    mocks.invoke
      .mockResolvedValueOnce([{ name: "a", path: "/tmp/a", is_dir: true }])
      .mockResolvedValueOnce([{ name: "b", path: "/tmp/b", is_dir: true }])

    const [first, second] = await Promise.all([
      listDirectory("/tmp/a"),
      listDirectory("/tmp/b"),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
    expect(first).not.toBe(second)
    expect(first).toEqual([{ name: "a", path: "/tmp/a", is_dir: true }])
    expect(second).toEqual([{ name: "b", path: "/tmp/b", is_dir: true }])
  })

  it("does not deduplicate listDirectory requests with different hidden-entry options", async () => {
    mocks.invoke.mockResolvedValue([])

    await Promise.all([
      listDirectory("/tmp/project", false),
      listDirectory("/tmp/project", true),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it("deduplicates boolean and object includeHidden overloads with the same value", async () => {
    mocks.invoke.mockResolvedValue([])

    await Promise.all([
      listDirectory("/tmp/project", true),
      listDirectory("/tmp/project", { includeHidden: true }),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it("deduplicates default and explicit false includeHidden options", async () => {
    mocks.invoke.mockResolvedValue([])

    await Promise.all([
      listDirectory("/tmp/project"),
      listDirectory("/tmp/project", { includeHidden: false }),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it("clears rejected in-flight listDirectory requests so later calls can retry", async () => {
    let rejectTree: (reason: Error) => void = () => {}
    mocks.invoke.mockImplementationOnce(
      () => new Promise((_, reject) => {
        rejectTree = reject
      }),
    )

    const first = listDirectory("/tmp/project")
    const second = listDirectory("/tmp/project")

    expect(mocks.invoke).toHaveBeenCalledTimes(1)

    rejectTree(new Error("scan failed"))

    const settled = await Promise.allSettled([first, second])
    expect(settled).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ])

    mocks.invoke.mockResolvedValueOnce([])
    await expect(listDirectory("/tmp/project")).resolves.toEqual([])

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })
})
