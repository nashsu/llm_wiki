import { describe, expect, it, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  getFileSize: vi.fn(),
  listDirectory: vi.fn(),
  preprocessFile: vi.fn(),
  enqueueBatch: vi.fn(),
}))

vi.mock("@/commands/fs", async () => {
  const actual = await vi.importActual<typeof import("@/commands/fs")>("@/commands/fs")
  return {
    ...actual,
    copyFile: mocks.copyFile,
    createDirectory: mocks.createDirectory,
    deleteFile: mocks.deleteFile,
    fileExists: mocks.fileExists,
    getFileSize: mocks.getFileSize,
    listDirectory: mocks.listDirectory,
    preprocessFile: mocks.preprocessFile,
  }
})

vi.mock("@/lib/ingest-queue", () => ({
  enqueueBatch: mocks.enqueueBatch,
}))

import {
  enqueueSourceIngest,
  folderContextForSourcePath,
  importSourceFiles,
  importSourceFolder,
  isIngestableSourcePath,
} from "./source-lifecycle"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.deleteFile.mockResolvedValue(undefined)
  mocks.fileExists.mockResolvedValue(false)
  mocks.getFileSize.mockResolvedValue(1024)
  mocks.listDirectory.mockResolvedValue([])
  mocks.preprocessFile.mockResolvedValue("")
  mocks.enqueueBatch.mockResolvedValue(["task"])
})

describe("source-lifecycle path helpers", () => {
  it("does not treat preprocessed cache files as ingestable sources", () => {
    expect(isIngestableSourcePath("raw/sources/.cache/report.pdf.txt")).toBe(false)
    expect(isIngestableSourcePath("/project/raw/sources/.cache/report.pdf.txt")).toBe(false)
  })

  it("accepts supported ebook source formats", () => {
    expect(isIngestableSourcePath("raw/sources/book.epub")).toBe(true)
    expect(isIngestableSourcePath("C:\\project\\raw\\sources\\book.MOBI")).toBe(true)
  })

  it("derives folder context from absolute raw/sources paths without leaking the project prefix", () => {
    expect(
      folderContextForSourcePath("/tmp/project/raw/sources/reports/2026/report.pdf"),
    ).toBe("reports > 2026")
  })

  it("applies source watch exclusions during folder import before preprocess and ingest", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "keep.md", path: "/external/imported/keep.md", is_dir: false },
      { name: "config.json", path: "/external/imported/config.json", is_dir: false },
      {
        name: "drafts",
        path: "/external/imported/drafts",
        is_dir: true,
        children: [
          { name: "skip.md", path: "/external/imported/drafts/skip.md", is_dir: false },
        ],
      },
    ])

    const copied = await importSourceFolder(
      { id: "p1", name: "Project", path: "/project" },
      "/external/imported",
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md"],
        excludeExtensions: ["json"],
        excludeDirs: ["drafts"],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual(["/project/raw/sources/imported/keep.md"])
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.copyFile).toHaveBeenCalledWith("/external/imported/keep.md", "/project/raw/sources/imported/keep.md")
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/imported/config.json", expect.anything())
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/imported/drafts/skip.md", expect.anything())
    expect(mocks.deleteFile).not.toHaveBeenCalled()
    expect(mocks.preprocessFile).toHaveBeenCalledOnce()
    expect(mocks.preprocessFile).toHaveBeenCalledWith("/project/raw/sources/imported/keep.md")
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/imported/keep.md",
        folderContext: "imported",
      },
    ])
  })

  it("does not import config-like files from hidden tool folders", async () => {
    mocks.listDirectory.mockResolvedValue([
      {
        name: ".claude",
        path: "/external/imported/.claude",
        is_dir: true,
        children: [
          { name: "settings.json", path: "/external/imported/.claude/settings.json", is_dir: false },
          { name: "research.md", path: "/external/imported/.claude/research.md", is_dir: false },
        ],
      },
      {
        name: ".codex",
        path: "/external/imported/.codex",
        is_dir: true,
        children: [
          { name: "config.yaml", path: "/external/imported/.codex/config.yaml", is_dir: false },
        ],
      },
    ])

    const copied = await importSourceFolder(
      { id: "p1", name: "Project", path: "/project" },
      "/external/imported",
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["json", "yaml", "md"],
        excludeExtensions: [],
        excludeDirs: [],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual(["/project/raw/sources/imported/.claude/research.md"])
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/external/imported/.claude/research.md",
      "/project/raw/sources/imported/.claude/research.md",
    )
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/imported/.claude/settings.json", expect.anything())
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/imported/.codex/config.yaml", expect.anything())
  })

  it("rejects importing the project folder or folders inside it", async () => {
    await expect(
      importSourceFolder(
        { id: "p1", name: "Project", path: "/project" },
        "/project",
        {
          provider: "openai",
          endpoint: "https://api.example.com/v1",
          apiKey: "key",
          model: "model",
          customModel: "",
          reasoning: { enabled: false, effort: "low" },
        } as never,
      ),
    ).rejects.toThrow("Cannot import the project folder")

    await expect(
      importSourceFolder(
        { id: "p1", name: "Project", path: "/project" },
        "/project/raw/sources",
        {
          provider: "openai",
          endpoint: "https://api.example.com/v1",
          apiKey: "key",
          model: "model",
          customModel: "",
          reasoning: { enabled: false, effort: "low" },
        } as never,
      ),
    ).rejects.toThrow("Cannot import the project folder")

    expect(mocks.listDirectory).not.toHaveBeenCalled()
    expect(mocks.copyFile).not.toHaveBeenCalled()
  })

  it("filters single-file imports using the original source path before copying", async () => {
    const copied = await importSourceFiles(
      { id: "p1", name: "Project", path: "/project" },
      ["/external/drafts/spec.md", "/external/ready.md"],
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md"],
        excludeExtensions: [],
        excludeDirs: ["drafts"],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual(["/project/raw/sources/ready.md"])
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.copyFile).toHaveBeenCalledWith("/external/ready.md", "/project/raw/sources/ready.md")
    expect(mocks.copyFile).not.toHaveBeenCalledWith("/external/drafts/spec.md", expect.anything())
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/ready.md",
        folderContext: "",
      },
    ])
  })

  it("allows an explicitly selected ebook with an older watch include-list", async () => {
    const copied = await importSourceFiles(
      { id: "p1", name: "Project", path: "/project" },
      ["/external/book.epub"],
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md", "pdf"],
        excludeExtensions: [],
        excludeDirs: [],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual(["/project/raw/sources/book.epub"])
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/external/book.epub",
      "/project/raw/sources/book.epub",
    )
  })

  it("skips sensitive tool config files at the shared ingest enqueue boundary", async () => {
    const queued = await enqueueSourceIngest(
      { id: "p1", name: "Project", path: "/project" },
      [
        "/project/raw/sources/.claude/settings.json",
        "/project/raw/sources/.codex/config.yaml",
        "/project/raw/sources/notes.md",
      ],
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
    )

    expect(queued).toEqual(["task"])
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/notes.md",
        folderContext: "",
      },
    ])
  })

  it("naturally orders imported folder files before enqueueing ingest tasks", async () => {
    mocks.listDirectory.mockResolvedValue([
      { name: "10.md", path: "/external/imported/10.md", is_dir: false },
      { name: "2.md", path: "/external/imported/2.md", is_dir: false },
      { name: "1.md", path: "/external/imported/1.md", is_dir: false },
    ])

    const copied = await importSourceFolder(
      { id: "p1", name: "Project", path: "/project" },
      "/external/imported",
      {
        provider: "openai",
        endpoint: "https://api.example.com/v1",
        apiKey: "key",
        model: "model",
        customModel: "",
        reasoning: { enabled: false, effort: "low" },
      } as never,
      {
        enabled: true,
        autoIngest: true,
        includeExtensions: ["md"],
        excludeExtensions: [],
        excludeDirs: [],
        excludeGlobs: [],
        maxFileSizeMb: 100,
      },
    )

    expect(copied).toEqual([
      "/project/raw/sources/imported/1.md",
      "/project/raw/sources/imported/2.md",
      "/project/raw/sources/imported/10.md",
    ])
    expect(mocks.enqueueBatch).toHaveBeenCalledWith("p1", [
      {
        sourcePath: "/project/raw/sources/imported/1.md",
        folderContext: "imported",
      },
      {
        sourcePath: "/project/raw/sources/imported/2.md",
        folderContext: "imported",
      },
      {
        sourcePath: "/project/raw/sources/imported/10.md",
        folderContext: "imported",
      },
    ])
  })
})
