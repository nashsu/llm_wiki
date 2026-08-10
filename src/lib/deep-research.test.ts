import { describe, expect, it, vi } from "vitest"
import {
  citedResearchSourceIndexes,
  collectResearchSources,
  makeDeepResearchFileName,
  noResearchSourcesTaskPatch,
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
})
