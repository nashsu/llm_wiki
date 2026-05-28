import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { useWikiStore } from "@/stores/wiki-store"
import { runAgentAppTool } from "./agent-app-tools"

const fsMock = vi.hoisted(() => ({
  tree: [] as FileNode[],
  canonical: new Map<string, string>(),
}))

const ingestMock = vi.hoisted(() => ({
  autoIngest: vi.fn(),
  captionSourceImages: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  canonicalizePath: vi.fn(async (path: string) => fsMock.canonical.get(path) ?? path),
  listDirectory: vi.fn(async () => fsMock.tree),
}))

vi.mock("@/lib/ingest", () => ({
  autoIngest: ingestMock.autoIngest,
  captionSourceImages: ingestMock.captionSourceImages,
}))

describe("runAgentAppTool ingest parity tools", () => {
  beforeEach(() => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true }]
    fsMock.canonical = new Map([["/project/raw/sources", "/project/raw/sources"]])
    ingestMock.autoIngest.mockReset()
    ingestMock.captionSourceImages.mockReset()
    useWikiStore.setState({
      project: { id: "p1", name: "Project", path: "/project" },
      fileTree: [],
      dataVersion: 0,
      llmConfig: {
        provider: "openai",
        apiKey: "",
        maxContextSize: 204800,
        model: "gpt-test",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        azureApiVersion: "2024-10-21",
        reasoning: { mode: "auto" },
      },
    })
  })

  it("runs ingest_source through autoIngest and reports changed wiki paths", async () => {
    ingestMock.autoIngest.mockResolvedValue(["wiki/sources/source.md", "wiki/entities/topic.md"])

    const response = await runAgentAppTool("ingest_source", {
      sourcePath: "source.pdf",
      folderContext: "folder note",
    })

    expect(ingestMock.autoIngest).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/source.pdf",
      expect.objectContaining({ model: "gpt-test" }),
      undefined,
      "folder note",
    )
    expect(response.result).toEqual({
      sourcePath: "/project/raw/sources/source.pdf",
      writtenPaths: ["wiki/sources/source.md", "wiki/entities/topic.md"],
      filesWritten: 2,
    })
    expect(response.changedPaths).toBeUndefined()
    expect(response.wikiChanged).toEqual([
      { path: "wiki/sources/source.md", operation: "update" },
      { path: "wiki/entities/topic.md", operation: "update" },
    ])
    expect(useWikiStore.getState().fileTree).toEqual(fsMock.tree)
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })

  it("runs caption_source_images and rejects absolute paths outside project", async () => {
    ingestMock.captionSourceImages.mockResolvedValue({
      sourcePath: "/project/raw/sources/source.pdf",
      sourceIdentity: "source.pdf",
      sourceSummaryPath: "wiki/sources/source.md",
      imagesFound: 2,
      freshCaptions: 1,
      cachedCaptions: 1,
      failed: 0,
      multimodalEnabled: true,
      sourceSummaryUpdated: true,
      embeddingRecommended: true,
    })

    const response = await runAgentAppTool("caption_source_images", {
      sourcePath: "raw/sources/source.pdf",
      forceRecaption: true,
    })

    expect(ingestMock.captionSourceImages).toHaveBeenCalledWith(
      "/project",
      "/project/raw/sources/source.pdf",
      expect.objectContaining({ model: "gpt-test" }),
      undefined,
      true,
    )
    expect(response.wikiChanged).toEqual([
      { path: "wiki/sources/source.md", operation: "update" },
    ])
    await expect(
      runAgentAppTool("caption_source_images", { sourcePath: "/tmp/source.pdf" }),
    ).rejects.toThrow(/inside the active project/)
    await expect(
      runAgentAppTool("ingest_source", { sourcePath: "../../../secrets.txt" }),
    ).rejects.toThrow(/traversal/)
    await expect(
      runAgentAppTool("ingest_source", { sourcePath: "/project/raw/sources/../secrets.txt" }),
    ).rejects.toThrow(/traversal/)
  })

  it("rejects source paths that canonicalize outside raw/sources", async () => {
    fsMock.canonical = new Map([
      ["/project/raw/sources", "/project/raw/sources"],
      ["/project/raw/sources/link.pdf", "/tmp/secret.pdf"],
    ])

    await expect(
      runAgentAppTool("ingest_source", { sourcePath: "link.pdf" }),
    ).rejects.toThrow(/resolve inside raw\/sources/)
  })
})
