import { describe, expect, it, vi } from "vitest"
import {
  executePipeline,
  INGEST_PIPELINE,
  LINT_FIX_PIPELINE,
  SUBAGENT_DEFS,
  BUILTIN_PIPELINES,
  type ToolRunner,
} from "./agent-pipeline"

function makeMockRunner(): ToolRunner {
  return vi.fn(async (toolName: string, _args: Record<string, unknown>) => ({
    ok: true,
    result: { tool: toolName, done: true },
  }))
}

describe("SUBAGENT_DEFS", () => {
  it("defines all 5 built-in subagents", () => {
    expect(Object.keys(SUBAGENT_DEFS)).toEqual([
      "wiki-compiler",
      "wiki-linter",
      "wiki-fixer",
      "wiki-synthesizer",
      "wiki-qa",
    ])
  })

  it("each subagent has required fields", () => {
    for (const def of Object.values(SUBAGENT_DEFS)) {
      expect(def.id).toBeTruthy()
      expect(def.label).toBeTruthy()
      expect(def.description).toBeTruthy()
      expect(def.toolName).toBeTruthy()
      expect(def.defaultArgs).toBeDefined()
    }
  })
})

describe("BUILTIN_PIPELINES", () => {
  it("has full-ingest and lint-fix", () => {
    expect(Object.keys(BUILTIN_PIPELINES)).toEqual(["full-ingest", "lint-fix"])
  })
})

describe("INGEST_PIPELINE", () => {
  it("has expected stages", () => {
    expect(INGEST_PIPELINE.stages).toHaveLength(2)
    expect(INGEST_PIPELINE.stages[0].steps.map((s) => s.subagentId)).toEqual([
      "wiki-compiler",
      "wiki-linter",
    ])
    expect(INGEST_PIPELINE.stages[1].steps.map((s) => s.subagentId)).toEqual([
      "wiki-fixer",
    ])
  })
})

describe("LINT_FIX_PIPELINE", () => {
  it("has 1 stage with lint then fix", () => {
    expect(LINT_FIX_PIPELINE.stages).toHaveLength(1)
    expect(LINT_FIX_PIPELINE.stages[0].steps.map((s) => s.subagentId)).toEqual([
      "wiki-linter",
      "wiki-fixer",
    ])
  })
})

describe("executePipeline", () => {
  it("runs sequential steps in order", async () => {
    const callOrder: string[] = []
    const runner: ToolRunner = vi.fn(async (toolName: string) => {
      callOrder.push(toolName)
      return { ok: true, result: { tool: toolName } }
    })

    const result = await executePipeline(LINT_FIX_PIPELINE, runner)
    expect(result.ok).toBe(true)
    expect(result.steps).toHaveLength(2)
    expect(callOrder).toEqual(["run_lint_and_report", "fix_lint_report"])
  })

  it("passes inputFrom data between steps", async () => {
    const runner: ToolRunner = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === "run_lint_and_report") {
        return { ok: true, result: { report: { healthScore: 80 } } }
      }
      // fix_lint_report should receive report from lint step
      return { ok: true, result: { fixed: true, receivedReport: args.report } }
    })

    const result = await executePipeline(LINT_FIX_PIPELINE, runner)
    expect(result.ok).toBe(true)
    // The fix step should have received the report
    const fixCall = (runner as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "fix_lint_report",
    )
    expect(fixCall).toBeTruthy()
    expect(fixCall![1]).toMatchObject({ report: { healthScore: 80 } })
  })

  it("aborts on sequential step failure", async () => {
    const runner: ToolRunner = vi.fn(async (toolName: string) => {
      if (toolName === "run_lint_and_report") {
        return { ok: false, result: "lint failed" }
      }
      return { ok: true, result: { fixed: true } }
    })

    const result = await executePipeline(LINT_FIX_PIPELINE, runner)
    expect(result.ok).toBe(false)
    expect(result.steps).toHaveLength(1) // second step was skipped
  })

  it("records duration for each step", async () => {
    const runner = makeMockRunner()
    const result = await executePipeline(LINT_FIX_PIPELINE, runner)
    for (const step of result.steps) {
      expect(step.durationMs).toBeGreaterThanOrEqual(0)
    }
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0)
  })

  it("runs parallel steps concurrently", async () => {
    const startTimes: string[] = []
    const runner: ToolRunner = vi.fn(async (toolName: string) => {
      startTimes.push(toolName)
      return { ok: true, result: { tool: toolName } }
    })

    const schema = {
      name: "parallel-test",
      description: "test",
      stages: [
        {
          mode: "parallel" as const,
          steps: [
            { id: "a", subagentId: "wiki-compiler" as const },
            { id: "b", subagentId: "wiki-linter" as const },
          ],
        },
      ],
    }

    const result = await executePipeline(schema, runner)
    expect(result.ok).toBe(true)
    expect(result.steps).toHaveLength(2)
    // Both tools should have been called
    expect(startTimes).toContain("ingest_source")
    expect(startTimes).toContain("run_lint_and_report")
  })

  it("merges global args, default args, and step args", async () => {
    const capturedArgs: Record<string, unknown>[] = []
    const runner: ToolRunner = vi.fn(async (_toolName: string, args: Record<string, unknown>) => {
      capturedArgs.push(args)
      return { ok: true, result: {} }
    })

    const schema = {
      name: "merge-test",
      description: "test",
      stages: [
        {
          mode: "sequential" as const,
          steps: [
            {
              id: "lint",
              subagentId: "wiki-linter" as const,
              args: { includeSemantic: true },
            },
          ],
        },
      ],
    }

    await executePipeline(schema, runner, { globalFlag: true })
    expect(capturedArgs[0]).toMatchObject({
      globalFlag: true,
      includeStructural: true, // from defaultArgs
      includeSemantic: true, // step override
      autoFix: false, // from defaultArgs
    })
  })
})
