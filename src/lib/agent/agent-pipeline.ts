/**
 * Multi-Agent Pipeline (Phase 3.65-E)
 *
 * Defines built-in subagent roles and a pipeline schema for orchestrating
 * multiple agent tools in sequence or parallel.
 *
 * Built-in subagents:
 *   - wiki-compiler: ingests source content into wiki pages
 *   - wiki-linter: runs structural + semantic lint, generates report
 *   - wiki-fixer: auto-fixes lint issues from a report
 *   - wiki-synthesizer: cross-article synthesis via deep research
 *   - wiki-qa: answers questions using wiki knowledge base
 */

// ── Subagent definitions ─────────────────────────────────────────────────────

export type SubagentId =
  | "wiki-compiler"
  | "wiki-linter"
  | "wiki-fixer"
  | "wiki-synthesizer"
  | "wiki-qa"

export interface SubagentDef {
  id: SubagentId
  label: string
  description: string
  /** Tool name to call via runAgentAppTool */
  toolName: string
  /** Default arguments (merged with step-level overrides) */
  defaultArgs: Record<string, unknown>
}

export const SUBAGENT_DEFS: Record<SubagentId, SubagentDef> = {
  "wiki-compiler": {
    id: "wiki-compiler",
    label: "Wiki Compiler",
    description: "Compiles source documents into structured wiki pages",
    toolName: "ingest_source",
    defaultArgs: {},
  },
  "wiki-linter": {
    id: "wiki-linter",
    label: "Wiki Linter",
    description: "Runs structural + semantic lint and generates a health report",
    toolName: "run_lint_and_report",
    defaultArgs: { includeStructural: true, includeSemantic: false, autoFix: false },
  },
  "wiki-fixer": {
    id: "wiki-fixer",
    label: "Wiki Fixer",
    description: "Auto-fixes all fixable items in a lint report",
    toolName: "fix_lint_report",
    defaultArgs: {},
  },
  "wiki-synthesizer": {
    id: "wiki-synthesizer",
    label: "Wiki Synthesizer",
    description: "Runs cross-article synthesis and deep research",
    toolName: "run_deep_research",
    defaultArgs: {},
  },
  "wiki-qa": {
    id: "wiki-qa",
    label: "Wiki QA",
    description: "Answers questions using the wiki knowledge base",
    toolName: "build_answer_context",
    defaultArgs: {},
  },
}

// ── Pipeline schema ──────────────────────────────────────────────────────────

export type StepMode = "sequential" | "parallel"

export interface PipelineStep {
  id: string
  subagentId: SubagentId
  /** Override default args for this step */
  args?: Record<string, unknown>
  /** If set, use the output of a prior step as input arg.
   *  resultKey extracts a specific key from the prior step's result. */
  inputFrom?: { stepId: string; argName: string; resultKey?: string }
}

export interface PipelineStage {
  /** Steps in this stage. If mode is "parallel", all run concurrently. */
  mode: StepMode
  steps: PipelineStep[]
}

export interface PipelineSchema {
  name: string
  description: string
  stages: PipelineStage[]
}

// ── Built-in pipelines ───────────────────────────────────────────────────────

/**
 * Full ingest pipeline: compile → lint → fix → autofill.
 * Runs sequentially so each step sees the previous step's writes.
 */
export const INGEST_PIPELINE: PipelineSchema = {
  name: "full-ingest",
  description: "Compile source, lint, fix issues, then autofill properties",
  stages: [
    {
      mode: "sequential",
      steps: [
        { id: "compile", subagentId: "wiki-compiler" },
        {
          id: "lint",
          subagentId: "wiki-linter",
          args: { includeStructural: true, includeSemantic: false, autoFix: false },
        },
      ],
    },
    {
      mode: "sequential",
      steps: [
        {
          id: "fix",
          subagentId: "wiki-fixer",
          inputFrom: { stepId: "lint", argName: "report", resultKey: "report" },
        },
      ],
    },
  ],
}

/** Lint + fix cycle (no compilation). */
export const LINT_FIX_PIPELINE: PipelineSchema = {
  name: "lint-fix",
  description: "Run lint, then auto-fix all fixable issues",
  stages: [
    {
      mode: "sequential",
      steps: [
        {
          id: "lint",
          subagentId: "wiki-linter",
          args: { includeStructural: true, includeSemantic: true, autoFix: false },
        },
        {
          id: "fix",
          subagentId: "wiki-fixer",
          inputFrom: { stepId: "lint", argName: "report", resultKey: "report" },
        },
      ],
    },
  ],
}

export const BUILTIN_PIPELINES: Record<string, PipelineSchema> = {
  "full-ingest": INGEST_PIPELINE,
  "lint-fix": LINT_FIX_PIPELINE,
}

// ── Pipeline executor ────────────────────────────────────────────────────────

export type ToolRunner = (toolName: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>

export interface StepResult {
  stepId: string
  subagentId: SubagentId
  ok: boolean
  result: unknown
  error?: string
  durationMs: number
}

export interface PipelineResult {
  pipelineName: string
  ok: boolean
  steps: StepResult[]
  totalDurationMs: number
}

/**
 * Execute a pipeline schema.
 *
 * Runs stages sequentially; within each stage, steps run either sequentially
 * or in parallel based on `mode`. Data flows between steps via `inputFrom`.
 */
export async function executePipeline(
  schema: PipelineSchema,
  runTool: ToolRunner,
  globalArgs?: Record<string, unknown>,
): Promise<PipelineResult> {
  const allResults: StepResult[] = []
  const resultsByStep = new Map<string, StepResult>()
  const start = Date.now()

  for (const stage of schema.stages) {
    if (stage.mode === "parallel") {
      // Run all steps concurrently
      const promises = stage.steps.map((step) =>
        executeStep(step, runTool, globalArgs, resultsByStep),
      )
      const stageResults = await Promise.all(promises)
      for (const r of stageResults) {
        allResults.push(r)
        resultsByStep.set(r.stepId, r)
      }
    } else {
      // Run steps sequentially
      for (const step of stage.steps) {
        const r = await executeStep(step, runTool, globalArgs, resultsByStep)
        allResults.push(r)
        resultsByStep.set(r.stepId, r)

        // Abort stage on failure
        if (!r.ok) {
          return {
            pipelineName: schema.name,
            ok: false,
            steps: allResults,
            totalDurationMs: Date.now() - start,
          }
        }
      }
    }
  }

  return {
    pipelineName: schema.name,
    ok: allResults.every((r) => r.ok),
    steps: allResults,
    totalDurationMs: Date.now() - start,
  }
}

async function executeStep(
  step: PipelineStep,
  runTool: ToolRunner,
  globalArgs: Record<string, unknown> | undefined,
  priorResults: Map<string, StepResult>,
): Promise<StepResult> {
  const def = SUBAGENT_DEFS[step.subagentId]
  const start = Date.now()

  // Merge: global args < default args < step args < inputFrom
  const args: Record<string, unknown> = {
    ...globalArgs,
    ...def.defaultArgs,
    ...step.args,
  }

  // Resolve inputFrom: pull result from a prior step
  if (step.inputFrom) {
    const source = priorResults.get(step.inputFrom.stepId)
    if (source?.ok && source.result != null) {
      const val = step.inputFrom.resultKey
        ? (source.result as Record<string, unknown>)[step.inputFrom.resultKey]
        : source.result
      args[step.inputFrom.argName] = val
    }
  }

  try {
    const response = await runTool(def.toolName, args)
    return {
      stepId: step.id,
      subagentId: step.subagentId,
      ok: response.ok,
      result: response.result,
      error: response.ok ? undefined : String(response.result),
      durationMs: Date.now() - start,
    }
  } catch (err) {
    return {
      stepId: step.id,
      subagentId: step.subagentId,
      ok: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    }
  }
}
