import { describe, it, expect, beforeEach, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

// Mock the LLM client (capture prompts) and the Tauri fs commands (no real FS).
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { enrichWithWikilinks } from "./enrich-wikilinks"
import { streamChat } from "./llm-client"
import { readFile, writeFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"

const mockStreamChat = vi.mocked(streamChat)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)

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

// Returns a large-enough enriched response so the "too short" guard (0.5x) passes.
function mockStreamChatReturns(text: string) {
  mockStreamChat.mockImplementation(async (_cfg, _msgs, callbacks) => {
    callbacks.onToken(text)
    callbacks.onDone()
  })
}

beforeEach(() => {
  mockStreamChat.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  useWikiStore.getState().setOutputLanguage("auto")
})

describe("enrichWithWikilinks — language directive is built at call time", () => {
  // This is the regression for LANGUAGE_RULE being a module-load constant.
  // Setting the output language AFTER the module is already imported must
  // affect the next call's prompt.
  it("uses the language configured at call time, not at module load", async () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    mockReadFile.mockResolvedValue("some page content that is long enough to write back to disk")
    mockStreamChatReturns("some [[enriched]] page content that is long enough to write back to disk")

    await enrichWithWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig())

    const systemMsg = mockStreamChat.mock.calls[0][1][0]
    expect(systemMsg.role).toBe("system")
    expect(systemMsg.content).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("picks up a language change between two successive calls", async () => {
    mockReadFile.mockResolvedValue("content that is definitely long enough for the length guard")
    mockStreamChatReturns("content that is definitely long enough for the length guard [[link]]")

    useWikiStore.getState().setOutputLanguage("Japanese")
    await enrichWithWikilinks("/p", "/p/wiki/a.md", fakeLlmConfig())

    useWikiStore.getState().setOutputLanguage("Korean")
    await enrichWithWikilinks("/p", "/p/wiki/b.md", fakeLlmConfig())

    const first = mockStreamChat.mock.calls[0][1][0].content
    const second = mockStreamChat.mock.calls[1][1][0].content
    expect(first).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(second).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("auto mode falls back to detecting from the page content", async () => {
    useWikiStore.getState().setOutputLanguage("auto")
    mockReadFile.mockResolvedValue("这是一篇关于注意力机制的长中文页面，内容足够长所以能通过守卫")
    mockStreamChatReturns("这是一篇关于[[注意力机制]]的长中文页面，内容足够长所以能通过守卫")

    await enrichWithWikilinks("/p", "/p/wiki/attention.md", fakeLlmConfig())

    const content = mockStreamChat.mock.calls[0][1][0].content
    expect(content).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("explicit setting beats source content detection", async () => {
    useWikiStore.getState().setOutputLanguage("English")
    mockReadFile.mockResolvedValue("这段中文页面内容非常长，足够通过守卫，里面讲的是注意力机制")
    mockStreamChatReturns("This is english replacement content that is long enough to pass the guard [[link]]")

    await enrichWithWikilinks("/p", "/p/wiki/x.md", fakeLlmConfig())

    const content = mockStreamChat.mock.calls[0][1][0].content
    expect(content).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(content).not.toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })
})

describe("enrichWithWikilinks — JSON-based substitution", () => {
  it("does NOT overwrite when LLM response is not parseable JSON", async () => {
    // The v2 implementation expects a JSON `{links:[...]}` object; anything
    // else produces zero substitutions and writeFile is never called.
    mockReadFile.mockResolvedValue("some real page content with Transformer and Attention mentioned")
    mockStreamChatReturns("too short")

    await enrichWithWikilinks("/p", "/p/f.md", fakeLlmConfig())
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it("writes back when LLM returns a valid JSON substitution list", async () => {
    mockReadFile.mockResolvedValue(
      "Transformer is the backbone. Attention is core.",
    )
    mockStreamChatReturns(
      JSON.stringify({
        links: [
          { term: "Transformer", target: "transformer" },
          { term: "Attention", target: "attention" },
        ],
      }),
    )

    await enrichWithWikilinks("/p", "/p/f.md", fakeLlmConfig())
    expect(mockWriteFile).toHaveBeenCalledOnce()
    const written = vi.mocked(mockWriteFile).mock.calls[0][1] as string
    expect(written).toContain("[[Transformer]]")
    expect(written).toContain("[[Attention]]")
  })

  it("does NOT overwrite when LLM returns an empty links list", async () => {
    mockReadFile.mockResolvedValue("a page that matches no index term")
    mockStreamChatReturns(JSON.stringify({ links: [] }))

    await enrichWithWikilinks("/p", "/p/f.md", fakeLlmConfig())
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it("returns early when content or index is missing", async () => {
    mockReadFile.mockResolvedValueOnce("").mockResolvedValueOnce("index has things")
    await enrichWithWikilinks("/p", "/p/f.md", fakeLlmConfig())
    expect(mockStreamChat).not.toHaveBeenCalled()
  })
})
