import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  fileExists: vi.fn(),
  getFileMd5: vi.fn(),
  getFileSize: vi.fn(),
  listDirectory: vi.fn(),
  preprocessFile: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  enqueueSourceIngest: vi.fn(),
  deleteSourceFile: vi.fn(),
  discardTasksForSources: vi.fn(),
  isIngestableSourcePath: vi.fn(),
  loadScheduledImportConfig: vi.fn(),
  saveScheduledImportConfig: vi.fn(),
  getRecentProjects: vi.fn(),
  loadSourceWatchConfig: vi.fn(),
  enqueueInactiveProjectBatch: vi.fn(),
  folderContextForSourcePath: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  copyFile: mocks.copyFile,
  fileExists: mocks.fileExists,
  getFileMd5: mocks.getFileMd5,
  getFileSize: mocks.getFileSize,
  listDirectory: mocks.listDirectory,
  preprocessFile: mocks.preprocessFile,
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("@/lib/source-lifecycle", () => ({
  deleteSourceFile: mocks.deleteSourceFile,
  enqueueSourceIngest: mocks.enqueueSourceIngest,
  folderContextForSourcePath: mocks.folderContextForSourcePath,
  isIngestableSourcePath: mocks.isIngestableSourcePath,
}))

vi.mock("@/lib/ingest-queue", () => ({
  discardTasksForSources: mocks.discardTasksForSources,
  enqueueInactiveProjectBatch: mocks.enqueueInactiveProjectBatch,
}))

vi.mock("@/lib/project-store", () => ({
  loadScheduledImportConfig: mocks.loadScheduledImportConfig,
  saveScheduledImportConfig: mocks.saveScheduledImportConfig,
  getRecentProjects: mocks.getRecentProjects,
  loadSourceWatchConfig: mocks.loadSourceWatchConfig,
}))

import {
  isProjectManagedScheduledImportPath,
  resolveImportPath,
  scheduledImportDestinationForFile,
  scanAndImport,
  isScheduledImportDue,
  shouldSkipScheduledImportConfigFile,
  shouldSkipScheduledImportFile,
} from "./scheduled-import"
import { useWikiStore } from "@/stores/wiki-store"

describe("scheduled import path handling", () => {
  const projectPath = "/Users/me/wiki-project"

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRecentProjects.mockResolvedValue([])
  })

  it("runs scheduled imports only after their configured interval", () => {
    const config = {
      enabled: true,
      path: "/Users/me/inbox",
      interval: 30,
      lastScan: 1_000,
    }
    expect(isScheduledImportDue(config, 1_000 + 29 * 60_000)).toBe(false)
    expect(isScheduledImportDue(config, 1_000 + 30 * 60_000)).toBe(true)
    expect(isScheduledImportDue({ ...config, enabled: false }, Number.MAX_SAFE_INTEGER)).toBe(false)
  })

  it("resolves relative paths from the project root", () => {
    expect(resolveImportPath("C:/Users/me/wiki", "raw/sources")).toBe(
      "C:/Users/me/wiki/raw/sources",
    )
    expect(resolveImportPath("/Users/me/wiki", "/Users/me/inbox")).toBe(
      "/Users/me/inbox",
    )
    expect(resolveImportPath("C:/Users/me/wiki", "//server/share/input")).toBe(
      "//server/share/input",
    )
  })

  it("preserves nested relative paths for external directories", () => {
    const dest = scheduledImportDestinationForFile(
      projectPath,
      "/Users/me/inbox",
      {
        name: "report.pdf",
        path: "/Users/me/inbox/a/report.pdf",
      },
    )

    expect(dest).toBe(
      "/Users/me/wiki-project/raw/sources/scheduled-import/a/report.pdf",
    )
  })

  it("preserves nested relative paths when the import root differs only in case (Windows)", () => {
    const dest = scheduledImportDestinationForFile(
      "C:/Users/Me/Wiki",
      "C:/Users/Me/Inbox",
      {
        name: "report.pdf",
        path: "c:/users/me/inbox/sub/report.pdf",
      },
    )

    expect(dest).toBe(
      "C:/Users/Me/Wiki/raw/sources/scheduled-import/sub/report.pdf",
    )
  })

  it("does not copy files that are already under raw/sources", () => {
    const dest = scheduledImportDestinationForFile(
      projectPath,
      `${projectPath}/raw/sources`,
      {
        name: "source.md",
        path: `${projectPath}/raw/sources/source.md`,
      },
    )

    expect(dest).toBe(`${projectPath}/raw/sources/source.md`)
  })

  it("detects scheduled import paths managed by the project itself", () => {
    expect(isProjectManagedScheduledImportPath(projectPath, projectPath)).toBe(true)
    expect(
      isProjectManagedScheduledImportPath(projectPath, `${projectPath}/raw/sources`),
    ).toBe(true)
    expect(
      isProjectManagedScheduledImportPath(projectPath, `${projectPath}/raw`),
    ).toBe(true)
    expect(
      isProjectManagedScheduledImportPath(projectPath, `${projectPath}/wiki`),
    ).toBe(true)
    expect(
      isProjectManagedScheduledImportPath(projectPath, `${projectPath}/.llm-wiki`),
    ).toBe(true)
    expect(
      isProjectManagedScheduledImportPath(projectPath, "/Users/me"),
    ).toBe(true)
    expect(
      isProjectManagedScheduledImportPath(projectPath, "/Users/me/inbox"),
    ).toBe(false)
  })

  it("detects Windows project paths case-insensitively", () => {
    expect(
      isProjectManagedScheduledImportPath(
        "C:/Users/Me/Wiki",
        "c:\\users\\me\\wiki\\raw\\sources",
      ),
    ).toBe(true)
    expect(
      isProjectManagedScheduledImportPath(
        "//Server/Share/Wiki",
        "//server/share/wiki/raw/sources",
      ),
    ).toBe(true)
    expect(
      isProjectManagedScheduledImportPath(
        "/Users/Me/Wiki",
        "/users/me/wiki/raw/sources",
      ),
    ).toBe(false)
  })

  it("sanitizes Windows-unsafe destination path segments with a stable suffix", () => {
    const dest = scheduledImportDestinationForFile(
      projectPath,
      "/Users/me/inbox",
      {
        name: "ignored.md",
        path: "/Users/me/inbox/CON/Article: Why?.md",
      },
    )

    expect(dest).toMatch(
      /^\/Users\/me\/wiki-project\/raw\/sources\/scheduled-import\/_CON\/Article_ Why_-[a-z0-9]+\.md$/,
    )
  })

  it("skips project internals and generated wiki/cache files", () => {
    expect(
      shouldSkipScheduledImportFile(projectPath, `${projectPath}/.llm-wiki/db.json`),
    ).toBe(true)
    expect(
      shouldSkipScheduledImportFile(projectPath, `${projectPath}/wiki/index.md`),
    ).toBe(true)
    expect(
      shouldSkipScheduledImportFile(
        projectPath,
        `${projectPath}/raw/sources/.cache/source.pdf.txt`,
      ),
    ).toBe(true)
  })

  it("skips config-like files for unattended scheduled import", () => {
    expect(shouldSkipScheduledImportConfigFile("/Users/me/inbox/data.json")).toBe(true)
    expect(shouldSkipScheduledImportConfigFile("/Users/me/inbox/secrets.yaml")).toBe(true)
    expect(shouldSkipScheduledImportConfigFile("/Users/me/inbox/settings.yml")).toBe(true)
    expect(shouldSkipScheduledImportConfigFile("/Users/me/inbox/config.xml")).toBe(true)
    expect(shouldSkipScheduledImportConfigFile("/Users/me/inbox/notes.md")).toBe(false)
  })
})

describe("scanAndImport failure handling", () => {
  const project: WikiProject = {
    id: "project-1",
    name: "Project",
    path: "/Users/me/wiki-project",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    useWikiStore.setState({
      project,
      sourceWatchConfig: {
        enabled: true,
        autoIngest: true,
        persistExtractedMarkdown: true,
        parsingConcurrency: 2,
        ingestConcurrency: 2,
        includeExtensions: [],
        excludeExtensions: [],
        excludeDirs: [],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
      llmConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-test",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 1000,
      },
    })
    mocks.fileExists.mockResolvedValue(false)
    mocks.readFile.mockResolvedValue("")
    mocks.getFileSize.mockResolvedValue(1024)
    mocks.getFileMd5.mockResolvedValue("md5-new")
    mocks.copyFile.mockResolvedValue(undefined)
    mocks.deleteSourceFile.mockResolvedValue({
      deletedWikiPaths: [],
      rewrittenSourcePages: 0,
    })
    mocks.discardTasksForSources.mockResolvedValue(0)
    mocks.preprocessFile.mockResolvedValue("")
    mocks.isIngestableSourcePath.mockReturnValue(true)
    mocks.loadScheduledImportConfig.mockResolvedValue({
      enabled: true,
      path: "/Users/me/inbox",
      interval: 60,
      lastScan: null,
    })
    mocks.loadSourceWatchConfig.mockResolvedValue(
      useWikiStore.getState().sourceWatchConfig,
    )
    mocks.saveScheduledImportConfig.mockResolvedValue(undefined)
    mocks.enqueueInactiveProjectBatch.mockResolvedValue(["background-task-1"])
    mocks.folderContextForSourcePath.mockReturnValue("scheduled-import")
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.listDirectory.mockImplementation(async (path: string) => {
      if (path === "/Users/me/inbox") {
        return [
          {
            name: "paper.pdf",
            path: "/Users/me/inbox/paper.pdf",
            is_dir: false,
          },
        ]
      }
      return []
    })
  })

  it("does not mark changed files imported when enqueue fails", async () => {
    mocks.enqueueSourceIngest.mockRejectedValue(new Error("queue stopped"))

    await scanAndImport(project, "/Users/me/inbox")

    expect(mocks.copyFile).toHaveBeenCalled()
    expect(mocks.enqueueSourceIngest).toHaveBeenCalled()
    expect(mocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("reuses legacy mixed-case Windows database keys after upgrade", async () => {
    const windowsProject: WikiProject = {
      id: "windows-project",
      name: "Windows Project",
      path: "C:/Users/Me/Wiki",
    }
    useWikiStore.setState({ project: windowsProject })
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      directories: {
        "C:/Users/Me/Inbox": {
          files: {
            "C:/Users/Me/Inbox/Paper.pdf": "md5-new",
          },
          lastScan: 123,
        },
      },
    }))
    mocks.listDirectory.mockResolvedValue([
      {
        name: "Paper.pdf",
        path: "c:/users/me/inbox/paper.pdf",
        is_dir: false,
      },
    ])

    await scanAndImport(windowsProject, "c:/users/me/inbox")

    expect(mocks.copyFile).not.toHaveBeenCalled()
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "C:/Users/Me/Wiki/.llm-wiki/scheduled-import-db.json",
      expect.stringContaining('"c:/users/me/inbox/paper.pdf": "md5-new"'),
    )
  })

  it("does not leave the scanner locked after a managed project path is skipped", async () => {
    await scanAndImport(project, `${project.path}/raw/sources`)
    await scanAndImport(project, "/Users/me/inbox")

    expect(mocks.listDirectory).toHaveBeenCalledWith("/Users/me/inbox")
  })

  it("continues scanning when one file is locked or unreadable", async () => {
    mocks.listDirectory.mockResolvedValueOnce([
      { name: "locked.pdf", path: "/Users/me/inbox/locked.pdf", is_dir: false },
      { name: "ok.pdf", path: "/Users/me/inbox/ok.pdf", is_dir: false },
    ])
    mocks.getFileMd5
      .mockRejectedValueOnce(new Error("sharing violation"))
      .mockResolvedValueOnce("ok-md5")
    mocks.enqueueSourceIngest.mockResolvedValue(["task-1"])

    await scanAndImport(project, "/Users/me/inbox")

    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(
      project,
      ["/Users/me/wiki-project/raw/sources/scheduled-import/ok.pdf"],
      expect.any(Object),
    )
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
  })

  it("copies and durably queues changed files for an inactive project", async () => {
    useWikiStore.setState({
      project: {
        id: "active-project",
        name: "Active",
        path: "/Users/me/active-project",
      },
    })

    await scanAndImport(project, "/Users/me/inbox", { allowInactive: true })

    const destination = "/Users/me/wiki-project/raw/sources/scheduled-import/paper.pdf"
    expect(mocks.copyFile).toHaveBeenCalledWith("/Users/me/inbox/paper.pdf", destination)
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
    expect(mocks.enqueueInactiveProjectBatch).toHaveBeenCalledWith(
      project.id,
      project.path,
      [{ sourcePath: destination, folderContext: "scheduled-import" }],
    )
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/Users/me/wiki-project/.llm-wiki/scheduled-import-db.json",
      expect.stringContaining('"/Users/me/inbox/paper.pdf": "md5-new"'),
    )
  })

  it("skips large files before hashing or copying", async () => {
    mocks.getFileSize.mockResolvedValue(101 * 1024 * 1024)

    await scanAndImport(project, "/Users/me/inbox")

    expect(mocks.getFileMd5).not.toHaveBeenCalled()
    expect(mocks.copyFile).not.toHaveBeenCalled()
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("does not copy unattended json/yaml/xml config files", async () => {
    mocks.listDirectory.mockResolvedValueOnce([
      { name: "secrets.yaml", path: "/Users/me/inbox/secrets.yaml", is_dir: false },
      { name: "notes.md", path: "/Users/me/inbox/notes.md", is_dir: false },
    ])
    mocks.enqueueSourceIngest.mockResolvedValue(["task-1"])

    await scanAndImport(project, "/Users/me/inbox")

    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/Users/me/inbox/notes.md",
      "/Users/me/wiki-project/raw/sources/scheduled-import/notes.md",
    )
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/Users/me/inbox/secrets.yaml", expect.anything())
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(
      project,
      ["/Users/me/wiki-project/raw/sources/scheduled-import/notes.md"],
      expect.any(Object),
    )
  })

  it("removes mirrors and derived knowledge for deleted scheduled sources", async () => {
    mocks.fileExists.mockImplementation(async (path: string) =>
      path.endsWith("scheduled-import-db.json") || path.endsWith("scheduled-import/old.pdf")
    )
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      directories: {
        "/Users/me/inbox": {
          files: { "/Users/me/inbox/old.pdf": "old-md5" },
          lastScan: 123,
        },
      },
    }))
    mocks.listDirectory.mockResolvedValue([])

    await scanAndImport(project, "/Users/me/inbox")

    const mirror = "/Users/me/wiki-project/raw/sources/scheduled-import/old.pdf"
    expect(mocks.discardTasksForSources).toHaveBeenCalledWith([mirror])
    expect(mocks.deleteSourceFile).toHaveBeenCalledWith(project.path, mirror, {
      fileAlreadyDeleted: false,
      logReason: "scheduled import source removed or excluded",
    })
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/Users/me/wiki-project/.llm-wiki/scheduled-import-db.json",
      expect.not.stringContaining("old.pdf"),
    )
  })

  it("keeps an existing source record when the file is temporarily unreadable", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      directories: {
        "/Users/me/inbox": {
          files: { "/Users/me/inbox/paper.pdf": "old-md5" },
          lastScan: 123,
        },
      },
    }))
    mocks.getFileMd5.mockRejectedValue(new Error("sharing violation"))

    await scanAndImport(project, "/Users/me/inbox")

    expect(mocks.deleteSourceFile).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      "/Users/me/wiki-project/.llm-wiki/scheduled-import-db.json",
      expect.stringContaining('"/Users/me/inbox/paper.pdf": "old-md5"'),
    )
  })

  it("cleans a previously imported file that is now excluded", async () => {
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      directories: {
        "/Users/me/inbox": {
          files: { "/Users/me/inbox/settings.json": "old-md5" },
          lastScan: 123,
        },
      },
    }))
    mocks.listDirectory.mockResolvedValue([
      { name: "settings.json", path: "/Users/me/inbox/settings.json", is_dir: false },
    ])

    await scanAndImport(project, "/Users/me/inbox")

    expect(mocks.deleteSourceFile).toHaveBeenCalledWith(
      project.path,
      "/Users/me/wiki-project/raw/sources/scheduled-import/settings.json",
      expect.any(Object),
    )
  })

  it("cleans an imported source after a source-watch directory exclusion is added", async () => {
    useWikiStore.setState({
      sourceWatchConfig: {
        ...useWikiStore.getState().sourceWatchConfig,
        excludeDirs: ["archive"],
      },
    })
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      directories: {
        "/Users/me/inbox": {
          files: { "/Users/me/inbox/archive/old.pdf": "old-md5" },
          lastScan: 123,
        },
      },
    }))
    mocks.listDirectory.mockResolvedValue([
      {
        name: "archive",
        path: "/Users/me/inbox/archive",
        is_dir: true,
        children: [
          {
            name: "old.pdf",
            path: "/Users/me/inbox/archive/old.pdf",
            is_dir: false,
          },
        ],
      },
    ])

    await scanAndImport(project, "/Users/me/inbox")

    const mirror = "/Users/me/wiki-project/raw/sources/scheduled-import/archive/old.pdf"
    expect(mocks.discardTasksForSources).toHaveBeenCalledWith([mirror])
    expect(mocks.deleteSourceFile).toHaveBeenCalledWith(
      project.path,
      mirror,
      expect.objectContaining({
        logReason: "scheduled import source removed or excluded",
      }),
    )
  })

  it("applies an inactive project's persisted source-watch exclusions", async () => {
    useWikiStore.setState({
      project: {
        id: "active-project",
        name: "Active",
        path: "/Users/me/active-project",
      },
    })
    mocks.loadSourceWatchConfig.mockResolvedValue({
      ...useWikiStore.getState().sourceWatchConfig,
      excludeGlobs: ["*.draft.pdf"],
    })
    mocks.listDirectory.mockResolvedValue([
      {
        name: "paper.draft.pdf",
        path: "/Users/me/inbox/paper.draft.pdf",
        is_dir: false,
      },
    ])

    await scanAndImport(project, "/Users/me/inbox", { allowInactive: true })

    expect(mocks.loadSourceWatchConfig).toHaveBeenCalledWith(project.id)
    expect(mocks.getFileSize).not.toHaveBeenCalled()
    expect(mocks.copyFile).not.toHaveBeenCalled()
    expect(mocks.enqueueInactiveProjectBatch).not.toHaveBeenCalled()
  })

  it("uses the lower scheduled-import and source-watch file size limit", async () => {
    useWikiStore.setState({
      sourceWatchConfig: {
        ...useWikiStore.getState().sourceWatchConfig,
        maxFileSizeMb: 5,
      },
    })
    mocks.getFileSize.mockResolvedValue(6 * 1024 * 1024)

    await scanAndImport(project, "/Users/me/inbox")

    expect(mocks.getFileMd5).not.toHaveBeenCalled()
    expect(mocks.copyFile).not.toHaveBeenCalled()
  })
})
