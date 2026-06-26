import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  chunkOverviewBySections,
  parseOverviewPrematchOutput,
  buildOverviewPrematchPrompt,
  assembleReducedOverview,
  runOverviewPrematchParallel,
  parseOverviewBlocks,
  appendOverviewContent,
  createInitialOverview,
  type ParsedOverviewBlock,
} from "./overview-blocks"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

const mockStreamChat = vi.mocked(streamChat)
const mockLlmConfig = { model: "test", provider: "openai" } as unknown as LlmConfig

function mockStreamResponse(text: string) {
  return async (_config: unknown, _messages: unknown, callbacks: {
    onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void
  }) => {
    for (const char of text) callbacks.onToken(char)
    callbacks.onDone()
  }
}

beforeEach(() => {
  mockStreamChat.mockReset()
})

describe("chunkOverviewBySections", () => {
  it("returns empty array for empty overview", () => {
    expect(chunkOverviewBySections("", 2000)).toEqual([])
  })

  it("returns single chunk when overview is small", () => {
    const overview = [
      "# Overview",
      "",
      "## 操作系统",
      "操作系统是管理硬件资源的软件。",
      "",
      "## 网络",
      "计算机网络是互联互通的系统。",
    ].join("\n")
    const chunks = chunkOverviewBySections(overview, 2000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain("## 操作系统")
    expect(chunks[0]).toContain("## 网络")
  })

  it("splits into multiple chunks when overview exceeds maxChunkChars", () => {
    const sections: string[] = ["# Overview", ""]
    for (let i = 0; i < 5; i++) {
      sections.push(`## Section ${i}`)
      sections.push("x".repeat(600))
      sections.push("")
    }
    const overview = sections.join("\n")
    const chunks = chunkOverviewBySections(overview, 1000)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it("preserves section headings in each chunk", () => {
    const overview = [
      "# Overview",
      "",
      "## 操作系统",
      "内容A",
      "",
      "## 网络",
      "内容B",
    ].join("\n")
    const chunks = chunkOverviewBySections(overview, 50)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.some((c) => c.includes("## 操作系统"))).toBe(true)
    expect(chunks.some((c) => c.includes("## 网络"))).toBe(true)
  })

  it("handles overview with no ## headings (single chunk)", () => {
    const overview = "Just some prose without headings."
    const chunks = chunkOverviewBySections(overview, 2000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(overview)
  })
})

describe("parseOverviewPrematchOutput", () => {
  it("parses bracket section names", () => {
    expect(parseOverviewPrematchOutput("[操作系统, 进程管理]")).toEqual(["操作系统", "进程管理"])
  })
  it("returns empty for none", () => {
    expect(parseOverviewPrematchOutput("none")).toEqual([])
  })
  it("returns empty for empty string", () => {
    expect(parseOverviewPrematchOutput("")).toEqual([])
  })
  it("handles extra whitespace", () => {
    expect(parseOverviewPrematchOutput("[ 操作系统 ,  网络 ]")).toEqual(["操作系统", "网络"])
  })
})

describe("buildOverviewPrematchPrompt", () => {
  it("includes source content and chunk", () => {
    const prompt = buildOverviewPrematchPrompt("source text", "chunk text")
    expect(prompt).toContain("source text")
    expect(prompt).toContain("chunk text")
    expect(prompt).toContain("section names")
  })
})

describe("assembleReducedOverview", () => {
  it("returns empty string for no matches", () => {
    expect(assembleReducedOverview("any", [])).toBe("")
  })
  it("assembles only matched sections", () => {
    const overview = [
      "# Overview", "",
      "## 操作系统", "OS content", "",
      "## 网络", "Network content", "",
      "## 数据库", "DB content",
    ].join("\n")
    const result = assembleReducedOverview(overview, ["操作系统", "数据库"])
    expect(result).toContain("## 操作系统")
    expect(result).toContain("OS content")
    expect(result).toContain("## 数据库")
    expect(result).toContain("DB content")
    expect(result).not.toContain("## 网络")
    expect(result).not.toContain("Network content")
  })
})

describe("runOverviewPrematchParallel", () => {
  it("returns empty array for empty chunks", async () => {
    const result = await runOverviewPrematchParallel([], "source", mockLlmConfig, undefined)
    expect(result).toEqual([])
  })
  it("collects matched section names from all chunks", async () => {
    mockStreamChat
      .mockImplementationOnce(mockStreamResponse("[操作系统, 进程管理]"))
      .mockImplementationOnce(mockStreamResponse("[网络]"))
    const result = await runOverviewPrematchParallel(["chunk1", "chunk2"], "source", mockLlmConfig, undefined)
    expect(result.sort()).toEqual(["操作系统", "网络", "进程管理"])
  })
  it("handles none response", async () => {
    mockStreamChat.mockImplementationOnce(mockStreamResponse("none"))
    const result = await runOverviewPrematchParallel(["chunk1"], "source", mockLlmConfig, undefined)
    expect(result).toEqual([])
  })
  it("handles LLM error gracefully", async () => {
    mockStreamChat.mockImplementationOnce(async (_c, _m, callbacks: {
      onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void
    }) => {
      callbacks.onError(new Error("LLM failed"))
      callbacks.onDone()
    })
    const result = await runOverviewPrematchParallel(["chunk1"], "source", mockLlmConfig, undefined)
    expect(result).toEqual([])
  })
})

describe("parseOverviewBlocks", () => {
  it("parses a single OVERVIEW block", () => {
    const text = [
      "---OVERVIEW: 操作系统---",
      "操作系统是管理硬件资源的软件。",
      "",
      "它负责进程调度、内存管理和文件系统。",
      "---END OVERVIEW---",
    ].join("\n")
    const blocks = parseOverviewBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].section).toBe("操作系统")
    expect(blocks[0].content).toContain("操作系统是管理硬件资源的软件。")
  })

  it("parses multiple OVERVIEW blocks", () => {
    const text = [
      "---OVERVIEW: 操作系统---",
      "OS content",
      "---END OVERVIEW---",
      "",
      "---OVERVIEW: 网络---",
      "Network content",
      "---END OVERVIEW---",
    ].join("\n")
    const blocks = parseOverviewBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].section).toBe("操作系统")
    expect(blocks[1].section).toBe("网络")
  })

  it("returns empty array when no OVERVIEW blocks", () => {
    expect(parseOverviewBlocks("just some text")).toEqual([])
    expect(parseOverviewBlocks("")).toEqual([])
  })

  it("handles extra whitespace in section name", () => {
    const text = "---OVERVIEW:  操作系统  ---\ncontent\n---END OVERVIEW---"
    const blocks = parseOverviewBlocks(text)
    expect(blocks[0].section).toBe("操作系统")
  })
})

describe("appendOverviewContent", () => {
  it("appends to existing section", () => {
    const existing = [
      "# Overview", "",
      "## 操作系统", "OS original content", "",
      "## 网络", "Network content",
    ].join("\n")
    const blocks: ParsedOverviewBlock[] = [
      { section: "操作系统", content: "New OS paragraph." },
    ]
    const result = appendOverviewContent(existing, blocks)
    expect(result).toContain("## 操作系统")
    expect(result).toContain("OS original content")
    expect(result).toContain("New OS paragraph.")
    expect(result.indexOf("OS original content")).toBeLessThan(result.indexOf("New OS paragraph."))
    expect(result).toContain("## 网络")
    expect(result).toContain("Network content")
  })

  it("creates new section at end when section does not exist", () => {
    const existing = ["# Overview", "", "## 操作系统", "OS content"].join("\n")
    const blocks: ParsedOverviewBlock[] = [
      { section: "数据库", content: "DB content." },
    ]
    const result = appendOverviewContent(existing, blocks)
    expect(result).toContain("## 数据库")
    expect(result).toContain("DB content.")
    expect(result.indexOf("## 操作系统")).toBeLessThan(result.indexOf("## 数据库"))
  })

  it("handles multiple blocks", () => {
    const existing = "# Overview\n\n## 操作系统\nOS content"
    const blocks: ParsedOverviewBlock[] = [
      { section: "操作系统", content: "OS new." },
      { section: "网络", content: "Network new." },
    ]
    const result = appendOverviewContent(existing, blocks)
    expect(result).toContain("OS new.")
    expect(result).toContain("## 网络")
    expect(result).toContain("Network new.")
  })

  it("returns original when no blocks", () => {
    const existing = "# Overview\n\n## A\ncontent"
    expect(appendOverviewContent(existing, [])).toBe(existing)
  })
})

describe("createInitialOverview", () => {
  it("creates overview with frontmatter and sections", () => {
    const blocks: ParsedOverviewBlock[] = [
      { section: "操作系统", content: "OS content." },
    ]
    const result = createInitialOverview(blocks, "2026-06-26")
    expect(result).toContain("type: overview")
    expect(result).toContain("---")
    expect(result).toContain("# Overview")
    expect(result).toContain("## 操作系统")
    expect(result).toContain("OS content.")
    expect(result).toContain("created: 2026-06-26")
    expect(result).toContain("updated: 2026-06-26")
  })

  it("handles multiple sections", () => {
    const blocks: ParsedOverviewBlock[] = [
      { section: "A", content: "Content A." },
      { section: "B", content: "Content B." },
    ]
    const result = createInitialOverview(blocks, "2026-06-26")
    expect(result).toContain("## A")
    expect(result).toContain("## B")
  })
})
