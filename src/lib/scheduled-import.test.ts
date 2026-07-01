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
  isIngestableSourcePath: vi.fn(),
  loadScheduledImportConfig: vi.fn(),
  saveScheduledImportConfig: vi.fn(),
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
  enqueueSourceIngest: mocks.enqueueSourceIngest,
  isIngestableSourcePath: mocks.isIngestableSourcePath,
}))

vi.mock("@/lib/project-store", () => ({
  loadScheduledImportConfig: mocks.loadScheduledImportConfig,
  saveScheduledImportConfig: mocks.saveScheduledImportConfig,
}))

import {
  isProjectManagedScheduledImportPath,
  resolveImportPath,
  scheduledImportDestinationForFile,
  scanAndImport,
  shouldSkipScheduledImportConfigFile,
  shouldSkipScheduledImportFile,
} from "./scheduled-import"
import { useWikiStore } from "@/stores/wiki-store"

describe("scheduled import path handling", () => {
  const projectPath = "/Users/me/wiki-project"

  beforeEach(() => {
    vi.clearAllMocks()
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
    mocks.preprocessFile.mockResolvedValue("")
    mocks.isIngestableSourcePath.mockReturnValue(true)
    mocks.loadScheduledImportConfig.mockResolvedValue({
      enabled: true,
      path: "/Users/me/inbox",
      interval: 60,
      lastScan: null,
    })
    mocks.saveScheduledImportConfig.mockResolvedValue(undefined)
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
})
