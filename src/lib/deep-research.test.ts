import { describe, expect, it, vi } from "vitest"
import {
  citedResearchSourceIndexes,
  addResearchTaskDiscriminator,
  buildResearchPageContent,
  collectResearchSources,
  filterResearchSourcesByRelevance,
  makeDeepResearchFileName,
  makeAvailableResearchFilePath,
  noResearchSourcesTaskPatch,
  rejectedResearchSourcesTaskPatch,
  researchRelevanceRequestOverrides,
  researchPageIdFromPath,
  resolveReviewForSavedResearch,
  validateResearchSynthesis,
} from "./deep-research"
import type { SearchApiConfig } from "@/stores/wiki-store"
import type { WebSearchResult } from "./web-search"
import { useWikiStore } from "@/stores/wiki-store"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"

const webResult: WebSearchResult = {
  title: "Web",
  url: "https://example.com/web",
  snippet: "web snippet",
  source: "example.com",
}

const localResult: WebSearchResult = {
  title: "Local",
  url: "file:///C:/docs/local.md",
  snippet: "local snippet",
  source: "AnyTXT",
}

function config(patch: Partial<SearchApiConfig>): SearchApiConfig {
  return {
    provider: "none",
    apiKey: "",
    ...patch,
  }
}

describe("makeDeepResearchFileName", () => {
  it("keeps Unicode topics and includes time to avoid same-day overwrite", () => {
    const first = makeDeepResearchFileName(
      "反硝化除磷",
      new Date("2026-06-06T10:00:00.000Z"),
    )
    const second = makeDeepResearchFileName(
      "反硝化除磷",
      new Date("2026-06-06T10:00:01.000Z"),
    )

    expect(first.fileName).toBe("research-反硝化除磷-2026-06-06-100000.md")
    expect(second.fileName).toBe("research-反硝化除磷-2026-06-06-100001.md")
    expect(first.fileName).not.toBe(second.fileName)
  })

  it("uses the local calendar date for frontmatter metadata", () => {
    const localMorning = new Date(2026, 5, 6, 1, 30, 0)

    expect(makeDeepResearchFileName("政策版本差异", localMorning).date).toBe("2026-06-06")
  })
})

describe("buildResearchPageContent", () => {
  it("normalizes path-prefixed page links without changing code or embeds", () => {
    const content = buildResearchPageContent(
      "AI research",
      "2026-08-20",
      [
        "See [[concepts/adaptation|adaptation]] and [[entities/person#work]].",
        "Keep `[[concepts/code-example]]` and ![[media/chart.png]].",
      ].join("\n"),
      "1. [Source](https://example.com)",
    )

    expect(content).toContain("[[adaptation|adaptation]]")
    expect(content).toContain("[[person#work]]")
    expect(content).toContain("`[[concepts/code-example]]`")
    expect(content).toContain("![[media/chart.png]]")
  })

  it("normalizes malformed citation wikilinks before saving", () => {
    const content = buildResearchPageContent(
      "Topic",
      "2026-09-27",
      "Evidence [[1]] and combined [[2], [3], [4]].",
      "1. [Source](https://example.test) — web",
    )
    expect(content).toContain("Evidence [1] and combined [2], [3], [4].")
  })

  it("keeps multiline topics inside one safe YAML scalar and heading", () => {
    const content = buildResearchPageContent(
      "first line\nsecond: \"quoted\"",
      "2026-08-20",
      "Substantive synthesis [1].",
      "1. [Source](https://example.com)",
    )
    expect(content).toContain('title: "Research: first line second: \\"quoted\\""')
    expect(content).toContain("# Research: first line second: \"quoted\"")
    expect(content).not.toContain("first line\nsecond")
  })
})

describe("makeAvailableResearchFilePath", () => {
  it("adds a suffix instead of overwriting a same-second research result", async () => {
    const existing = new Set([
      "/project/wiki/queries/research-topic-2026-08-20-120000.md",
      "/project/wiki/queries/research-topic-2026-08-20-120000-2.md",
    ])
    await expect(makeAvailableResearchFilePath(
      "/project/wiki/queries",
      "research-topic-2026-08-20-120000.md",
      async (path) => existing.has(path),
    )).resolves.toBe("/project/wiki/queries/research-topic-2026-08-20-120000-3.md")
  })

  it("gives concurrent tasks distinct readable filenames before existence checks", () => {
    const fileName = "research-topic-2026-08-20-120000.md"
    expect(addResearchTaskDiscriminator(fileName, "research-41"))
      .toBe("research-topic-2026-08-20-120000-research-41.md")
    expect(addResearchTaskDiscriminator(fileName, "research-42"))
      .not.toBe(addResearchTaskDiscriminator(fileName, "research-41"))
  })

  it("derives the vector page id from the final collision-safe path", () => {
    expect(researchPageIdFromPath(
      "/project/wiki/queries/research-topic-2026-08-20-120000-research-41-2.md",
    )).toBe("queries/research-topic-2026-08-20-120000-research-41-2")
    expect(researchPageIdFromPath("C:\\project\\wiki\\queries\\research-topic-3.MD"))
      .toBe("queries/research-topic-3")
  })
})

describe("validateResearchSynthesis", () => {
  const substantiveChinese = [
    "解离是一类涉及记忆、身份、意识与环境感知连续性受扰的心理现象。[1]",
    "现有研究通常区分短暂的正常体验与造成显著痛苦或功能损害的临床表现。评估时需要结合持续时间、诱因、共病情况以及对日常生活的影响，不能仅凭单一症状下结论。[2]",
    "不同理论模型对其机制仍有分歧，因此研究结论需要结合样本来源、测量工具与临床背景解释。现有证据更适合支持分层评估，而不是把单项自评结果直接视为诊断。",
  ].join("\n\n")

  it("rejects empty, reasoning-only, and short output", () => {
    expect(validateResearchSynthesis("", 2).valid).toBe(false)
    expect(validateResearchSynthesis("<think>private reasoning only</think>", 2).valid).toBe(false)
    expect(validateResearchSynthesis("## 概述\n\n内容很短。[1]", 2).valid).toBe(false)
  })

  it("accepts substantive Unicode prose with a valid citation", () => {
    const result = validateResearchSynthesis(substantiveChinese, 2)

    expect(result.valid).toBe(true)
    expect(result.citedSourceIndexes).toEqual([1, 2])
  })

  it("rejects substantive output that cites no collected source", () => {
    const result = validateResearchSynthesis(substantiveChinese.replace(/\[\d+\]/g, ""), 2)

    expect(result.valid).toBe(false)
    expect(result.error).toContain("did not cite")
  })

  it("extracts valid citation groups and bounded ranges", () => {
    expect(citedResearchSourceIndexes("Evidence [3, 1] and comparison [4-5], ignore [0] [8].", 5))
      .toEqual([1, 3, 4, 5])
  })
})

describe("noResearchSourcesTaskPatch", () => {
  it("marks source failures as an error instead of completed", () => {
    expect(noResearchSourcesTaskPatch(["Firecrawl blocked this IP", "AnyTXT offline"])).toEqual({
      status: "error",
      synthesis: "",
      error: "Firecrawl blocked this IP\nAnyTXT offline",
    })
  })

  it("marks an empty successful search as done", () => {
    expect(noResearchSourcesTaskPatch([])).toEqual({
      status: "done",
      synthesis: "No research sources found.",
      error: null,
    })
  })
})

describe("rejectedResearchSourcesTaskPatch", () => {
  it("reports rejected candidates and preserves source failures", () => {
    expect(rejectedResearchSourcesTaskPatch(2, ["Web provider timed out"])).toEqual({
      status: "error",
      synthesis: "",
      error: "2 candidate source(s) were found, but all were rejected by the relevance and evidence-quality gate. Refine the research topic or queries and retry.\nWeb provider timed out",
    })
  })
})

describe("review-linked research", () => {
  const review: ReviewItem = {
    id: "review-1",
    type: "suggestion",
    title: "Research this",
    description: "Needs evidence",
    options: [],
    resolved: false,
    createdAt: 1,
  }

  it("resolves the source review only after a saved result exists", () => {
    useWikiStore.setState({ project: { id: "p1", name: "Project", path: "/project" } })
    useReviewStore.setState({ items: [review] })
    useResearchStore.setState({
      tasks: [{
        id: "research-1",
        topic: "topic",
        sourceReviewId: review.id,
        status: "done",
        webResults: [],
        synthesis: "This completed synthesis contains enough substantive analysis to explain the evidence, its limitations, and the conclusions that can reasonably be drawn. It also distinguishes established findings from open questions so the saved research is useful for later review.",
        savedPath: "wiki/queries/research-topic.md",
        error: null,
        createdAt: 1,
      }],
    })

    expect(resolveReviewForSavedResearch(
      "/project",
      "research-1",
      "wiki/queries/research-topic.md",
    )).toBe(true)
    expect(useReviewStore.getState().items[0]).toMatchObject({
      resolved: true,
      resolvedAction: "Research saved: wiki/queries/research-topic.md",
    })
  })

  it("does not resolve another project's review", () => {
    useWikiStore.setState({ project: { id: "p2", name: "Other", path: "/other" } })
    useReviewStore.setState({ items: [review] })
    useResearchStore.setState({
      tasks: [{
        id: "research-1",
        topic: "topic",
        sourceReviewId: review.id,
        status: "done",
        webResults: [],
        synthesis: "answer",
        savedPath: "wiki/queries/research-topic.md",
        error: null,
        createdAt: 1,
      }],
    })

    expect(resolveReviewForSavedResearch(
      "/project",
      "research-1",
      "wiki/queries/research-topic.md",
    )).toBe(false)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("rejects callbacks before the linked task reaches the matching saved state", () => {
    useWikiStore.setState({ project: { id: "p1", name: "Project", path: "/project" } })
    useReviewStore.setState({ items: [review] })
    useResearchStore.setState({
      tasks: [{
        id: "research-1",
        topic: "topic",
        sourceReviewId: review.id,
        status: "saving",
        webResults: [],
        synthesis: "answer",
        savedPath: null,
        error: null,
        createdAt: 1,
      }],
    })

    expect(resolveReviewForSavedResearch(
      "/project",
      "research-1",
      "wiki/queries/research-topic.md",
    )).toBe(false)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })

  it("does not resolve a saved task with incomplete synthesis", () => {
    useWikiStore.setState({ project: { id: "p1", name: "Project", path: "/project" } })
    useReviewStore.setState({ items: [review] })
    useResearchStore.setState({
      tasks: [{
        id: "research-1",
        topic: "topic",
        sourceReviewId: review.id,
        status: "done",
        webResults: [webResult],
        synthesis: "[1]",
        savedPath: "wiki/queries/research-topic.md",
        error: null,
        createdAt: 1,
      }],
    })

    expect(resolveReviewForSavedResearch(
      "/project",
      "research-1",
      "wiki/queries/research-topic.md",
    )).toBe(false)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })
})

describe("collectResearchSources", () => {
  it("uses only Web Search when source mode is web", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({ deepResearchSource: "web", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([webResult])
  })

  it("uses only AnyTXT when source mode is anytxt", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "anytxt",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch.mock.calls[0][0]).toEqual(["alpha"])
    expect(out.results).toEqual([localResult])
  })

  it("uses both sources concurrently and deduplicates by URL", async () => {
    const duplicate = { ...localResult, url: webResult.url }
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([duplicate, localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([webResult, localResult])
  })

  it("keeps web results when AnyTXT fails and exposes the source error", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockRejectedValue(new Error("Check that ATGUI.exe is running"))

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(out.results).toEqual([webResult])
    expect(out.errors).toEqual(["Check that ATGUI.exe is running"])
  })

  it("skips Web Search in both mode when no web provider is configured", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "none",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([localResult])
  })

  it("returns no results for blank queries", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])

    const out = await collectResearchSources(
      [" ", ""],
      config({ deepResearchSource: "both", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(webSearch).not.toHaveBeenCalled()
    expect(anyTxtSearch).not.toHaveBeenCalled()
    expect(out.results).toEqual([])
  })

  it("logs once when research sources are capped", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const webSearch = vi.fn().mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        snippet: "snippet",
        source: "example.com",
      })),
    )
    const anyTxtSearch = vi.fn().mockResolvedValue([])

    const out = await collectResearchSources(
      ["alpha", "beta"],
      config({ deepResearchSource: "web", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
    )

    expect(out.results).toHaveLength(20)
    expect(infoSpy).toHaveBeenCalledTimes(1)
    infoSpy.mockRestore()
  })

  it("applies the relevance filter after deduplication and capping", async () => {
    const lowQuality = {
      title: "Unrelated homework answers",
      url: "https://documents.test/homework",
      snippet: "Exam answers unrelated to the research topic",
      source: "documents.test",
    }
    const relevanceFilter = vi.fn().mockImplementation(async (_queries, results) => [results[0]])
    const webSearch = vi.fn().mockResolvedValue([webResult, lowQuality])
    const anyTxtSearch = vi.fn().mockResolvedValue([])

    const out = await collectResearchSources(
      ["alpha"],
      config({ deepResearchSource: "web", provider: "tavily", apiKey: "tvly" }),
      "/project",
      { webSearch, anyTxtSearch },
      { llmConfig: {} as never, researchTopic: "Alpha topic", relevanceFilter },
    )

    expect(relevanceFilter).toHaveBeenCalledWith(
      ["alpha"],
      [webResult, lowQuality],
      expect.anything(),
      "Alpha topic",
    )
    expect(out.results).toEqual([webResult])
    expect(out.candidateCount).toBe(2)
    expect(out.rejectedCount).toBe(1)
  })
})

describe("filterResearchSourcesByRelevance", () => {
  it("uses a bounded non-reasoning request for the quality gate", () => {
    const overrides = researchRelevanceRequestOverrides()

    expect(overrides).toMatchObject({
      temperature: 0,
      max_tokens: 512,
      reasoning: { mode: "off" },
    })
  })

  it("keeps only indexes approved by the quality judge", async () => {
    const noisy: WebSearchResult = {
      title: "Courseware and exam answers",
      url: "https://documents.test/exam",
      snippet: "Unrelated homework material",
      source: "documents.test",
    }
    const judge = vi.fn().mockResolvedValue("{\"keep\":[1]}")

    const filtered = await filterResearchSourcesByRelevance(
      ["alpha project mechanism"],
      [webResult, noisy],
      {} as never,
      "Alpha project mechanism",
      judge,
    )

    expect(filtered).toEqual([webResult])
    const messages = judge.mock.calls[0][1]
    expect(messages[0].content).toContain("document-sharing farms")
    expect(messages[0].content).toContain("unrelated meanings of ambiguous terms")
    expect(messages[0].content).toContain("contradictory evidence")
    expect(JSON.parse(messages[1].content).researchTopic).toBe("Alpha project mechanism")
  })

  it("fails open when the quality judge response is malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const results = [webResult]
    const filtered = await filterResearchSourcesByRelevance(
      ["alpha"],
      results,
      {} as never,
      "Alpha",
      vi.fn().mockResolvedValue("not json"),
    )
    expect(filtered).toEqual(results)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("allows the judge to reject every irrelevant candidate", async () => {
    const filtered = await filterResearchSourcesByRelevance(
      ["alpha"],
      [webResult],
      {} as never,
      "Alpha",
      vi.fn().mockResolvedValue("```json\n{\"keep\":[]}\n```"),
    )
    expect(filtered).toEqual([])
  })

  it("accepts numeric string indexes and fails open on zero-based output", async () => {
    const second = { ...webResult, title: "Second", url: "https://example.com/second" }
    await expect(filterResearchSourcesByRelevance(
      ["alpha"],
      [webResult, second],
      {} as never,
      "Alpha",
      vi.fn().mockResolvedValue("{\"keep\":[\"1\"]}"),
    )).resolves.toEqual([webResult])
    await expect(filterResearchSourcesByRelevance(
      ["alpha"],
      [webResult, second],
      {} as never,
      "Alpha",
      vi.fn().mockResolvedValue("{\"keep\":[0]}"),
    )).resolves.toEqual([webResult, second])
  })

  it("fails open when non-empty indexes contain no valid candidate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const filtered = await filterResearchSourcesByRelevance(
      ["alpha"],
      [webResult],
      {} as never,
      "Alpha",
      vi.fn().mockResolvedValue("{\"keep\":[99]}"),
    )
    expect(filtered).toEqual([webResult])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("relevance gate failed"),
      expect.anything(),
    )
    warn.mockRestore()
  })

  it("parses the last compact keep object around prose and reasoning", async () => {
    const second = { ...webResult, title: "Second", url: "https://example.com/second" }
    const filtered = await filterResearchSourcesByRelevance(
      ["alpha"],
      [webResult, second],
      {} as never,
      "Alpha",
      vi.fn().mockResolvedValue("<think>{draft}</think>Result: {\"keep\":[2]} done"),
    )
    expect(filtered).toEqual([second])
  })
})

describe("collectResearchSources relevance origins", () => {
  it("filters web candidates but always preserves local AnyTXT results", async () => {
    const webSearch = vi.fn().mockResolvedValue([webResult])
    const anyTxtSearch = vi.fn().mockResolvedValue([localResult])
    const relevanceFilter = vi.fn().mockResolvedValue([])

    const out = await collectResearchSources(
      ["alpha"],
      config({
        deepResearchSource: "both",
        provider: "tavily",
        apiKey: "tvly",
        anyTxt: { endpoint: "http://127.0.0.1:9920" },
      }),
      "/project",
      { webSearch, anyTxtSearch },
      { llmConfig: {} as never, researchTopic: "Alpha", relevanceFilter },
    )

    expect(relevanceFilter).toHaveBeenCalledWith(["alpha"], [webResult], expect.anything(), "Alpha")
    expect(out.results).toEqual([localResult])
    expect(out.candidateCount).toBe(2)
    expect(out.rejectedCount).toBe(1)
  })
})
