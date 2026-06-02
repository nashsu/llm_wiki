import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import "@/i18n"
import { AgentBlockList } from "./agent-block-list"
import { AgentCostCard } from "./agent-cost-card"
import { AgentToolTimeline } from "./agent-tool-timeline"
import { ChatMessage } from "./chat-message"
import type { DisplayMessage } from "@/stores/chat-store"

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}))

function assistantMessage(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "Plain answer",
    timestamp: 0,
    conversationId: "conv-1",
    ...overrides,
  }
}

describe("agent message rendering", () => {
  it("renders agent cost card when stats exist", () => {
    const html = renderToStaticMarkup(
      <AgentCostCard
        costUsd={0.12}
        inputTokens={1000}
        outputTokens={50}
        durationMs={1250}
        numTurns={2}
      />,
    )

    expect(html).toContain("Agent run")
    expect(html).toContain("$0.12")
    expect(html).toContain("1,000")
    expect(html).toContain("1.3 s")
  })

  it("renders tool timeline details when expanded", () => {
    const html = renderToStaticMarkup(
      <AgentToolTimeline
        defaultCollapsed={false}
        toolCalls={[
          {
            toolName: "wiki_read",
            toolUseId: "tool-1",
            phase: "failure",
            error: "boom",
            inputPreview: { path: "wiki/index.md" },
          },
        ]}
      />,
    )

    expect(html).toContain("Tool calls")
    expect(html).toContain("wiki_read")
    expect(html).toContain("Failed")
    expect(html).toContain("boom")
    expect(html).toContain("wiki/index.md")
  })

  it("renders SDK content blocks", () => {
    const html = renderToStaticMarkup(
      <AgentBlockList
        blocks={[
          { type: "text", text: "Hello from agent" },
          { type: "tool_use", id: "tool-1", name: "wiki_search", input: { q: "rope" } },
          { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "Found result" }] },
        ]}
        renderText={(text) => <p>{text}</p>}
      />,
    )

    expect(html).toContain("Hello from agent")
    expect(html).toContain("Tool use")
    expect(html).toContain("wiki_search")
    expect(html).toContain("Found result")
  })

  it("keeps ordinary assistant messages free of agent chrome", () => {
    const html = renderToStaticMarkup(<ChatMessage message={assistantMessage()} />)

    expect(html).toContain("Plain answer")
    expect(html).not.toContain("Tool calls")
    expect(html).not.toContain("Agent run")
  })

  it("renders agent blocks, timeline, and cost for agent messages", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          mode: "agent",
          agentBlocks: [
            { type: "text", text: "Agent text" },
            { type: "tool_use", id: "tool-1", name: "wiki_read", input: { path: "wiki/index.md" } },
          ],
          toolCalls: [
            {
              toolName: "wiki_read",
              toolUseId: "tool-1",
              phase: "post",
              ok: true,
              durationMs: 20,
            },
          ],
          costUsd: 0.01,
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 1000,
          numTurns: 1,
        })}
      />,
    )

    expect(html).toContain("Agent text")
    expect(html).toContain("Tool use")
    expect(html).toContain("Tool calls")
    expect(html).toContain("Agent run")
  })

  it("uses agent block text as a fallback for references when content is empty", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantMessage({
          content: "",
          mode: "agent",
          agentBlocks: [
            { type: "text", text: "See [[Phase 4 Notes]]" },
          ],
        })}
      />,
    )

    expect(html).toContain("wikilink:Phase 4 Notes")
    expect(html).toContain("References (1)")
  })
})
