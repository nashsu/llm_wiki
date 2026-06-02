import type { AgentToolCallRecord } from "@/stores/chat-store"
import type { SDKContentBlock } from "@/lib/agent/agent-types"

export type AgentToolStatus = "pending" | "running" | "done" | "failed"

export function getAgentToolStatus(call: AgentToolCallRecord): AgentToolStatus {
  if (call.phase === "failure" || call.ok === false) return "failed"
  if (call.phase === "pre") return "running"
  if (call.phase === "post") return "done"
  return "pending"
}

export function formatDurationMs(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`
}

export function formatCostUsd(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
}

export function formatTokenCount(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  return Math.max(0, Math.round(value)).toLocaleString("en-US")
}

export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item !== "object" || item === null) return item
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
        return item
      },
      2,
    )
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Extract assistant-visible text blocks for copy/save/reference fallbacks. */
export function extractAgentTextContent(blocks?: SDKContentBlock[]): string {
  if (!blocks || blocks.length === 0) return ""
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n")
}
