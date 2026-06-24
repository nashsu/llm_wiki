import { describe, expect, it, vi } from "vitest"
import {
  buildChatAgentMessages,
  getChatAgentTools,
  parseDecision,
  parseUnderstanding,
  shouldBypassAgentPlanner,
  type ChatAgentDeps,
} from "./chat-agent"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"
import type { ChatMessage as LLMMessage } from "@/lib/llm-client"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    if (path.endsWith("purpose.md")) {
      return "This wiki tracks transformer research."
    }
    if (path.endsWith("wiki/index.md")) {
      return "## Concepts\n- [[Attention]]\n- [[Transformer]]"
    }
    if (path.endsWith("wiki/overview.md")) {
      return "# Overview\n\nThis wiki covers transformer architecture, attention, and benchmark notes."
    }
    if (path.endsWith("attention.md")) {
      return "---\ntitle: Attention\ntype: concept\n---\n# Attention\n\nAttention lets models focus on relevant tokens."
    }
    if (path.endsWith("transformer.md")) {
      return "---\ntitle: Transformer\ntype: concept\n---\n# Transformer\n\nTransformers use attention layers."
    }
    return ""
  }),
}))

vi.mock("@/lib/graph-relevance", () => ({
  buildRetrievalGraph: vi.fn(async () => ({ nodes: new Map(), dataVersion: 1 })),
  getRelatedNodes: vi.fn(() => [
    {
      node: {
        id: "transformer",
        title: "Transformer",
        type: "concept",
        path: "/tmp/project/wiki/concepts/transformer.md",
        sources: [],
        outLinks: new Set(),
        inLinks: new Set(),
      },
      relevance: 3,
    },
  ]),
}))

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.com/v1",
  maxContextSize: 128_000,
}

const searchApiConfig: SearchApiConfig = {
  provider: "none",
  apiKey: "",
}

describe("chat agent routing", () => {
  it("bypasses retrieval for greetings", () => {
    expect(shouldBypassAgentPlanner("你好")?.action).toBe("answer")
  })

  it("bypasses retrieval for short follow-up commands", () => {
    expect(shouldBypassAgentPlanner("继续")?.action).toBe("answer")
    expect(shouldBypassAgentPlanner("summarize the above")?.action).toBe("answer")
  })

  it("parses JSON decisions from model output", () => {
    expect(parseDecision('```json\n{"action":"graph_search","queries":["A B relationship"]}\n```', "fallback")).toEqual({
      action: "graph_search",
      queries: ["A B relationship"],
      answer: undefined,
      reason: undefined,
    })
  })

  it("falls back to wiki search when model routing output is malformed", () => {
    expect(parseDecision("not json", "attention")).toMatchObject({
      action: "wiki_search",
      queries: ["attention"],
    })
  })

  it("parses query understanding output", () => {
    expect(parseUnderstanding(
      '{"intent":"mixed","rewrittenQuery":"transformer benchmark","wikiQueries":["transformer"],"graphQueries":["attention transformer"],"externalQueries":["latest transformer benchmark"],"needsWiki":true,"needsGraph":true,"needsExternal":true,"isFollowUp":false,"reason":"needs local and current context"}',
      "fallback",
      { hasProject: true, webSearchEnabled: true, anyTxtSearchEnabled: false },
    )).toMatchObject({
      intent: "mixed",
      rewrittenQuery: "transformer benchmark",
      wikiQueries: ["transformer"],
      graphQueries: ["attention transformer"],
      externalQueries: ["latest transformer benchmark"],
      needsWiki: true,
      needsGraph: true,
      needsExternal: true,
    })
  })

  it("filters tool registry by available capabilities", () => {
    expect(getChatAgentTools({
      hasProject: false,
      webSearchEnabled: true,
      anyTxtSearchEnabled: false,
    }).map((tool) => tool.name)).toEqual(["web_search"])
    expect(getChatAgentTools({
      hasProject: true,
      webSearchEnabled: false,
      anyTxtSearchEnabled: true,
    }).map((tool) => tool.name)).toEqual(["wiki_search", "graph_search", "anytxt_search"])
  })

  it("does not call search tools for direct greetings", async () => {
    const deps: ChatAgentDeps = {
      searchWiki: vi.fn(),
      streamChat: vi.fn(),
    }

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig,
      text: "hello",
      historyMessages: [{ role: "user", content: "hello" }],
      dataVersion: 1,
      options: { useWebSearch: false, useAnyTxtSearch: false },
      deps,
    })

    expect(deps.searchWiki).not.toHaveBeenCalled()
    expect(deps.streamChat).not.toHaveBeenCalled()
    expect(result.references).toEqual([])
    expect(result.messages[0].content).toContain("Do not claim that you searched")
  })

  it("executes wiki search only after the planner chooses it", async () => {
    const searchWiki = vi.fn(async () => [
      {
        path: "/tmp/project/wiki/concepts/attention.md",
        title: "Attention",
        snippet: "Attention lets models focus.",
        titleMatch: true,
        score: 1,
        images: [],
      },
    ])
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"wiki_search","queries":["attention mechanism"],"reason":"needs local notes"}')
      callbacks.onDone()
    })
    const deps: ChatAgentDeps = { searchWiki, streamChat }

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig,
      text: "What do my notes say about attention?",
      historyMessages: [{ role: "user", content: "What do my notes say about attention?" }],
      dataVersion: 1,
      options: { useWebSearch: false, useAnyTxtSearch: false },
      deps,
    })

    expect(searchWiki).toHaveBeenCalledWith("/tmp/project", "attention mechanism")
    expect(result.references).toEqual([
      {
        title: "Attention",
        path: "/tmp/project/wiki/concepts/attention.md",
        kind: "wiki",
      },
    ])
    expect(String(result.messages[0].content)).toContain("## Retrieved Context")
    expect(String(result.messages[0].content)).toContain('<context id="1" source="wiki"')
    expect(String(result.messages[0].content)).toContain("Attention lets models focus on relevant tokens")
    expect(String(result.messages[0].content)).toContain("## Wiki Purpose")
    expect(String(result.messages[0].content)).toContain("This wiki tracks transformer research.")
    expect(String(result.messages[0].content)).toContain("## Wiki Overview")
    expect(String(result.messages[0].content)).toContain("This wiki covers transformer architecture")
    expect(String(result.messages[0].content)).toContain("## Wiki Index")
    expect(String(result.messages[result.messages.length - 1]?.content)).toContain("[REMINDER: Write prose in English")
  })

  it("emits detailed agent steps for tool calls and results", async () => {
    const searchWiki = vi.fn(async () => [
      {
        path: "/tmp/project/wiki/concepts/attention.md",
        title: "Attention",
        snippet: "Attention lets models focus.",
        titleMatch: true,
        score: 1,
        images: [],
      },
    ])
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"wiki_search","queries":["attention mechanism"],"reason":"needs local notes"}')
      callbacks.onDone()
    })
    const events: Array<{ stage: string; tool?: string; count?: number }> = []

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig,
      text: "What do my notes say about attention?",
      historyMessages: [{ role: "user", content: "What do my notes say about attention?" }],
      dataVersion: 1,
      options: { useWebSearch: false, useAnyTxtSearch: false },
      onEvent: (event) => events.push(event),
      deps: { searchWiki, streamChat },
    })

    expect(result.steps.map((step) => step.type)).toContain("understanding")
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_call", tool: "wiki_search", status: "running" }),
      expect.objectContaining({ type: "tool_result", tool: "wiki_search", status: "success", count: 1 }),
    ]))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "tool_call", tool: "wiki_search" }),
      expect.objectContaining({ stage: "tool_result", tool: "wiki_search", count: 1 }),
    ]))
  })

  it("materializes graph results without double-prefixing absolute node paths", async () => {
    const searchWiki = vi.fn(async () => [
      {
        path: "/tmp/project/wiki/concepts/attention.md",
        title: "Attention",
        snippet: "Attention relates to transformers.",
        titleMatch: true,
        score: 1,
        images: [],
      },
    ])
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"graph_search","queries":["attention transformer"]}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig,
      text: "How is attention connected to transformers?",
      historyMessages: [{ role: "user", content: "How is attention connected to transformers?" }],
      dataVersion: 1,
      options: { useWebSearch: false, useAnyTxtSearch: false },
      deps: { searchWiki, streamChat },
    })

    expect(result.references).toEqual([
      {
        title: "Transformer",
        path: "/tmp/project/wiki/concepts/transformer.md",
        kind: "wiki",
      },
    ])
    expect(String(result.messages[0].content)).toContain("Transformers use attention layers")
    expect(String(result.messages[0].content)).not.toContain("/tmp/project//tmp/project")
  })

  it("uses external search only when the planner selects it", async () => {
    const webSearch = vi.fn(async () => [
      {
        title: "External Paper",
        url: "https://example.com/paper",
        snippet: "A current external result.",
        source: "web",
      },
    ])
    const searchWiki = vi.fn()
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"external_search","queries":["latest transformer benchmark"]}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig: { provider: "firecrawl", apiKey: "" },
      text: "Find the latest transformer benchmark news.",
      historyMessages: [{ role: "user", content: "Find the latest transformer benchmark news." }],
      dataVersion: 1,
      options: { useWebSearch: true, useAnyTxtSearch: false },
      deps: { searchWiki, webSearch, streamChat },
    })

    expect(searchWiki).not.toHaveBeenCalled()
    expect(webSearch).toHaveBeenCalledWith("latest transformer benchmark", expect.any(Object), 5)
    expect(result.references).toEqual([
      {
        title: "External Paper",
        path: "https://example.com/paper",
        kind: "external",
        source: "web",
        url: "https://example.com/paper",
        snippet: "A current external result.",
      },
    ])
    expect(String(result.messages[0].content)).toContain("[E1]")
    expect(String(result.messages[0].content)).toContain('<context id="E1" source="web"')
    expect(String(result.messages[0].content)).toContain("External search is enabled for this conversation")
    expect(String(result.messages[0].content)).toContain("decide whether they are relevant")
    expect(String(result.messages[0].content)).toContain("If your answer uses any external search fact, include its [E#] citation")
    expect(String(result.messages[0].content)).toContain("Do not rely on the separate References panel")
  })

  it("overrides stale no-internet history when current external search results exist", async () => {
    const webSearch = vi.fn(async () => [
      {
        title: "Current Source",
        url: "https://example.com/current",
        snippet: "Fresh web result that answers the question.",
        source: "web",
      },
    ])
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"external_search","queries":["current source"]}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig: { provider: "firecrawl", apiKey: "" },
      text: "Please search the web and answer.",
      historyMessages: [
        { role: "user", content: "Can you search the web?" },
        { role: "assistant", content: "I cannot access the internet." },
        { role: "user", content: "Please search the web and answer." },
      ],
      dataVersion: 1,
      options: { useWebSearch: true, useAnyTxtSearch: false },
      deps: { webSearch, streamChat },
    })

    const system = String(result.messages[0].content)
    expect(system).toContain("Fresh web result that answers the question.")
    expect(system).toContain("If earlier conversation messages claimed external search was unavailable, ignore that stale claim")
    expect(system).toContain("Do not apologize for lacking web access")
  })

  it("can reuse recent external retrieval history without repeating web search", async () => {
    const webSearch = vi.fn()
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"finish","queries":[],"reason":"history is enough"}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig: { provider: "firecrawl", apiKey: "" },
      text: "What were the main points from the external source?",
      historyMessages: [{ role: "user", content: "What were the main points from the external source?" }],
      retrievalHistory: [
        {
          title: "External Paper",
          path: "https://example.com/paper",
          kind: "external",
          source: "web",
          url: "https://example.com/paper",
          snippet: "A prior external result.",
        },
      ],
      dataVersion: 1,
      options: { useWebSearch: true, useAnyTxtSearch: false },
      deps: { webSearch, streamChat },
    })

    expect(webSearch).not.toHaveBeenCalled()
    expect(result.references).toEqual([
      {
        title: "External Paper",
        path: "https://example.com/paper",
        kind: "external",
        source: "web",
        url: "https://example.com/paper",
        snippet: "A prior external result.",
      },
    ])
    expect(String(result.messages[0].content)).toContain("## Retrieved Context")
    expect(String(result.messages[0].content)).toContain('<context id="E1" source="web"')
    expect(String(result.messages[0].content)).toContain("A prior external result.")
  })

  it("lets follow-up understanding reach the planner so retrieval history can be reused", async () => {
    const webSearch = vi.fn()
    let call = 0
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      call += 1
      callbacks.onToken(call === 1
        ? '{"intent":"follow_up","rewrittenQuery":"main points","wikiQueries":[],"graphQueries":[],"externalQueries":[],"needsWiki":false,"needsGraph":false,"needsExternal":false,"isFollowUp":true}'
        : '{"action":"finish","queries":[],"reason":"history is enough"}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig: { provider: "firecrawl", apiKey: "" },
      text: "What were the main points?",
      historyMessages: [{ role: "user", content: "What were the main points?" }],
      retrievalHistory: [
        {
          title: "External Paper",
          path: "https://example.com/paper",
          kind: "external",
          source: "web",
          url: "https://example.com/paper",
          snippet: "A prior external result.",
        },
      ],
      dataVersion: 1,
      options: { useWebSearch: true, useAnyTxtSearch: false },
      deps: { webSearch, streamChat },
    })

    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(webSearch).not.toHaveBeenCalled()
    expect(result.references).toHaveLength(1)
    expect(String(result.messages[0].content)).toContain("A prior external result.")
  })

  it("tells the planner when web search is enabled for the turn", async () => {
    const plannerUserPrompts: string[] = []
    const streamChat = vi.fn(async (_cfg, messages: LLMMessage[], callbacks) => {
      plannerUserPrompts.push(String(messages.find((msg) => msg.role === "user")?.content ?? ""))
      callbacks.onToken('{"action":"answer","queries":[]}')
      callbacks.onDone()
    })

    await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig: { provider: "firecrawl", apiKey: "" },
      text: "What's new in the latest release?",
      historyMessages: [{ role: "user", content: "What's new in the latest release?" }],
      dataVersion: 1,
      options: { useWebSearch: true, useAnyTxtSearch: false },
      deps: { streamChat },
    })

    expect(plannerUserPrompts[0]).toContain("User enabled Web Search for this turn: yes")
    expect(plannerUserPrompts[0]).toContain("User enabled AnyTXT Search for this turn: no")
    expect(plannerUserPrompts[0]).toContain("## Current Wiki Overview")
    expect(plannerUserPrompts[0]).toContain("This wiki covers transformer architecture")
    expect(plannerUserPrompts[1]).toContain("## Current Wiki Overview")
  })

  it("does not run tools when the planner chooses a direct answer", async () => {
    const searchWiki = vi.fn()
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"answer","queries":[],"answer":"This is a normal follow-up."}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig,
      text: "Can you rewrite that more clearly?",
      historyMessages: [{ role: "user", content: "Can you rewrite that more clearly?" }],
      dataVersion: 1,
      options: { useWebSearch: false, useAnyTxtSearch: false },
      deps: { searchWiki, streamChat },
    })

    expect(searchWiki).not.toHaveBeenCalled()
    expect(result.references).toEqual([])
    expect(String(result.messages[0].content)).toContain("Possible answer direction: This is a normal follow-up.")
    expect(String(result.messages[0].content)).not.toContain("Retrieved Context")
  })

  it("deduplicates repeated external retrieval items by url", async () => {
    const webSearch = vi.fn(async () => [
      {
        title: "Same Result A",
        url: "https://example.com/duplicate",
        snippet: "First copy.",
        source: "web",
      },
      {
        title: "Same Result B",
        url: "https://example.com/duplicate",
        snippet: "Second copy.",
        source: "web",
      },
    ])
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"external_search","queries":["duplicate result"]}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig: { provider: "firecrawl", apiKey: "" },
      text: "Search the web for duplicate result.",
      historyMessages: [{ role: "user", content: "Search the web for duplicate result." }],
      dataVersion: 1,
      options: { useWebSearch: true, useAnyTxtSearch: false },
      deps: { webSearch, streamChat },
    })

    expect(result.references).toHaveLength(1)
    expect(String(result.messages[0].content).match(/<context id="E\d+"/g)).toHaveLength(1)
  })

  it("keeps external search errors visible when no source returns results", async () => {
    const webSearch = vi.fn(async () => {
      throw new Error("Search provider unavailable")
    })
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"external_search","queries":["current outage"]}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig: { provider: "firecrawl", apiKey: "" },
      text: "Search for the current outage.",
      historyMessages: [{ role: "user", content: "Search for the current outage." }],
      dataVersion: 1,
      options: { useWebSearch: true, useAnyTxtSearch: false },
      deps: { webSearch, streamChat },
    })

    expect(result.references).toEqual([])
    expect(String(result.messages[0].content)).toContain("Retrieval status")
    expect(String(result.messages[0].content)).toContain("Search provider unavailable")
    expect(String(result.messages[0].content)).toContain("Do not apologize for lacking web access")
  })

  it("ranks query-overlapping wiki context ahead of weaker graph context", async () => {
    const searchWiki = vi.fn(async (projectPath: string, query: string) => {
      if (query === "attention") {
        return [
          {
            path: `${projectPath}/wiki/concepts/attention.md`,
            title: "Attention",
            snippet: "Attention lets models focus.",
            titleMatch: true,
            score: 1,
            images: [],
          },
        ]
      }
      return []
    })
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      callbacks.onToken('{"action":"multi_search","queries":["attention"]}')
      callbacks.onDone()
    })

    const result = await buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig,
      text: "Explain attention.",
      historyMessages: [{ role: "user", content: "Explain attention." }],
      dataVersion: 1,
      options: { useWebSearch: false, useAnyTxtSearch: false },
      deps: { searchWiki, streamChat },
    })

    const system = String(result.messages[0].content)
    expect(system.indexOf('title="Attention"')).toBeGreaterThan(-1)
    expect(system.indexOf('title="Transformer"')).toBeGreaterThan(system.indexOf('title="Attention"'))
  })

  it("stops the agent flow when the planner request is aborted", async () => {
    const controller = new AbortController()
    const searchWiki = vi.fn()
    const streamChat = vi.fn(async (_cfg, _messages, callbacks) => {
      controller.abort()
      callbacks.onDone()
    })

    await expect(buildChatAgentMessages({
      project: { name: "Demo", path: "/tmp/project" },
      llmConfig,
      searchApiConfig,
      text: "Search my wiki for attention.",
      historyMessages: [{ role: "user", content: "Search my wiki for attention." }],
      dataVersion: 1,
      options: { useWebSearch: false, useAnyTxtSearch: false },
      signal: controller.signal,
      deps: { searchWiki, streamChat },
    })).rejects.toMatchObject({ name: "AbortError" })

    expect(searchWiki).not.toHaveBeenCalled()
  })
})
