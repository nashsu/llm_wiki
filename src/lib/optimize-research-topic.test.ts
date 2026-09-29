import { describe, it, expect, beforeEach, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

// Mock streamChat — we don't want real network, we just want to capture
// the prompt sent to the LLM and simulate a canned response.
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(),
}))

import { optimizeResearchTopic } from "./optimize-research-topic"
import { streamChat } from "./llm-client"
import { useWikiStore } from "@/stores/wiki-store"

const mockStreamChat = vi.mocked(streamChat)

function fakeLlmConfig(): LlmConfig {
  return {
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  }
}

// Helper: simulate streamChat firing a canned response then completing.
function mockStreamChatReturns(text: string) {
  mockStreamChat.mockImplementation(async (_config, _msgs, callbacks) => {
    callbacks.onToken(text)
    callbacks.onDone()
  })
}

beforeEach(() => {
  mockStreamChat.mockReset()
  useWikiStore.getState().setOutputLanguage("auto")
  mockStreamChatReturns("TOPIC: Test topic\nQUERY: q1\nQUERY: q2\nQUERY: q3")
})

describe("optimizeResearchTopic — language directive", () => {
  it("includes MANDATORY OUTPUT LANGUAGE header in the prompt", async () => {
    useWikiStore.getState().setOutputLanguage("Chinese")
    await optimizeResearchTopic(fakeLlmConfig(), "gap", "desc", "missing-page", "", "")

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("honors auto mode by detecting from gap content", async () => {
    useWikiStore.getState().setOutputLanguage("auto")
    await optimizeResearchTopic(
      fakeLlmConfig(),
      "注意力机制",
      "Transformer 里的核心组件",
      "missing-page",
      "深度学习 Wiki 总览",
      "专注于深度学习研究",
    )

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("user setting beats the detected source language", async () => {
    useWikiStore.getState().setOutputLanguage("English")
    await optimizeResearchTopic(
      fakeLlmConfig(),
      "注意力机制",
      "Transformer 里的核心组件",
      "missing-page",
      "",
      "",
    )

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("MANDATORY OUTPUT LANGUAGE: English")
    expect(prompt).not.toContain("MANDATORY OUTPUT LANGUAGE: Chinese")
  })

  it("TOPIC output-format hint tells the LLM to use the mandatory language", async () => {
    await optimizeResearchTopic(fakeLlmConfig(), "x", "y", "suggestion", "", "")
    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("TOPIC:")
    expect(prompt).toMatch(/TOPIC:.*mandatory output language/i)
  })
})

describe("optimizeResearchTopic — response parsing", () => {
  it("extracts topic and 3 queries from the expected format", async () => {
    mockStreamChatReturns([
      "TOPIC: How does attention scale with context length",
      "QUERY: attention transformer context length scaling",
      "QUERY: long context attention mechanisms survey",
      "QUERY: efficient attention sparse",
    ].join("\n"))

    const result = await optimizeResearchTopic(fakeLlmConfig(), "x", "y", "z", "", "")
    expect(result.topic).toBe("How does attention scale with context length")
    expect(result.searchQueries).toEqual([
      "attention transformer context length scaling",
      "long context attention mechanisms survey",
      "efficient attention sparse",
    ])
  })

  it("falls back to gapTitle when the LLM response has no TOPIC line", async () => {
    mockStreamChatReturns("")
    const result = await optimizeResearchTopic(fakeLlmConfig(), "original gap", "", "z", "", "")
    expect(result.topic).toBe("original gap")
    // Fallback: when no queries parsed, uses the topic as the single query
    expect(result.searchQueries).toEqual(["original gap"])
  })

  it("caps queries at 3 even if the LLM emits more", async () => {
    mockStreamChatReturns([
      "TOPIC: t",
      "QUERY: 1", "QUERY: 2", "QUERY: 3", "QUERY: 4", "QUERY: 5",
    ].join("\n"))
    const result = await optimizeResearchTopic(fakeLlmConfig(), "x", "y", "z", "", "")
    expect(result.searchQueries).toHaveLength(3)
  })
})

describe("optimizeResearchTopic — project-local vocabulary", () => {
  it("requires ambiguous internal terms to remain grounded in wiki context", async () => {
    await optimizeResearchTopic(
      fakeLlmConfig(),
      "AF",
      "An attention-filter signal used by the project pipeline",
      "missing-page",
      "The wiki documents a private cognitive-analysis system.",
      "Explain the project's signal-processing architecture.",
    )

    const prompt = mockStreamChat.mock.calls[0][1][0].content
    expect(prompt).toContain("project-local vocabulary")
    expect(prompt).toContain("Never emit a bare ambiguous term as a web query")
    expect(prompt).toContain("Do not substitute a popular public meaning")
    expect(prompt).toContain("no likely public documentation")
    expect(prompt).toContain("An attention-filter signal used by the project pipeline")
  })

  it("expands a bare model query with local context", async () => {
    mockStreamChatReturns("TOPIC: AF\nQUERY: AF")

    const result = await optimizeResearchTopic(
      fakeLlmConfig(),
      "AF",
      "attention filter signal in a cognitive-analysis pipeline",
      "missing-page",
      "",
      "",
    )

    expect(result.searchQueries).toHaveLength(1)
    expect(result.searchQueries[0]).toContain("AF")
    expect(result.searchQueries[0]).toContain("attention filter signal")
    expect(result.searchQueries[0]).not.toBe("AF")
  })
})
