import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const resolvers: Array<(value: { queue: { version: number; tasks: Array<{ id: string; projectId: string; path: string; kind: "modified"; status: "pending"; createdAt: number; updatedAt: number; retryCount: number; needsRerun: boolean }> }; changedTasks: Array<{ id: string; projectId: string; path: string; kind: "modified"; status: "pending"; createdAt: number; updatedAt: number; retryCount: number; needsRerun: boolean }> }) => void> = []
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
    rescanProjectFiles: vi.fn(async (projectId: string): Promise<{
      queue: {
        version: number
        tasks: Array<{
          id: string
          projectId: string
          path: string
          kind: "created" | "modified" | "deleted"
          status: "pending" | "processing" | "done" | "failed" | "superseded"
          createdAt: number
          updatedAt: number
          retryCount: number
          needsRerun: boolean
        }>
      }
      changedTasks: Array<{
        id: string
        projectId: string
        path: string
        kind: "created" | "modified" | "deleted"
        status: "pending" | "processing" | "done" | "failed" | "superseded"
        createdAt: number
        updatedAt: number
        retryCount: number
        needsRerun: boolean
      }>
    }> => {
      void projectId
      return {
        queue: {
          version: 1,
          tasks: [],
        },
        changedTasks: [],
      }
    }),
    startProjectFileWatcher: vi.fn(() => new Promise((resolve) => {
      resolvers.push(resolve)
    })),
    resolveStart: (index: number, projectId: string) => resolvers[index]?.({
      queue: {
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
      },
      changedTasks: [],
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
    getFileSize: vi.fn(async (_path?: string) => 1024),
    fileExists: vi.fn(async (_path?: string) => false),
    writeFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    findRelatedWikiPages: vi.fn(async () => []),
    enqueueBatch: vi.fn(async () => []),
    removeFromIngestCache: vi.fn(async () => undefined),
    moveIngestCacheEntry: vi.fn(async () => undefined),
    removePageEmbedding: vi.fn(async () => undefined),
    cascadeDeleteWikiPagesWithRefs: vi.fn(async () => ({
      deletedPaths: [] as string[],
      rewrittenFiles: 0,
    })),
  }
})

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}))

vi.mock("@/commands/file-sync", () => ({
  rescanProjectFiles: mocks.rescanProjectFiles,
  startProjectFileWatcher: mocks.startProjectFileWatcher,
  stopProjectFileWatcher: mocks.stopProjectFileWatcher,
}))

vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
  readFile: mocks.readFile,
  getFileSize: mocks.getFileSize,
  fileExists: mocks.fileExists,
  writeFile: mocks.writeFile,
  deleteFile: mocks.deleteFile,
  findRelatedWikiPages: mocks.findRelatedWikiPages,
}))

vi.mock("@/lib/ingest-queue", () => ({
  enqueueBatch: mocks.enqueueBatch,
}))

vi.mock("@/lib/ingest-cache", () => ({
  removeFromIngestCache: mocks.removeFromIngestCache,
  moveIngestCacheEntry: mocks.moveIngestCacheEntry,
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
    mocks.rescanProjectFiles.mockImplementation(async (projectId: string) => {
      void projectId
      return {
        queue: {
          version: 1,
          tasks: [],
        },
        changedTasks: [],
      }
    })
    mocks.listDirectory.mockImplementation(async (_path?: string) => [])
    mocks.readFile.mockImplementation(async (_path?: string) => "")
    mocks.getFileSize.mockImplementation(async (_path?: string) => 1024)
    mocks.fileExists.mockImplementation(async (_path?: string) => false)
    mocks.writeFile.mockImplementation(async () => undefined)
    mocks.deleteFile.mockImplementation(async () => undefined)
    mocks.findRelatedWikiPages.mockImplementation(async () => [])
    mocks.enqueueBatch.mockImplementation(async () => [])
    mocks.removeFromIngestCache.mockImplementation(async () => undefined)
    mocks.moveIngestCacheEntry.mockImplementation(async () => undefined)
    mocks.removePageEmbedding.mockImplementation(async () => undefined)
    mocks.cascadeDeleteWikiPagesWithRefs.mockImplementation(async () => ({
      deletedPaths: [] as string[],
      rewrittenFiles: 0,
    }))
    const { useWikiStore } = await import("@/stores/wiki-store")
    const { useFileSyncStore } = await import("@/stores/file-sync-store")
    await import("@/lib/project-file-sync").then((m) => m.stopProjectFileSync())
    useWikiStore.getState().setProject(null)
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "k",
      model: "m",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
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

  it("migrates an unchanged source move without deleting or re-ingesting it", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")
    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    mocks.listDirectory.mockResolvedValue([
      { name: "topic.md", path: "/tmp/a/wiki/topic.md", is_dir: false },
    ])
    mocks.readFile.mockResolvedValue("---\nsources: [old/report.md]\n---\n# Topic")
    void startProjectFileSync(project)
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2))

    mocks.emit("file-sync://changed", {
      projectId: "A",
      tasks: [
        { id: "d", projectId: "A", path: "raw/sources/old/report.md", kind: "deleted", status: "done", hashBefore: "same", size: 100, createdAt: 1, updatedAt: 1, retryCount: 0, needsRerun: false },
        { id: "c", projectId: "A", path: "raw/sources/new/report.md", kind: "created", status: "done", hashAfter: "same", size: 100, createdAt: 1, updatedAt: 1, retryCount: 0, needsRerun: false },
      ],
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.writeFile).toHaveBeenCalledWith(
      "/tmp/a/wiki/topic.md",
      expect.stringContaining('sources: ["new/report.md"]'),
    )
    expect(mocks.moveIngestCacheEntry).toHaveBeenCalledWith(
      "/tmp/a",
      "old/report.md",
      "new/report.md",
      expect.any(Map),
    )
    expect(mocks.enqueueBatch).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it("does not infer a move when either hash side is ambiguous", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")
    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    void startProjectFileSync(project)
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2))

    const base = { projectId: "A", status: "done", size: 100, createdAt: 1, updatedAt: 1, retryCount: 0, needsRerun: false } as const
    mocks.emit("file-sync://changed", {
      projectId: "A",
      tasks: [
        { ...base, id: "d1", path: "raw/sources/a.md", kind: "deleted", hashBefore: "same" },
        { ...base, id: "d2", path: "raw/sources/b.md", kind: "deleted", hashBefore: "same" },
        { ...base, id: "c", path: "raw/sources/c.md", kind: "created", hashAfter: "same" },
      ],
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.moveIngestCacheEntry).not.toHaveBeenCalled()
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("A", [
      { sourcePath: "raw/sources/c.md", folderContext: "" },
    ])
  })

  it("does not infer moves for tiny identical files", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")
    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    void startProjectFileSync(project)
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2))
    const base = { projectId: "A", status: "done", size: 0, createdAt: 1, updatedAt: 1, retryCount: 0, needsRerun: false } as const
    mocks.emit("file-sync://changed", {
      projectId: "A",
      tasks: [
        { ...base, id: "d", path: "raw/sources/empty-a.md", kind: "deleted", hashBefore: "empty" },
        { ...base, id: "c", path: "raw/sources/empty-b.md", kind: "created", hashAfter: "empty" },
      ],
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.moveIngestCacheEntry).not.toHaveBeenCalled()
  })

  it("consumes a proven move even when one wiki reference cannot be rewritten", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")
    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    mocks.listDirectory.mockResolvedValue([
      { name: "locked.md", path: "/tmp/a/wiki/locked.md", is_dir: false },
    ])
    mocks.readFile.mockResolvedValue("---\nsources: [old.md]\n---\n# Locked")
    mocks.writeFile.mockRejectedValueOnce(new Error("permission denied"))
    void startProjectFileSync(project)
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledTimes(2))
    const base = { projectId: "A", status: "done", size: 100, createdAt: 1, updatedAt: 1, retryCount: 0, needsRerun: false } as const
    mocks.emit("file-sync://changed", {
      projectId: "A",
      tasks: [
        { ...base, id: "d", path: "raw/sources/old.md", kind: "deleted", hashBefore: "same" },
        { ...base, id: "c", path: "raw/sources/new.md", kind: "created", hashAfter: "same" },
      ],
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.moveIngestCacheEntry).not.toHaveBeenCalled()
    expect(mocks.enqueueBatch).not.toHaveBeenCalled()
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it("does not ingest preprocessed cache files from raw/sources/.cache", async () => {
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
          path: "raw/sources/.cache/report.pdf.txt",
          kind: "created",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(250)

    expect(mocks.enqueueBatch).not.toHaveBeenCalled()
  })

  it("manual rescan uses the same source ingest flow when the watcher is stopped", async () => {
    const { rescanProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    mocks.rescanProjectFiles.mockImplementation(async (projectId: string) => {
      return {
        queue: { version: 1, tasks: [] },
        changedTasks: [
          {
            id: "t1",
            projectId,
            path: "raw/sources/manual.pdf",
            kind: "created",
            status: "done",
            createdAt: 1,
            updatedAt: 1,
            retryCount: 0,
            needsRerun: false,
          },
        ],
      }
    })

    await rescanProjectFileSync(project)

    expect(mocks.rescanProjectFiles).toHaveBeenCalledWith(
      "A",
      "/tmp/a",
      expect.objectContaining({ enabled: true, autoIngest: true }),
    )
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("A", [
      { sourcePath: "raw/sources/manual.pdf", folderContext: "" },
    ])
  })

  it("enqueues existing XML when source watch restarts with xml newly allowed", async () => {
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    mocks.startProjectFileWatcher.mockImplementationOnce(async () => ({
      queue: {
        version: 1,
        tasks: [],
      },
      changedTasks: [
        {
          id: "t1",
          projectId: "A",
          path: "raw/sources/existing.xml",
          kind: "created",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
      ],
    }) as never)

    await startProjectFileSync(project, {
      enabled: true,
      autoIngest: true,
      includeExtensions: ["md", "xml"],
      excludeExtensions: [],
      excludeDirs: [],
      excludeGlobs: [],
      maxFileSizeMb: 100,
    })

    expect(mocks.startProjectFileWatcher).toHaveBeenCalledWith(
      "A",
      "/tmp/a",
      expect.objectContaining({
        includeExtensions: expect.arrayContaining(["xml"]),
      }),
    )
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("A", [
      { sourcePath: "raw/sources/existing.xml", folderContext: "" },
    ])
  })

  it("does not suppress a retried file-change task that reuses the same id", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    void startProjectFileSync(project)

    await vi.waitFor(() => {
      expect(mocks.listen).toHaveBeenCalledTimes(2)
    })

    const baseTask = {
      id: "retryable-task",
      projectId: "A",
      path: "raw/sources/retry.pdf",
      kind: "modified" as const,
      status: "done" as const,
      createdAt: 1,
      retryCount: 0,
      needsRerun: false,
    }

    mocks.emit("file-sync://changed", {
      projectId: "A",
      tasks: [{ ...baseTask, updatedAt: 1 }],
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.enqueueBatch).toHaveBeenCalledTimes(1)

    mocks.emit("file-sync://changed", {
      projectId: "A",
      tasks: [{ ...baseTask, updatedAt: 2 }],
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(mocks.enqueueBatch).toHaveBeenCalledTimes(2)
  })

  it("manual rescan uses returned changed tasks while the watcher is running", async () => {
    const { startProjectFileSync, rescanProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    void startProjectFileSync(project)
    await vi.waitFor(() => {
      expect(mocks.listen).toHaveBeenCalledTimes(2)
    })

    mocks.rescanProjectFiles.mockImplementation(async (projectId: string) => ({
      queue: { version: 1, tasks: [] },
      changedTasks: [
        {
          id: "t1",
          projectId,
          path: "raw/sources/watcher-running.pdf",
          kind: "created",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
      ],
    }))

    await rescanProjectFileSync(project)

    expect(mocks.enqueueBatch).toHaveBeenCalledWith("A", [
      { sourcePath: "raw/sources/watcher-running.pdf", folderContext: "" },
    ])
  })

  it("manual rescan ignores changed tasks after project switch", async () => {
    const { rescanProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const projectA = { id: "A", name: "A", path: "/tmp/a" }
    const projectB = { id: "B", name: "B", path: "/tmp/b" }
    useWikiStore.getState().setProject(projectA)
    mocks.rescanProjectFiles.mockImplementation(async (projectId: string) => {
      useWikiStore.getState().setProject(projectB)
      return {
        queue: { version: 1, tasks: [] },
        changedTasks: [
          {
            id: "t1",
            projectId,
            path: "raw/sources/stale.pdf",
            kind: "created",
            status: "done",
            createdAt: 1,
            updatedAt: 1,
            retryCount: 0,
            needsRerun: false,
          },
        ],
      }
    })

    await rescanProjectFileSync(projectA)

    expect(mocks.enqueueBatch).not.toHaveBeenCalled()
  })

  it("manual rescan refreshes the file tree when no files changed", async () => {
    const { rescanProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)

    await rescanProjectFileSync(project)

    expect(mocks.listDirectory).toHaveBeenNthCalledWith(1, "/tmp/a", { maxDepth: 2 })
    expect(mocks.listDirectory).toHaveBeenNthCalledWith(2, "/tmp/a", undefined)
  })

  it("manual rescan respects auto ingest disabled", async () => {
    const { rescanProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    mocks.rescanProjectFiles.mockImplementation(async (projectId: string) => ({
      queue: { version: 1, tasks: [] },
      changedTasks: [
        {
          id: "t1",
          projectId,
          path: "raw/sources/manual.pdf",
          kind: "created",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
      ],
    }))

    await rescanProjectFileSync(project, { autoIngest: false } as never)

    expect(mocks.enqueueBatch).not.toHaveBeenCalled()
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

  it("cascades delete for wiki pages whose only source was externally deleted", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    mocks.listDirectory.mockImplementation(async (path?: string) => {
      if (path === "/tmp/a/wiki") {
        return [
          {
            name: "sources",
            path: "/tmp/a/wiki/sources",
            is_dir: true,
            children: [
              {
                name: "life.md",
                path: "/tmp/a/wiki/sources/life.md",
                is_dir: false,
              },
            ],
          },
        ]
      }
      return []
    })
    mocks.readFile.mockImplementation(async (path?: string) => {
      if (path === "/tmp/a/wiki/sources/life.md") {
        return "---\nsources: [life_is_a_mind_game.md]\n---\n# Life\n"
      }
      if (path === "/tmp/a/wiki/log.md") return "# Wiki Log\n"
      return ""
    })
    mocks.cascadeDeleteWikiPagesWithRefs.mockResolvedValueOnce({
      deletedPaths: ["/tmp/a/wiki/sources/life.md"],
      rewrittenFiles: 1,
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
      expect(mocks.cascadeDeleteWikiPagesWithRefs).toHaveBeenCalledWith(
        "/tmp/a",
        ["/tmp/a/wiki/sources/life.md"],
      )
    })
  })

  it("processes external batch source deletion with one wiki scan and one cascade", async () => {
    vi.useFakeTimers()
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const { useWikiStore } = await import("@/stores/wiki-store")

    const project = { id: "A", name: "A", path: "/tmp/a" }
    useWikiStore.getState().setProject(project)
    mocks.listDirectory.mockImplementation(async (path?: string) => {
      if (path === "/tmp/a/wiki") {
        return [
          {
            name: "sources",
            path: "/tmp/a/wiki/sources",
            is_dir: true,
            children: [
              { name: "one.md", path: "/tmp/a/wiki/sources/one.md", is_dir: false },
              { name: "two.md", path: "/tmp/a/wiki/sources/two.md", is_dir: false },
            ],
          },
        ]
      }
      return []
    })
    mocks.readFile.mockImplementation(async (path?: string) => {
      if (path === "/tmp/a/wiki/sources/one.md") return "---\nsources: [one.pdf]\n---\n# One\n"
      if (path === "/tmp/a/wiki/sources/two.md") return "---\nsources: [two.pdf]\n---\n# Two\n"
      if (path === "/tmp/a/wiki/log.md") return "# Wiki Log\n"
      return ""
    })
    mocks.cascadeDeleteWikiPagesWithRefs.mockResolvedValueOnce({
      deletedPaths: ["/tmp/a/wiki/sources/one.md", "/tmp/a/wiki/sources/two.md"],
      rewrittenFiles: 2,
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
          path: "raw/sources/one.pdf",
          kind: "deleted",
          status: "done",
          createdAt: 1,
          updatedAt: 1,
          retryCount: 0,
          needsRerun: false,
        },
        {
          id: "t2",
          projectId: "A",
          path: "raw/sources/two.pdf",
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
      expect(mocks.cascadeDeleteWikiPagesWithRefs).toHaveBeenCalledTimes(1)
    })
    expect(mocks.listDirectory.mock.calls.filter(([path]) => path === "/tmp/a/wiki")).toHaveLength(1)
  })
})
