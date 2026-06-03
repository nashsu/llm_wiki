import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useLintStore } from "@/stores/lint-store"
import { runStructuralLint } from "@/lib/lint"
import {
  clearAgentStructuralLintQueue,
  enqueueAgentStructuralLint,
} from "./agent-lint-queue"

vi.mock("@/lib/lint", () => ({
  runStructuralLint: vi.fn(),
}))

const mockedRunStructuralLint = vi.mocked(runStructuralLint)

describe("agent structural lint queue", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockedRunStructuralLint.mockReset()
    clearAgentStructuralLintQueue()
    useLintStore.setState({
      items: [],
      agentLint: { status: "idle", paths: [] },
    })
  })

  afterEach(() => {
    clearAgentStructuralLintQueue()
    vi.useRealTimers()
  })

  it("debounces paths and writes agent-sourced lint results", async () => {
    mockedRunStructuralLint.mockResolvedValue([
      {
        type: "broken-link",
        severity: "warning",
        page: "page.md",
        detail: "broken",
      },
    ])

    enqueueAgentStructuralLint("/tmp/project", ["wiki/page.md"], 10)
    enqueueAgentStructuralLint("/tmp/project", ["wiki/other.md"], 10)
    await vi.advanceTimersByTimeAsync(10)

    expect(mockedRunStructuralLint).toHaveBeenCalledWith("/tmp/project")
    expect(useLintStore.getState().agentLint.status).toBe("done")
    expect(useLintStore.getState().items).toMatchObject([
      {
        page: "page.md",
        source: "agent",
      },
    ])
  })

  it("replaces only previous agent lint items", async () => {
    useLintStore.getState().addItems([
      {
        type: "orphan",
        severity: "info",
        page: "manual.md",
        detail: "manual",
      },
    ])
    mockedRunStructuralLint.mockResolvedValue([
      {
        type: "broken-link",
        severity: "warning",
        page: "agent.md",
        detail: "agent",
      },
    ])

    enqueueAgentStructuralLint("/tmp/project", ["wiki/agent.md"], 1)
    await vi.advanceTimersByTimeAsync(1)

    expect(useLintStore.getState().items.map((item) => item.page)).toEqual([
      "manual.md",
      "agent.md",
    ])
  })
})
