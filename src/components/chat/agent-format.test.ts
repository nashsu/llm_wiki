import { describe, expect, it } from "vitest"
import {
  formatCostUsd,
  formatDurationMs,
  formatTokenCount,
  getAgentToolStatus,
  safeStringify,
} from "./agent-format"

describe("agent render helpers", () => {
  it("maps tool phases to display statuses", () => {
    expect(getAgentToolStatus({ toolName: "a", phase: "pre" })).toBe("running")
    expect(getAgentToolStatus({ toolName: "a", phase: "post", ok: true })).toBe("done")
    expect(getAgentToolStatus({ toolName: "a", phase: "post", ok: false })).toBe("failed")
    expect(getAgentToolStatus({ toolName: "a", phase: "failure" })).toBe("failed")
    expect(getAgentToolStatus({ toolName: "a", phase: "batch" })).toBe("pending")
  })

  it("formats duration, cost, and token values", () => {
    expect(formatDurationMs(250)).toBe("250 ms")
    expect(formatDurationMs(1500)).toBe("1.5 s")
    expect(formatCostUsd(0.0042)).toBe("$0.0042")
    expect(formatCostUsd(0.42)).toBe("$0.42")
    expect(formatTokenCount(1234)).toBe("1,234")
  })

  it("safeStringify handles circular references", () => {
    const value: Record<string, unknown> = { name: "root" }
    value.self = value

    expect(safeStringify(value)).toContain("[Circular]")
  })
})
