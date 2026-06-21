import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(),
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import {
  applyLinks,
  applyWikilinks,
  enrichWithWikilinks,
  parseLinkResponse,
  suggestWikilinks,
} from "./enrich-wikilinks"
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

function mockStreamChatReturns(text: string) {
  mockStreamChat.mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken(text)
    callbacks.onDone()
  })
}

function mockSuggestionFiles(content: string, index = "- transformer\n- attention") {
  mockReadFile.mockResolvedValueOnce(content).mockResolvedValueOnce(index)
}

beforeEach(() => {
  mockStreamChat.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  useWikiStore.setState({ dataVersion: 0, outputLanguage: "auto" })
})

describe("suggestWikilinks", () => {
  it("returns parsed candidates without writing the file", async () => {
    mockSuggestionFiles("Transformer uses Attention.")
    mockStreamChatReturns(JSON.stringify({
      links: [
        { term: "Transformer", target: "transformer" },
        { term: "Attention", target: "attention" },
      ],
    }))

    await expect(
      suggestWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig()),
    ).resolves.toEqual([
      { term: "Transformer", target: "transformer" },
      { term: "Attention", target: "attention" },
    ])
    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(useWikiStore.getState().dataVersion).toBe(0)
  })

  it("waits for an asynchronous terminal callback before parsing", async () => {
    mockSuggestionFiles("Transformer uses Attention.")
    mockStreamChat.mockImplementation(async (_config, _messages, callbacks) => {
      setTimeout(() => {
        callbacks.onToken(JSON.stringify({
          links: [{ term: "Transformer", target: "transformer" }],
        }))
        callbacks.onDone()
      }, 0)
    })

    await expect(
      suggestWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig()),
    ).resolves.toEqual([
      { term: "Transformer", target: "transformer" },
    ])
  })

  it("rejects when streamChat invokes onError and leaves the file untouched", async () => {
    mockSuggestionFiles("Transformer uses Attention.")
    mockStreamChat.mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onError(new Error("transport failed"))
    })

    await expect(
      suggestWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig()),
    ).rejects.toThrow("transport failed")
    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(useWikiStore.getState().dataVersion).toBe(0)
  })

  it("waits for an asynchronous terminal error", async () => {
    mockSuggestionFiles("Transformer uses Attention.")
    mockStreamChat.mockImplementation(async (_config, _messages, callbacks) => {
      setTimeout(() => callbacks.onError(new Error("late failure")), 0)
    })

    await expect(
      suggestWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig()),
    ).rejects.toThrow("late failure")
  })

  it("propagates errors thrown directly by streamChat", async () => {
    mockSuggestionFiles("Transformer uses Attention.")
    mockStreamChat.mockRejectedValue(new Error("direct failure"))

    await expect(
      suggestWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig()),
    ).rejects.toThrow("direct failure")
  })

  it.each([
    ["missing content", "", "- transformer"],
    ["missing index", "Transformer", ""],
  ])("returns no candidates for %s", async (_name, content, index) => {
    mockSuggestionFiles(content, index)

    await expect(
      suggestWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig()),
    ).resolves.toEqual([])
    expect(mockStreamChat).not.toHaveBeenCalled()
  })

  it("propagates a current-page read failure", async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error("page read failed"))
      .mockResolvedValueOnce("- transformer")

    await expect(
      suggestWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig()),
    ).rejects.toThrow("page read failed")
  })

  it("trims trailing project separators before reading the index", async () => {
    mockSuggestionFiles("Transformer", "- transformer")
    mockStreamChatReturns(JSON.stringify({ links: [] }))

    await suggestWikilinks("/project/", "/project/wiki/note.md", fakeLlmConfig())

    expect(mockReadFile).toHaveBeenNthCalledWith(2, "/project/wiki/index.md")
  })
})

describe("suggestWikilinks language directive", () => {
  it("uses the language configured at call time, not at module load", async () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    mockSuggestionFiles("some page content")
    mockStreamChatReturns(JSON.stringify({ links: [] }))

    await suggestWikilinks("/project", "/project/wiki/note.md", fakeLlmConfig())

    const systemMessage = mockStreamChat.mock.calls[0][1][0]
    expect(systemMessage.role).toBe("system")
    expect(systemMessage.content).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("picks up a language change between two successive calls", async () => {
    mockSuggestionFiles("first content")
    mockSuggestionFiles("second content")
    mockStreamChatReturns(JSON.stringify({ links: [] }))

    useWikiStore.getState().setOutputLanguage("Japanese")
    await suggestWikilinks("/p", "/p/wiki/a.md", fakeLlmConfig())

    useWikiStore.getState().setOutputLanguage("Korean")
    await suggestWikilinks("/p", "/p/wiki/b.md", fakeLlmConfig())

    const first = mockStreamChat.mock.calls[0][1][0].content
    const second = mockStreamChat.mock.calls[1][1][0].content
    expect(first).toContain("MANDATORY OUTPUT LANGUAGE: Japanese")
    expect(second).toContain("MANDATORY OUTPUT LANGUAGE: Korean")
  })

  it("auto mode detects the language from the current page content", async () => {
    mockSuggestionFiles("这是一篇关于注意力机制的中文页面")
    mockStreamChatReturns(JSON.stringify({ links: [] }))

    await suggestWikilinks("/p", "/p/wiki/attention.md", fakeLlmConfig())

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("lets an explicit setting override source-content detection", async () => {
    useWikiStore.getState().setOutputLanguage("English")
    mockSuggestionFiles("这是一篇关于注意力机制的中文页面")
    mockStreamChatReturns(JSON.stringify({ links: [] }))

    await suggestWikilinks("/p", "/p/wiki/x.md", fakeLlmConfig())

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })
})

describe("applyWikilinks", () => {
  it("applies only the selected subset", async () => {
    mockReadFile.mockResolvedValue("Transformer uses Attention.")

    await applyWikilinks("/project", "/project/wiki/note.md", [
      { term: "Attention", target: "attention" },
    ])

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/project/wiki/note.md",
      "Transformer uses [[Attention]].",
    )
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })

  it("writes and bumps dataVersion only when content changes", async () => {
    mockReadFile.mockResolvedValue("Transformer is useful.")

    await applyWikilinks("/project", "/project/wiki/note.md", [
      { term: "Transformer", target: "transformer" },
    ])

    expect(mockWriteFile).toHaveBeenCalledOnce()
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })

  it("does not write or bump dataVersion when content is unchanged", async () => {
    mockReadFile.mockResolvedValue("No matching term.")

    await applyWikilinks("/project", "/project/wiki/note.md", [
      { term: "Transformer", target: "transformer" },
    ])

    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(useWikiStore.getState().dataVersion).toBe(0)
  })
})

describe("enrichWithWikilinks", () => {
  it("suggests and applies every returned link", async () => {
    mockSuggestionFiles("Transformer uses Attention.")
    mockReadFile.mockResolvedValueOnce("Transformer uses Attention.")
    mockStreamChatReturns(JSON.stringify({
      links: [
        { term: "Transformer", target: "transformer" },
        { term: "Attention", target: "attention" },
      ],
    }))

    await enrichWithWikilinks("/p", "/p/wiki/note.md", fakeLlmConfig())

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/p/wiki/note.md",
      "[[Transformer]] uses [[Attention]].",
    )
  })

  it("returns without rereading or writing when no links are suggested", async () => {
    mockSuggestionFiles("No matching term.")
    mockStreamChatReturns(JSON.stringify({ links: [] }))

    await enrichWithWikilinks("/p", "/p/wiki/note.md", fakeLlmConfig())

    expect(mockReadFile).toHaveBeenCalledTimes(2)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })
})

describe("parseLinkResponse", () => {
  it("parses JSON inside a markdown fence", () => {
    expect(parseLinkResponse(`\`\`\`json
{"links":[{"term":"Transformer","target":"transformer"}]}
\`\`\``)).toEqual([
      { term: "Transformer", target: "transformer" },
    ])
  })

  it("parses the first JSON object inside a prose wrapper", () => {
    expect(parseLinkResponse(
      'Here are the links: {"links":[{"term":"Attention","target":"attention"}]} Hope this helps.',
    )).toEqual([
      { term: "Attention", target: "attention" },
    ])
  })

  it("returns no links for malformed or empty JSON responses", () => {
    expect(parseLinkResponse("not JSON")).toEqual([])
    expect(parseLinkResponse('{"links":[]}')).toEqual([])
  })
})

describe("applyLinks", () => {
  it("skips a term anywhere inside an existing wikilink and links a later occurrence", () => {
    const content = "[[transformer|The Transformer architecture]] made Transformer popular."

    expect(applyLinks(content, [
      { term: "Transformer", target: "transformer" },
    ])).toBe(
      "[[transformer|The Transformer architecture]] made [[Transformer]] popular.",
    )
  })

  it("recomputes existing wikilink ranges after every replacement", () => {
    const content = "Alpha [[beta|A long Beta alias]] then Beta."

    expect(applyLinks(content, [
      { term: "Alpha", target: "alpha" },
      { term: "Beta", target: "beta" },
    ])).toBe("[[Alpha]] [[beta|A long Beta alias]] then [[Beta]].")
  })

  it("finds a later overlapping occurrence after a wikilink boundary", () => {
    const term = "]]]"

    expect(applyLinks("[[x]]]]]", [
      { term, target: "closing" },
    ])).toBe(`[[x]][[closing|${term}]]`)
  })

  it("prefers the longest selected term when selected terms overlap", () => {
    expect(applyLinks("The kidney axis connects organs.", [
      { term: "kidney", target: "kidney" },
      { term: "kidney axis", target: "gut-kidney-axis" },
    ])).toBe("The [[gut-kidney-axis|kidney axis]] connects organs.")
  })

  it.each([
    [
      "strict LF",
      "---\ntitle: Transformer\n---\nTransformer body",
      "---\ntitle: Transformer\n---\n[[Transformer]] body",
    ],
    [
      "strict CRLF",
      "---\r\ntitle: Transformer\r\n---\r\nTransformer body",
      "---\r\ntitle: Transformer\r\n---\r\n[[Transformer]] body",
    ],
    [
      "spaced fence",
      "---   \ntitle: Transformer\n---   \nTransformer body",
      "---   \ntitle: Transformer\n---   \n[[Transformer]] body",
    ],
    [
      "recoverable prefix",
      "frontmatter:\n---\ntitle: Transformer\n---\nTransformer body",
      "frontmatter:\n---\ntitle: Transformer\n---\n[[Transformer]] body",
    ],
    [
      "recoverable fenced YAML",
      "```yaml\n---\ntitle: Transformer\n---\n```\nTransformer body",
      "```yaml\n---\ntitle: Transformer\n---\n```\n[[Transformer]] body",
    ],
  ])("preserves %s frontmatter bytes and links only the body", (_name, content, expected) => {
    expect(applyLinks(content, [
      { term: "Transformer", target: "transformer" },
    ])).toBe(expected)
  })

  it("keeps first occurrence per target and the existing replacement format", () => {
    expect(applyLinks("Transformer and transformer", [
      { term: "Transformer", target: "transformer" },
      { term: "transformer", target: "TRANSFORMER" },
    ])).toBe("[[Transformer]] and transformer")

    expect(applyLinks("Attention mechanism", [
      { term: "Attention mechanism", target: "attention" },
    ])).toBe("[[attention|Attention mechanism]]")
  })
})
