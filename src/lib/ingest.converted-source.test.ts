import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMock = vi.hoisted(() => {
  let now = 1_000
  const files = new Map<string, { content: string; mtime: number }>()
  return {
    files,
    readFile: vi.fn(async (path: string) => {
      const file = files.get(path)
      if (!file) throw new Error(`missing ${path}`)
      return file.content
    }),
    writeFile: vi.fn(async (path: string, contents: string) => {
      files.set(path, { content: contents, mtime: ++now })
    }),
    listDirectory: vi.fn(async () => []),
    fileExists: vi.fn(async (path: string) => files.has(path)),
    fileModifiedMs: vi.fn(async (path: string) => files.get(path)?.mtime ?? null),
    convertWithMarkitdown: vi.fn(async () => ({
      ok: true,
      markdown: "MARKITDOWN BODY",
      error: null,
      timedOut: false,
    })),
    reset: () => {
      now = 1_000
      files.clear()
    },
    touch: (path: string, content: string, mtime: number) => {
      files.set(path, { content, mtime })
      now = Math.max(now, mtime)
    },
  }
})

const llmMock = vi.hoisted(() => ({
  calls: [] as Array<Array<{ role: string; content: string }>>,
  streamChat: vi.fn(async (_cfg, messages, callbacks) => {
    llmMock.calls.push(messages)
    const response = llmMock.calls.length === 1
      ? "analysis from converted markdown"
      : [
          "---FILE: wiki/sources/report.md---",
          "---",
          "type: source",
          "title: Report",
          'sources: ["report.pdf"]',
          "---",
          "",
          "# Report",
          "",
          "generated summary",
          "---END FILE---",
        ].join("\n")
    callbacks.onToken(response)
    callbacks.onDone()
  }),
  reset: () => {
    llmMock.calls.length = 0
  },
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMock.readFile,
  writeFile: fsMock.writeFile,
  listDirectory: fsMock.listDirectory,
  fileExists: fsMock.fileExists,
  fileModifiedMs: fsMock.fileModifiedMs,
  convertWithMarkitdown: fsMock.convertWithMarkitdown,
}))

vi.mock("./llm-client", () => ({
  streamChat: llmMock.streamChat,
}))

vi.mock("@/lib/extract-source-images", () => ({
  extractAndSaveSourceImages: vi.fn(async () => []),
  buildImageMarkdownSection: vi.fn(() => ""),
}))

import { autoIngest } from "./ingest"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

const PROJECT = "D:/project"
const RAW = "D:/project/raw/sources/report.pdf"

beforeEach(() => {
  fsMock.reset()
  llmMock.reset()
  vi.clearAllMocks()
  fsMock.touch(RAW, "NATIVE BODY", 10)
  fsMock.touch(`${PROJECT}/schema.md`, "", 1)
  fsMock.touch(`${PROJECT}/purpose.md`, "", 1)
  fsMock.touch(`${PROJECT}/wiki/index.md`, "", 1)
  fsMock.touch(`${PROJECT}/wiki/overview.md`, "", 1)
  useActivityStore.setState({ items: [] })
  useReviewStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })
  useWikiStore.setState({
    outputLanguage: "auto",
    multimodalConfig: {
      enabled: false,
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      useMainLlm: true,
      apiMode: "chat_completions",
      concurrency: 1,
    },
    embeddingConfig: {
      enabled: false,
      endpoint: "",
      apiKey: "",
      model: "",
    },
  } as Partial<ReturnType<typeof useWikiStore.getState>>)
})

describe("autoIngest converted source input", () => {
  it("feeds MarkItDown markdown to the LLM instead of native extraction", async () => {
    await autoIngest(PROJECT, RAW, {
      provider: "openai",
      apiKey: "test",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })

    expect(fsMock.convertWithMarkitdown).toHaveBeenCalledWith(RAW)
    expect(fsMock.files.get(`${PROJECT}/.llm-wiki/converted/report.pdf.md`)?.content)
      .toBe("MARKITDOWN BODY\n")
    const firstUserMessage = llmMock.calls[0]?.find((m) => m.role === "user")?.content ?? ""
    expect(firstUserMessage).toContain("MARKITDOWN BODY")
    expect(firstUserMessage).not.toContain("NATIVE BODY")
  })
})
