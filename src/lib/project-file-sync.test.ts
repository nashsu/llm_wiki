import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const resolvers: Array<(value: { version: number; tasks: Array<{ id: string; projectId: string; path: string; kind: "modified"; status: "pending"; createdAt: number; updatedAt: number; retryCount: number; needsRerun: boolean }> }) => void> = []
  const listeners: Record<string, (event: { payload: unknown }) => void> = {}
  return {
    listen: vi.fn(async (event: string, cb: (event: { payload: unknown }) => void) => {
      listeners[event] = cb
      return vi.fn(() => {
        delete listeners[event]
      })
    }),
    emit: (event: string, payload: unknown) => listeners[event]?.({ payload }),
    stopProjectFileWatcher: vi.fn(async () => undefined),
    startProjectFileWatcher: vi.fn(() => new Promise((resolve) => {
      resolvers.push(resolve)
    })),
    resolveStart: (index: number, projectId: string) => resolvers[index]?.({
      version: 1,
      tasks: [{
        id: "t1",
        projectId,
        path: "raw/sources/a.md",
        kind: "modified",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
        retryCount: 0,
        needsRerun: false,
      }],
    }),
    clearResolvers: () => {
      resolvers.length = 0
    },
    listDirectory: vi.fn(async (_path?: string) => [] as Array<{
      name: string
      path: string
      is_dir: boolean
      children?: Array<{ name: string; path: string; is_dir: boolean }>
    }>),
    readFile: vi.fn(async (_path?: string) => ""),
    writeFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    findRelatedWikiPages: vi.fn(async () => []),
    enqueueBatch: vi.fn(async () => []),
    removeFromIngestCache: vi.fn(async () => undefined),
    removePageEmbedding: vi.fn(async () => undefined),
    cascadeDeleteWikiPagesWithRefs: vi.fn(async () => ({ deletedPaths: [], rewrittenFiles: 0 })),
  }
})

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}))

vi.mock("@/commands/file-sync", () => ({
  startProjectFileWatcher: mocks.startProjectFileWatcher,
  stopProjectFileWatcher: mocks.stopProjectFileWatcher,
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  deleteFile: mocks.deleteFile,
  findRelatedWikiPages: mocks.findRelatedWikiPages,
}))

vi.mock("@/lib/ingest-queue", () => ({
  enqueueBatch: mocks.enqueueBatch,
}))

vi.mock("@/lib/ingest-cache", () => ({
  removeFromIngestCache: mocks.removeFromIngestCache,
}))

vi.mock("@/lib/embedding", () => ({
  removePageEmbedding: mocks.removePageEmbedding,
}))

vi.mock("@/lib/wiki-page-delete", () => ({
  cascadeDeleteWikiPagesWithRefs: mocks.cascadeDeleteWikiPagesWithRefs,
}))

describe("project file sync", () => {
  beforeEach(async () => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.clearResolvers()
    const { useWikiStore } = await import("@/stores/wiki-store")
    const { useFileSyncStore } = await import("@/stores/file-sync-store")
    await import("@/lib/project-file-sync").then((m) => m.stopProjectFileSync())
    useWikiStore.getState().setProject(null)
    useFileSyncStore.getState().clear()
  })

  it("does not apply a stale start result after the active project changes", async () => {
    const { startProjectFileSync, stopProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")
    const { useFileSyncStore } = await import("@/stores/file-sync-store")

    const projectA = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(projectA)
    const start = startProjectFileSync(projectA)

    await vi.waitFor(() => {
      expect(mocks.startProjectFileWatcher).toHaveBeenCalledTimes(1)
    })
    const projectB = { id: "B", name: "B", path: "/tmp/b" }
    useWikiStore.getState().setProject(projectB)
    await stopProjectFileSync()
    mocks.resolveStart(0, "A")
    await start

    expect(useFileSyncStore.getState().tasks).toEqual([])
  })

  it("enqueues created and modified raw source files for ingest", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    void startProjectFileSync(project)

    await vi.waitFor(() => {
      expect(mocks.listen).toHaveBeenCalledTimes(2)
    })

    mocks.emit("file-sync://changed", {
      projectId: "A",
      tasks: [
        {
          id: "t1",
          projectId: "A",
          path: "raw/sources/report.pdf",
          kind: "created",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
        {
          id: "t2",
          projectId: "A",
          path: "raw/sources/image.png",
          kind: "created",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
        {
          id: "t3",
          projectId: "A",
          path: "wiki/index.md",
          kind: "modified",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(250)

    expect(mocks.enqueueBatch).toHaveBeenCalledWith("A", [
      { sourcePath: "raw/sources/report.pdf", folderContext: "" },
    ])
  })

  it("removes an externally deleted raw source from every wiki page sources field", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    mocks.listDirectory.mockImplementation(async (path?: string) => {
      if (path === "/tmp/a/wiki") {
        return [
          {
            name: "concepts",
            path: "/tmp/a/wiki/concepts",
            is_dir: true,
            children: [
              {
                name: "mind.md",
                path: "/tmp/a/wiki/concepts/mind.md",
                is_dir: false,
              },
            ],
          },
        ]
      }
      return []
    })
    mocks.readFile.mockImplementation(async (path?: string) => {
      if (path === "/tmp/a/wiki/concepts/mind.md") {
        return [
          "---",
          'sources: ["life_is_a_mind_game.md", "other.md"]',
          "---",
          "# Mind",
        ].join("\n")
      }
      if (path === "/tmp/a/wiki/log.md") return "# Wiki Log\n"
      return ""
    })

    void startProjectFileSync(project)
    await vi.waitFor(() => {
      expect(mocks.listen).toHaveBeenCalledTimes(2)
    })

    mocks.emit("file-sync://changed", {
      projectId: "A",
      tasks: [
        {
          id: "t1",
          projectId: "A",
          path: "raw/sources/life_is_a_mind_game.md",
          kind: "deleted",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith(
        "/tmp/a/wiki/concepts/mind.md",
        expect.stringContaining('sources: ["other.md"]'),
      )
    })
  })
})
