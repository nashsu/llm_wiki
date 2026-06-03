import { describe, expect, it } from "vitest"
import {
  agentResultToStats,
  agentToolBatchToRecords,
  agentToolEventToRecord,
  isSdkAssistantMessage,
  sdkBlocksToText,
} from "./agent-stream-integration"
import type { SDKMessage } from "@/lib/agent/agent-types"

describe("agent stream integration helpers", () => {
  it("detects SDK assistant messages with content blocks", () => {
    const message: SDKMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    }

    expect(isSdkAssistantMessage(message)).toBe(true)
    if (!isSdkAssistantMessage(message)) throw new Error("expected assistant message")
    expect(sdkBlocksToText(message.message.content)).toBe("hello")
  })

  it("extracts final stats from SDK result messages", () => {
    expect(agentResultToStats({
      type: "result",
      result: "done",
      session_id: "session-1",
      total_cost_usd: 0.12,
      duration_ms: 250,
      num_turns: 2,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    })).toEqual({
      agentSessionId: "session-1",
      costUsd: 0.12,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 250,
      numTurns: 2,
    })
  })

  it("maps tool events into store records", () => {
    expect(agentToolEventToRecord({
      phase: "failure",
      toolName: "Bash",
      toolUseId: "tool-1",
      inputPreview: { command: "pwd" },
      error: "no",
    })).toEqual({
      phase: "failure",
      toolName: "Bash",
      toolUseId: "tool-1",
      ok: false,
      inputPreview: { command: "pwd" },
      error: "no",
    })
  })

  it("maps batch tool events to pending records", () => {
    expect(agentToolBatchToRecords({
      phase: "batch",
      toolName: "batch",
      toolCalls: [
        {
          toolName: "wiki_read",
          toolUseId: "tool-1",
          inputPreview: { path: "wiki/index.md" },
        },
      ],
    })).toEqual([
      {
        phase: "batch",
        toolName: "wiki_read",
        toolUseId: "tool-1",
        inputPreview: { path: "wiki/index.md" },
      },
    ])
  })
})
