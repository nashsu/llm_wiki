import { describe, it, expect, beforeEach, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

// Mock LLM + Tauri FS — the lint runner also touches the activity store
// (we leave that real so we can assert status transitions).
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { runSemanticLint, runStructuralLint } from "./lint"
import { streamChat } from "./llm-client"
import { readFile, listDirectory } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"

const mockStreamChat = vi.mocked(streamChat)
const mockReadFile = vi.mocked(readFile)
const mockListDirectory = vi.mocked(listDirectory)

function fakeLlmConfig(): LlmConfig {
  return {
    provider: "openai",
    apiKey: "k",
    model: "m",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  }
}

function makeFileNode(name: string, content: string): { node: FileNode; content: string } {
  return {
    node: {
      name,
      path: `/project/wiki/${name}`,
      is_dir: false,
      children: [],
    } as FileNode,
    content,
  }
}

beforeEach(() => {
  mockStreamChat.mockReset()
  mockReadFile.mockReset()
  mockListDirectory.mockReset()
  useWikiStore.getState().setOutputLanguage("auto")
  useActivityStore.setState({ items: [] })
})

describe("runSemanticLint — language directive", () => {
  it("uses explicit user setting", async () => {
    const pages = [
      makeFileNode("a.md", "Page A content here"),
      makeFileNode("b.md", "Page B content here"),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken("")
      cb.onDone()
    })

    useWikiStore.getState().setOutputLanguage("Korean")
    await runSemanticLint("/project", fakeLlmConfig())

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("auto mode detects from the concatenated page summaries", async () => {
    const cjkContent = "这是一篇关于注意力机制和神经网络的长中文页面"
    const pages = [
      makeFileNode("attention.md", cjkContent),
      makeFileNode("transformer.md", cjkContent),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken("")
      cb.onDone()
    })

    useWikiStore.getState().setOutputLanguage("auto")
    await runSemanticLint("/project", fakeLlmConfig())

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("explicit setting wins over source language", async () => {
    const pages = [makeFileNode("x.md", "これは日本語の内容です")]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockResolvedValue(pages[0].content)
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken("")
      cb.onDone()
    })

    useWikiStore.getState().setOutputLanguage("English")
    await runSemanticLint("/project", fakeLlmConfig())

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
  })
})

describe("runSemanticLint — missing-page false positives (#537)", () => {
  it("drops missing-page findings when the entity page already exists", async () => {
    const pages = [
      makeFileNode("概念页.md", "介绍 [[维特根斯坦]]、[[阿德勒]] 和 [[尼采]] 的概念页"),
      makeFileNode("维特根斯坦.md", "维特根斯坦是一位哲学家。"), // entity page EXISTS
      makeFileNode("阿德勒.md", "阿德勒是一位心理学家。"), // entity page EXISTS
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })
    // The LLM wrongly reports missing-page for entities that already have pages,
    // using free-form Chinese titles that don't match a known "缺失页面:" prefix.
    const llm = [
      "---LINT: missing-page | warning | 维特根斯坦---", // bare name, page exists
      "维特根斯坦在概念页中被引用但未建立独立实体页。",
      "PAGES: 概念页.md",
      "---END LINT---",
      "---LINT: missing-page | warning | 缺失页面：阿德勒---", // standard prefix, page exists
      "阿德勒被引用但缺少页面。",
      "PAGES: 概念页.md",
      "---END LINT---",
      "---LINT: missing-page | warning | 尼采---", // genuinely missing (no page)
      "尼采被引用但没有页面。",
      "PAGES: 概念页.md",
      "---END LINT---",
    ].join("\n")
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken(llm)
      cb.onDone()
    })

    const results = await runSemanticLint("/project", fakeLlmConfig())

    const missingPages = results.filter((r) => r.detail.includes("[missing-page]"))
    // The two existing-entity false positives are filtered; only 尼采 remains.
    expect(missingPages).toHaveLength(1)
    expect(missingPages[0].page).toBe("尼采")
  })

  it("does not suppress an unrelated finding that merely contains an existing short title", async () => {
    const pages = [
      makeFileNode("AI.md", "---\ntitle: AI\n---\n# AI"),
      makeFileNode("overview.md", "References [[FAIR data governance]]."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken([
        "---LINT: missing-page | warning | FAIR data governance---",
        "The concept has no dedicated page.",
        "PAGES: overview.md",
        "---END LINT---",
      ].join("\n"))
      cb.onDone()
    })

    const results = await runSemanticLint("/project", fakeLlmConfig())

    expect(results).toHaveLength(1)
    expect(results[0].page).toBe("FAIR data governance")
  })
})

describe("runSemanticLint — activity & early returns", () => {
  it("logs a running activity item and marks done", async () => {
    mockListDirectory.mockResolvedValue([makeFileNode("a.md", "content").node])
    mockReadFile.mockResolvedValue("content")
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onDone()
    })

    await runSemanticLint("/project", fakeLlmConfig())
    const items = useActivityStore.getState().items
    expect(items).toHaveLength(1)
    // Final state after run completes
    expect(items[0].type).toBe("lint")
    expect(["done", "error"]).toContain(items[0].status)
  })

  it("returns empty and marks done when wiki has no pages", async () => {
    mockListDirectory.mockResolvedValue([])

    const result = await runSemanticLint("/project", fakeLlmConfig())
    expect(result).toEqual([])
    expect(mockStreamChat).not.toHaveBeenCalled()

    const items = useActivityStore.getState().items
    expect(items[0].detail).toMatch(/no wiki pages/i)
  })

  it("marks error status when wiki directory read fails", async () => {
    mockListDirectory.mockRejectedValue(new Error("ENOENT"))
    await runSemanticLint("/project", fakeLlmConfig())
    const items = useActivityStore.getState().items
    expect(items[0].status).toBe("error")
  })
})

describe("runStructuralLint — link suggestions", () => {
  it("suggests the closest existing page for a broken wikilink", async () => {
    const pages = [
      makeFileNode("transformer.md", "---\ntitle: Transformer\n---\n# Transformer\nAttention model."),
      makeFileNode("attention.md", "# Attention\nSee [[transfomer]] for the architecture."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const broken = results.find((result) => result.type === "broken-link")

    expect(broken).toMatchObject({
      page: "attention.md",
      brokenTarget: "transfomer",
      suggestedTarget: "transformer.md",
    })
  })

  it("suggests related pages for orphan and no-outlinks findings", async () => {
    const pages = [
      makeFileNode("rag.md", "# RAG\nRetrieval augmented generation uses vector search."),
      makeFileNode("vector-search.md", "# Vector Search\nVector search retrieval finds related chunks."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const noOutlinks = results.find((result) => result.type === "no-outlinks" && result.page === "rag.md")
    const orphan = results.find((result) => result.type === "orphan" && result.page === "rag.md")

    expect(noOutlinks?.suggestedTarget).toBe("vector-search.md")
    expect(orphan?.suggestedSource).toBe("vector-search.md")
  })

  it("does not attach self-referential suggestions when no related page exists", async () => {
    const pages = [
      makeFileNode("alpha.md", "# Alpha\nAardvark apricot."),
      makeFileNode("beta.md", "# Beta\nZeppelin zircon."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const orphan = results.find((result) => result.type === "orphan" && result.page === "alpha.md")

    expect(orphan?.suggestedSource).toBeUndefined()
    expect(orphan?.suggestedTarget).toBeUndefined()
  })

  it("does not suggest same-folder pages without shared terms", async () => {
    const pages = [
      makeFileNode("concepts/alpha.md", "# Alpha\nAardvark apricot."),
      makeFileNode("concepts/beta.md", "# Beta\nZeppelin zircon."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const orphan = results.find((result) => result.type === "orphan" && result.page === "concepts/alpha.md")

    expect(orphan?.suggestedSource).toBeUndefined()
  })

  it("does not suggest short unrelated typo targets", async () => {
    const pages = [
      makeFileNode("bat.md", "# Bat\nFlying mammal."),
      makeFileNode("note.md", "# Note\nSee [[cat]]."),
    ]
    mockListDirectory.mockResolvedValue(pages.map((p) => p.node))
    mockReadFile.mockImplementation(async (path) => {
      const match = pages.find((p) => p.node.path === path)
      return match?.content ?? ""
    })

    const results = await runStructuralLint("/project")
    const broken = results.find((result) => result.type === "broken-link" && result.brokenTarget === "cat")

    expect(broken?.suggestedTarget).toBeUndefined()
  })
})
