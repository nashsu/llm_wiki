import { beforeEach, describe, expect, it, vi } from "vitest"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { useWikiStore } from "@/stores/wiki-store"
import type { FileNode, WikiProject } from "@/types/wiki"
import { buildProjectPathIndexFromTree } from "@/lib/wiki-page-resolver"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
}))

const project: WikiProject = {
  id: "project-1",
  name: "Project",
  path: "/tmp/project",
}

const shallowTree: FileNode[] = [
  {
    name: "wiki",
    path: "/tmp/project/wiki",
    is_dir: true,
    children: [],
  },
]

const fullTree: FileNode[] = [
  {
    name: "wiki",
    path: "/tmp/project/wiki",
    is_dir: true,
    children: [
      {
        name: "entities",
        path: "/tmp/project/wiki/entities",
        is_dir: true,
        children: [
          {
            name: "alpha.md",
            path: "/tmp/project/wiki/entities/alpha.md",
            is_dir: false,
          },
        ],
      },
    ],
  },
]

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("refreshProjectFileTree", () => {
  beforeEach(() => {
    mocks.listDirectory.mockReset()
    useWikiStore.setState({
      project,
      fileTree: [],
      projectPathIndex: { byPath: new Map(), filesByName: new Map() },
      dataVersion: 0,
    })
  })

  it("updates the visible tree shallowly and refreshes the full resolver index in the background", async () => {
    mocks.listDirectory.mockImplementation(async (_path: string, options?: { maxDepth?: number }) =>
      options?.maxDepth === 2 ? shallowTree : fullTree
    )

    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      bumpDataVersion: true,
    })
    await flushMicrotasks()

    expect(mocks.listDirectory).toHaveBeenNthCalledWith(1, project.path, { maxDepth: 2 })
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(2, project.path, undefined)
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(3, `${project.path}/raw/sources`, {
      includeHidden: true,
    })
    expect(useWikiStore.getState().fileTree).toEqual(shallowTree)
    expect(useWikiStore.getState().projectPathIndex.byPath.has("/tmp/project/wiki/entities/alpha.md")).toBe(true)
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })

  it("includes raw/sources dotfolders in the resolver index via a hidden scan", async () => {
    const rawSourcesHiddenTree: FileNode[] = [
      {
        name: ".claude",
        path: "/tmp/project/raw/sources/.claude",
        is_dir: true,
        children: [
          {
            name: "memory.md",
            path: "/tmp/project/raw/sources/.claude/memory.md",
            is_dir: false,
          },
          {
            name: "settings.json",
            path: "/tmp/project/raw/sources/.claude/settings.json",
            is_dir: false,
          },
        ],
      },
    ]
    mocks.listDirectory.mockImplementation(
      async (path: string, options?: { maxDepth?: number; includeHidden?: boolean }) => {
        if (options?.maxDepth === 2) return shallowTree
        if (path === "/tmp/project/raw/sources") return rawSourcesHiddenTree
        return fullTree
      },
    )

    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      bumpDataVersion: true,
    })
    await flushMicrotasks()

    const index = useWikiStore.getState().projectPathIndex
    expect(index.byPath.has("/tmp/project/wiki/entities/alpha.md")).toBe(true)
    expect(index.byPath.has("/tmp/project/raw/sources/.claude/memory.md")).toBe(true)
    expect(index.byPath.has("/tmp/project/raw/sources/.claude/settings.json")).toBe(false)
  })

  it("does not write stale results after the active project changes", async () => {
    mocks.listDirectory.mockImplementation(async (_path: string, options?: { maxDepth?: number }) =>
      options?.maxDepth === 2 ? shallowTree : fullTree
    )
    useWikiStore.setState({
      project: { ...project, id: "other-project", path: "/tmp/other" },
    })

    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      clearDisplayTreeFirst: true,
      bumpDataVersion: true,
    })
    await flushMicrotasks()

    expect(useWikiStore.getState().fileTree).toEqual([])
    expect(useWikiStore.getState().projectPathIndex.byPath.size).toBe(0)
    expect(useWikiStore.getState().dataVersion).toBe(0)
  })

  it("keeps the existing full resolver index when shallow refresh succeeds but full refresh fails", async () => {
    vi.useFakeTimers()
    const existingIndex = buildProjectPathIndexFromTree(fullTree)
    try {
      useWikiStore.setState({
        projectPathIndex: existingIndex,
      })
      mocks.listDirectory.mockImplementation(async (_path: string, options?: { maxDepth?: number }) => {
        if (options?.maxDepth === 2) return shallowTree
        throw new Error("full scan failed")
      })

      await refreshProjectFileTree(project.path, { projectId: project.id })
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(250)
      await flushMicrotasks()

      expect(mocks.listDirectory).toHaveBeenNthCalledWith(1, project.path, { maxDepth: 2 })
      // The full project scan retries three times before giving up.
      const fullScanCalls = mocks.listDirectory.mock.calls.filter(
        ([path, options]) => path === project.path && options === undefined,
      )
      expect(fullScanCalls).toHaveLength(3)
      expect(useWikiStore.getState().fileTree).toEqual(shallowTree)
      expect(useWikiStore.getState().projectPathIndex.byPath.has("/tmp/project/wiki/entities/alpha.md")).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("preserves already-loaded display children when refreshing the shallow tree", async () => {
    const loadedTree: FileNode[] = [
      {
        name: "wiki",
        path: "/tmp/project/wiki",
        is_dir: true,
        children: [
          {
            name: "entities",
            path: "/tmp/project/wiki/entities",
            is_dir: true,
            children: [
              {
                name: "alpha.md",
                path: "/tmp/project/wiki/entities/alpha.md",
                is_dir: false,
              },
            ],
          },
        ],
      },
    ]
    const refreshedShallowTree: FileNode[] = [
      {
        name: "wiki",
        path: "/tmp/project/wiki",
        is_dir: true,
        children: [
          {
            name: "entities",
            path: "/tmp/project/wiki/entities",
            is_dir: true,
          },
          {
            name: "concepts",
            path: "/tmp/project/wiki/concepts",
            is_dir: true,
          },
        ],
      },
    ]
    useWikiStore.getState().setFileTree(loadedTree, { syncPathIndex: false })
    mocks.listDirectory.mockImplementation(async (_path: string, options?: { maxDepth?: number }) =>
      options?.maxDepth === 2 ? refreshedShallowTree : fullTree
    )

    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      refreshPathIndex: false,
    })

    expect(useWikiStore.getState().fileTree).toEqual([
      {
        name: "wiki",
        path: "/tmp/project/wiki",
        is_dir: true,
        children: [
          {
            name: "entities",
            path: "/tmp/project/wiki/entities",
            is_dir: true,
            children: [
              {
                name: "alpha.md",
                path: "/tmp/project/wiki/entities/alpha.md",
                is_dir: false,
              },
            ],
          },
          {
            name: "concepts",
            path: "/tmp/project/wiki/concepts",
            is_dir: true,
          },
        ],
      },
    ])
  })

  it("retries the shallow display tree refresh before showing an empty sidebar", async () => {
    vi.useFakeTimers()
    try {
      mocks.listDirectory
        .mockRejectedValueOnce(new Error("transient list failure"))
        .mockResolvedValueOnce(shallowTree)

      const pending = refreshProjectFileTree(project.path, {
        projectId: project.id,
        refreshPathIndex: false,
      })
      await flushMicrotasks()
      expect(useWikiStore.getState().fileTree).toEqual([])

      await vi.advanceTimersByTimeAsync(250)
      await pending

      expect(mocks.listDirectory).toHaveBeenNthCalledWith(1, project.path, { maxDepth: 2 })
      expect(mocks.listDirectory).toHaveBeenNthCalledWith(2, project.path, { maxDepth: 2 })
      expect(useWikiStore.getState().fileTree).toEqual(shallowTree)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not start the background full scan once the shallow refresh reveals a stale project", async () => {
    mocks.listDirectory.mockImplementation(async (_path: string, options?: { maxDepth?: number }) => {
      if (options?.maxDepth === 2) {
        // Simulate switching projects while the shallow tree request is in flight.
        useWikiStore.setState({
          project: { ...project, id: "other-project", path: "/tmp/other" },
        })
        return shallowTree
      }
      return fullTree
    })

    await refreshProjectFileTree(project.path, {
      projectId: project.id,
      bumpDataVersion: true,
    })
    await flushMicrotasks()

    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
    expect(mocks.listDirectory).toHaveBeenCalledWith(project.path, { maxDepth: 2 })
    expect(useWikiStore.getState().fileTree).toEqual([])
    expect(useWikiStore.getState().projectPathIndex.byPath.size).toBe(0)
    expect(useWikiStore.getState().dataVersion).toBe(0)
  })
})
