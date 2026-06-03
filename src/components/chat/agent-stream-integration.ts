import type {
  AgentStreamStats,
  AgentToolCallRecord,
} from "@/stores/chat-store"
import type {
  AgentToolEventPayload,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKResultMessage,
} from "@/lib/agent/agent-types"

/** Return true when an SDK message is an assistant content-block message. */
export function isSdkAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === "assistant"
    && Array.isArray((message as SDKAssistantMessage).message?.content)
}

/** Extract only text blocks from SDK content for fallback markdown rendering. */
export function sdkBlocksToText(blocks: SDKContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
}

/** Convert a final Agent SDK result into per-message chat-store stats. */
export function agentResultToStats(result: SDKResultMessage | null): AgentStreamStats | undefined {
  if (!result) return undefined
  return {
    agentSessionId: result.session_id,
    costUsd: result.cost_usd ?? result.total_cost_usd,
    inputTokens: result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
    durationMs: result.duration_ms,
    numTurns: result.num_turns,
  }
}

/** Convert one Agent tool event into the persisted timeline record shape. */
export function agentToolEventToRecord(event: AgentToolEventPayload): AgentToolCallRecord {
  return {
    toolName: event.toolName,
    toolUseId: event.toolUseId,
    phase: event.phase,
    ok: event.phase === "failure" && event.ok === undefined ? false : event.ok,
    durationMs: event.durationMs,
    inputPreview: event.inputPreview,
    error: event.error,
  }
}

/** Convert batch tool events into pending timeline records. */
export function agentToolBatchToRecords(event: AgentToolEventPayload): AgentToolCallRecord[] {
  return (event.toolCalls ?? []).map((call) => ({
    toolName: call.toolName,
    toolUseId: call.toolUseId,
    phase: "batch",
    inputPreview: call.inputPreview,
  }))
}
