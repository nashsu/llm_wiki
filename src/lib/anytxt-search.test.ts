import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  anyTxtSearch,
  anyTxtSearchSmart,
  normalizeAnyTxtConfig,
  parseAnyTxtQueryRewrite,
  prepareAnyTxtQueries,
} from "./anytxt-search"

const invokeMock = vi.hoisted(() => vi.fn())
const streamChatMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
}))

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "http://localhost/v1/chat/completions",
  maxContextSize: 128000,
}

describe("anyTxtSearch", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    streamChatMock.mockReset()
  })

  it("delegates AnyTXT JSON-RPC search to the Rust backend command", async () => {
    invokeMock.mockResolvedValueOnce([
      { title: "alpha.pdf", url: "/docs/alpha.pdf", snippet: "matching fragment text", source: "AnyTXT" },
    ])

    const out = await anyTxtSearch(
      "alpha",
      {
        endpoint: "127.0.0.1:9920",
        filterDir: "C:\\docs",
        filterExt: "*.pdf",
        limit: 10,
      },
      5,
    )

    expect(invokeMock).toHaveBeenCalledWith("anytxt_search", {
      query: "alpha",
      maxResults: 5,
      config: {
        enabled: true,
        endpoint: "http://127.0.0.1:9920",
        filterDir: "C:\\docs",
        filterExt: "*.pdf",
        limit: 10,
      },
    })
    expect(out).toEqual([
      { title: "alpha.pdf", url: "/docs/alpha.pdf", snippet: "matching fragment text", source: "AnyTXT" },
    ])
  })

  it("uses the Unix root for blank filterDir on macOS/Linux projects", () => {
    expect(normalizeAnyTxtConfig({ endpoint: "127.0.0.1:9920", filterDir: "" }, "/Users/me/wiki").filterDir)
      .toBe("/")
  })

  it("leaves blank filterDir unset for Windows projects", () => {
    expect(normalizeAnyTxtConfig({ endpoint: "127.0.0.1:9920", filterDir: "" }, "C:/Users/me/wiki").filterDir)
      .toBe("")
  })

  it("normalizes endpoints and clamps limits", () => {
    expect(normalizeAnyTxtConfig({ endpoint: "localhost:9920", limit: 1000 })).toMatchObject({
      endpoint: "http://localhost:9920",
      limit: 100,
    })
    expect(normalizeAnyTxtConfig({ endpoint: "https://host/api", limit: -1 })).toMatchObject({
      endpoint: "https://host/api",
      limit: 1,
    })
  })

  it("returns no results for blank queries or disabled AnyTXT without invoking Rust", async () => {
    expect(await anyTxtSearch("   ", { endpoint: "127.0.0.1:9920" })).toEqual([])
    expect(await anyTxtSearch("alpha", { enabled: false, endpoint: "127.0.0.1:9920" })).toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe("AnyTXT query rewrite", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    streamChatMock.mockReset()
  })

  it("parses JSON-array query rewrites and deduplicates them", () => {
    expect(parseAnyTxtQueryRewrite('```json\n["MBR ammonia", "winter nitrification", "MBR ammonia"]\n```'))
      .toEqual(["MBR ammonia", "winter nitrification"])
  })

  it("falls back to line-based query parsing", () => {
    expect(parseAnyTxtQueryRewrite("QUERY: 反硝化除磷\n- 污水处理 冬季 氨氮\n3. MBR nitrification"))
      .toEqual(["反硝化除磷", "污水处理 冬季 氨氮", "MBR nitrification"])
  })

  it("prefers rewritten AnyTXT queries when original queries would fill the cap", async () => {
    streamChatMock.mockImplementationOnce(async (_config, _messages, callbacks) => {
      callbacks.onToken?.('["kw1", "kw2", "kw3"]')
      callbacks.onDone?.()
    })

    const queries = await prepareAnyTxtQueries(
      ["q1 long natural language", "q2 long natural language", "q3 long natural language"],
      llmConfig,
    )

    expect(queries).toEqual(["kw1", "kw2", "kw3"])
  })

  it("falls back to original queries when rewrite fails", async () => {
    streamChatMock.mockRejectedValueOnce(new Error("model offline"))

    const queries = await prepareAnyTxtQueries(["how did the project handle winter ammonia?"], llmConfig)

    expect(queries).toEqual(["how did the project handle winter ammonia?"])
  })

  it("searches rewritten queries through the smart AnyTXT entry point", async () => {
    streamChatMock.mockImplementationOnce(async (_config, _messages, callbacks) => {
      callbacks.onToken?.('["煤矿 安全"]')
      callbacks.onDone?.()
    })
    invokeMock.mockResolvedValueOnce([
      { title: "mine.pdf", url: "/docs/mine.pdf", snippet: "煤矿安全", source: "AnyTXT" },
    ])
    invokeMock.mockResolvedValueOnce([])

    const out = await anyTxtSearchSmart("请帮我找一下煤矿安全相关资料", {
      enabled: true,
      endpoint: "http://127.0.0.1:9920",
    }, llmConfig, 5)

    expect(invokeMock.mock.calls[0]).toEqual(["anytxt_search", expect.objectContaining({
      query: "煤矿 安全",
    })])
    expect(out).toHaveLength(1)
  })
})
