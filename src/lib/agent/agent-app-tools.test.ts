import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"
import { useWikiStore } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore } from "@/stores/review-store"
import { runAgentAppTool } from "./agent-app-tools"

const fsMock = vi.hoisted(() => ({
  tree: [] as FileNode[],
  canonical: new Map<string, string>(),
  files: new Map<string, string>(),
}))

const ingestMock = vi.hoisted(() => ({
  autoIngest: vi.fn(),
  captionSourceImages: vi.fn(),
}))

const deepResearchMock = vi.hoisted(() => ({
  collectResearchSources: vi.fn(),
  queueResearch: vi.fn(),
  rewriteAnyTxtQueries: vi.fn(),
}))

const dedupRunnerMock = vi.hoisted(() => ({
  buildDedupLlmCall: vi.fn(),
  executeMerge: vi.fn(),
  loadAllWikiPages: vi.fn(),
  runDuplicateDetection: vi.fn(),
}))

const dedupMock = vi.hoisted(() => ({
  mergeDuplicateGroup: vi.fn(),
}))

const optimizeResearchTopicMock = vi.hoisted(() => ({
  optimizeResearchTopic: vi.fn(),
}))

const sweepReviewsMock = vi.hoisted(() => ({
  sweepResolvedReviews: vi.fn(),
}))

const connectionTestsMock = vi.hoisted(() => ({
  testLlmConnection: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  canonicalizePath: vi.fn(async (path: string) => fsMock.canonical.get(path) ?? path),
  listDirectory: vi.fn(async () => fsMock.tree),
  readFile: vi.fn(async (path: string) => {
    const value = fsMock.files.get(path)
    if (value === undefined) throw new Error(`missing file: ${path}`)
    return value
  }),
}))

vi.mock("@/lib/ingest", () => ({
  autoIngest: ingestMock.autoIngest,
  captionSourceImages: ingestMock.captionSourceImages,
}))

vi.mock("@/lib/deep-research", () => ({
  collectResearchSources: deepResearchMock.collectResearchSources,
  queueResearch: deepResearchMock.queueResearch,
  rewriteAnyTxtQueries: deepResearchMock.rewriteAnyTxtQueries,
}))

vi.mock("@/lib/dedup-runner", () => ({
  buildDedupLlmCall: dedupRunnerMock.buildDedupLlmCall,
  executeMerge: dedupRunnerMock.executeMerge,
  loadAllWikiPages: dedupRunnerMock.loadAllWikiPages,
  runDuplicateDetection: dedupRunnerMock.runDuplicateDetection,
}))

vi.mock("@/lib/dedup", () => ({
  mergeDuplicateGroup: dedupMock.mergeDuplicateGroup,
}))

vi.mock("@/lib/optimize-research-topic", () => ({
  optimizeResearchTopic: optimizeResearchTopicMock.optimizeResearchTopic,
}))

vi.mock("@/lib/sweep-reviews", () => ({
  sweepResolvedReviews: sweepReviewsMock.sweepResolvedReviews,
}))

vi.mock("@/lib/connection-tests", () => ({
  testLlmConnection: connectionTestsMock.testLlmConnection,
}))

describe("runAgentAppTool ingest parity tools", () => {
  beforeEach(() => {
    fsMock.tree = [{ name: "wiki", path: "/project/wiki", is_dir: true }]
    fsMock.canonical = new Map([["/project/raw/sources", "/project/raw/sources"]])
    fsMock.files = new Map([
      ["/project/wiki/overview.md", "# Overview"],
      ["/project/purpose.md", "# Purpose"],
    ])
    ingestMock.autoIngest.mockReset()
    ingestMock.captionSourceImages.mockReset()
    deepResearchMock.collectResearchSources.mockReset()
    deepResearchMock.queueResearch.mockReset()
    deepResearchMock.rewriteAnyTxtQueries.mockReset()
    dedupRunnerMock.buildDedupLlmCall.mockReset()
    dedupRunnerMock.executeMerge.mockReset()
    dedupRunnerMock.loadAllWikiPages.mockReset()
    dedupRunnerMock.runDuplicateDetection.mockReset()
    dedupMock.mergeDuplicateGroup.mockReset()
    optimizeResearchTopicMock.optimizeResearchTopic.mockReset()
    sweepReviewsMock.sweepResolvedReviews.mockReset()
    connectionTestsMock.testLlmConnection.mockReset()
    dedupRunnerMock.buildDedupLlmCall.mockReturnValue(vi.fn())
    useResearchStore.setState({ tasks: [], panelOpen: false })
    useReviewStore.setState({ items: [] })
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
      searchApiConfig: {
        provider: "none",
        apiKey: "",
        deepResearchSource: "web",
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

  it("collects research sources through configured app search services", async () => {
    deepResearchMock.rewriteAnyTxtQueries.mockResolvedValue(["local keywords"])
    deepResearchMock.collectResearchSources.mockResolvedValue({
      results: [{ title: "Source", url: "https://example.com", snippet: "hit", source: "web" }],
      errors: ["provider leaked search-key in body"],
    })
    useWikiStore.setState({
      searchApiConfig: {
        provider: "tavily",
        apiKey: "search-key",
        deepResearchSource: "both",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      },
    })

    const response = await runAgentAppTool("collect_research_sources", {
      topic: "winter ammonia",
      sourceMode: "both",
    })

    expect(deepResearchMock.rewriteAnyTxtQueries).toHaveBeenCalledWith(
      ["winter ammonia"],
      expect.objectContaining({ model: "gpt-test" }),
    )
    expect(deepResearchMock.collectResearchSources).toHaveBeenCalledWith(
      ["winter ammonia"],
      expect.objectContaining({ deepResearchSource: "both" }),
      "/project",
      undefined,
      { anyTxtQueries: ["local keywords"] },
    )
    expect(response.result).toEqual({
      queries: ["winter ammonia"],
      anyTxtQueries: ["local keywords"],
      sourceMode: "both",
      results: [{ title: "Source", url: "https://example.com", snippet: "hit", source: "web" }],
      errors: ["provider leaked REDACTED in body"],
    })
  })

  it("returns structured collect errors and falls back when AnyTXT rewrite fails", async () => {
    const unconfigured = await runAgentAppTool("collect_research_sources", {
      topic: "unconfigured",
    })
    expect(unconfigured.result).toEqual({
      queries: ["unconfigured"],
      sourceMode: "web",
      results: [],
      errors: ["Deep research source is not configured"],
    })

    deepResearchMock.rewriteAnyTxtQueries.mockRejectedValue(new Error("rewrite failed"))
    deepResearchMock.collectResearchSources.mockResolvedValue({ results: [], errors: [] })
    useWikiStore.setState({
      searchApiConfig: {
        provider: "none",
        apiKey: "",
        deepResearchSource: "anytxt",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      },
    })

    await runAgentAppTool("collect_research_sources", {
      topic: "fallback",
      sourceMode: "anytxt",
    })

    expect(deepResearchMock.collectResearchSources).toHaveBeenLastCalledWith(
      ["fallback"],
      expect.objectContaining({ deepResearchSource: "anytxt" }),
      "/project",
      undefined,
      { anyTxtQueries: undefined },
    )
  })

  it("starts deep research and exposes task status", async () => {
    deepResearchMock.queueResearch.mockReturnValue("research-42")
    useWikiStore.setState({
      searchApiConfig: {
        provider: "tavily",
        apiKey: "search-key",
        deepResearchSource: "web",
      },
    })

    const started = await runAgentAppTool("run_deep_research", {
      topic: "membrane bioreactor",
      searchQueries: ["MBR winter"],
    })

    expect(deepResearchMock.queueResearch).toHaveBeenCalledWith(
      "/project",
      "membrane bioreactor",
      expect.objectContaining({ model: "gpt-test" }),
      expect.objectContaining({ provider: "tavily" }),
      ["MBR winter"],
    )
    expect(started.result).toEqual({
      taskId: "research-42",
      status: "queued",
      topic: "membrane bioreactor",
      searchQueries: ["MBR winter"],
      sourceMode: "web",
    })

    useResearchStore.setState({
      tasks: [{
        id: "research-42",
        topic: "membrane bioreactor",
        status: "done",
        searchQueries: ["MBR winter"],
        webResults: [{ title: "Source", url: "https://example.com", snippet: "hit", source: "web" }],
        synthesis: "summary",
        savedPath: "wiki/queries/research-mbr.md",
        error: "failed with search-key",
        createdAt: 123,
      }],
    })

    const status = await runAgentAppTool("get_agent_task_status", {
      taskId: "research-42",
    })

    expect(status.result).toEqual({
      taskId: "research-42",
      topic: "membrane bioreactor",
      status: "done",
      searchQueries: ["MBR winter"],
      sourceCount: 1,
      synthesis: "summary",
      savedPath: "wiki/queries/research-mbr.md",
      error: "failed with REDACTED",
      createdAt: 123,
    })

    const missing = await runAgentAppTool("get_agent_task_status", {
      taskId: "missing-task",
    })

    expect(missing.result).toEqual({
      taskId: "missing-task",
      status: "missing",
      error: "Agent task not found",
    })

    deepResearchMock.queueResearch.mockClear()
    deepResearchMock.queueResearch.mockReturnValue("research-queries-only")
    const queriesOnly = await runAgentAppTool("run_deep_research", {
      queries: ["query topic", "extra query"],
    })

    expect(deepResearchMock.queueResearch).toHaveBeenCalledWith(
      "/project",
      "query topic",
      expect.objectContaining({ model: "gpt-test" }),
      expect.objectContaining({ provider: "tavily" }),
      ["query topic", "extra query"],
    )
    expect(queriesOnly.result).toEqual({
      taskId: "research-queries-only",
      status: "queued",
      topic: "query topic",
      searchQueries: ["query topic", "extra query"],
      sourceMode: "web",
    })
  })

  it("returns a structured error when deep research sources are not configured", async () => {
    const response = await runAgentAppTool("run_deep_research", {
      topic: "unconfigured",
    })

    expect(deepResearchMock.queueResearch).not.toHaveBeenCalled()
    expect(response.result).toEqual({
      taskId: null,
      status: "error",
      error: "Deep research source is not configured",
    })
  })

  it("rejects invalid sourceMode values in app tool args", async () => {
    await expect(
      runAgentAppTool("collect_research_sources", {
        topic: "bad mode",
        sourceMode: "files",
      }),
    ).rejects.toThrow(/sourceMode/)
  })

  it("rejects research tools without a topic or query seed", async () => {
    await expect(
      runAgentAppTool("collect_research_sources", {
        searchQueries: ["  "],
      }),
    ).rejects.toThrow(/topic or at least one searchQueries\/queries/)
    await expect(
      runAgentAppTool("run_deep_research", {
        queries: [],
      }),
    ).rejects.toThrow(/topic or at least one searchQueries\/queries/)
  })

  it("detects duplicate groups with a bounded result set", async () => {
    dedupRunnerMock.runDuplicateDetection.mockResolvedValue([
      { slugs: ["a", "b"], reason: "same", confidence: "high" },
      { slugs: ["c", "d"], reason: "same", confidence: "medium" },
    ])

    const response = await runAgentAppTool("detect_duplicates", { limit: 1 })

    expect(dedupRunnerMock.runDuplicateDetection).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ model: "gpt-test" }),
    )
    expect(response.result).toEqual({
      groups: [{ slugs: ["a", "b"], reason: "same", confidence: "high" }],
      totalGroups: 2,
    })
  })

  it("dry-runs duplicate merge without writing and summarizes the plan", async () => {
    dedupRunnerMock.loadAllWikiPages.mockResolvedValue([
      { path: "wiki/entities/a.md", content: "---\ntitle: A\n---\nA" },
      { path: "wiki/entities/b.md", content: "---\ntitle: B\n---\nB" },
      { path: "wiki/index.md", content: "- [[a]]\n- [[b]]" },
    ])
    dedupMock.mergeDuplicateGroup.mockResolvedValue({
      canonicalPath: "wiki/entities/a.md",
      canonicalContent: "---\ntitle: A\n---\nMerged",
      rewrites: [{ path: "wiki/index.md", newContent: "- [[a]]" }],
      pagesToDelete: ["wiki/entities/b.md"],
      backup: [
        { path: "wiki/entities/a.md", content: "A" },
        { path: "wiki/entities/b.md", content: "B" },
      ],
    })

    const response = await runAgentAppTool("merge_duplicate_group", {
      group: { slugs: ["a", "b"], reason: "same", confidence: "high" },
      canonicalSlug: "a",
    })

    expect(dedupRunnerMock.executeMerge).not.toHaveBeenCalled()
    expect(dedupMock.mergeDuplicateGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalSlug: "a",
        group: [
          { slug: "a", path: "wiki/entities/a.md", content: "---\ntitle: A\n---\nA" },
          { slug: "b", path: "wiki/entities/b.md", content: "---\ntitle: B\n---\nB" },
        ],
      }),
      expect.any(Function),
    )
    expect(response.wikiChanged).toEqual([])
    expect(response.result).toMatchObject({
      dryRun: true,
      canonicalPath: "wiki/entities/a.md",
      rewrites: [{ path: "wiki/index.md", bytes: 7 }],
      pagesToDelete: ["wiki/entities/b.md"],
      backupPaths: ["wiki/entities/a.md", "wiki/entities/b.md"],
    })
    expect(useWikiStore.getState().dataVersion).toBe(0)
  })

  it("executes duplicate merge only when dryRun is false and refreshes wiki state", async () => {
    dedupRunnerMock.executeMerge.mockResolvedValue({
      canonicalPath: "wiki/entities/a.md",
      canonicalContent: "Merged",
      rewrites: [{ path: "wiki/overview.md", newContent: "Overview" }],
      pagesToDelete: ["wiki/entities/b.md"],
      backup: [],
    })

    const response = await runAgentAppTool("merge_duplicate_group", {
      slugs: ["a", "b"],
      canonicalSlug: "a",
      dryRun: false,
    })

    expect(dedupRunnerMock.executeMerge).toHaveBeenCalledWith(
      "/project",
      { slugs: ["a", "b"], reason: "", confidence: "low" },
      "a",
      expect.objectContaining({ model: "gpt-test" }),
    )
    expect(response.wikiChanged).toEqual([
      { path: "wiki/entities/a.md", operation: "update" },
      { path: "wiki/overview.md", operation: "update" },
      { path: "wiki/entities/b.md", operation: "delete" },
    ])
    expect(useWikiStore.getState().fileTree).toEqual(fsMock.tree)
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })

  it("optimizes research topics with project context files", async () => {
    optimizeResearchTopicMock.optimizeResearchTopic.mockResolvedValue({
      topic: "better topic",
      searchQueries: ["q1", "q2"],
    })

    const response = await runAgentAppTool("optimize_research_topic", {
      gapTitle: "gap",
      gapDescription: "desc",
      gapType: "missing-page",
    })

    expect(optimizeResearchTopicMock.optimizeResearchTopic).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-test" }),
      "gap",
      "desc",
      "missing-page",
      "# Overview",
      "# Purpose",
    )
    expect(response.result).toEqual({ topic: "better topic", searchQueries: ["q1", "q2"] })
  })

  it("sweeps reviews and reports before/after counts", async () => {
    useReviewStore.setState({
      items: [
        {
          id: "r1",
          type: "missing-page",
          title: "Missing",
          description: "",
          options: [],
          resolved: false,
          createdAt: 1,
        },
        {
          id: "r2",
          type: "duplicate",
          title: "Dup",
          description: "",
          options: [],
          resolved: true,
          createdAt: 2,
        },
      ],
    })
    sweepReviewsMock.sweepResolvedReviews.mockImplementation(async () => {
      useReviewStore.setState({
        items: useReviewStore.getState().items.map((item) =>
          item.id === "r1" ? { ...item, resolved: true, resolvedAction: "auto-resolved" } : item,
        ),
      })
      return 1
    })

    const response = await runAgentAppTool("sweep_reviews", {})

    expect(sweepReviewsMock.sweepResolvedReviews).toHaveBeenCalledWith("/project")
    expect(response.result).toEqual({
      resolvedCount: 1,
      pendingBefore: 1,
      pendingAfter: 0,
      totalReviews: 2,
    })
  })

  it("tests provider connection and redacts configured secrets", async () => {
    useWikiStore.setState({
      llmConfig: {
        ...useWikiStore.getState().llmConfig,
        apiKey: "llm-secret",
      },
    })
    connectionTestsMock.testLlmConnection.mockResolvedValue({
      ok: false,
      message: "provider rejected llm-secret",
    })

    const response = await runAgentAppTool("test_provider_connection", {})

    expect(connectionTestsMock.testLlmConnection).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "llm-secret" }),
    )
    expect(response.result).toEqual({
      ok: false,
      message: "provider rejected REDACTED",
    })
  })
})
