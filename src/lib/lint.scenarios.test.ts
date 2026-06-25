/**
 * Scenario-driven lint tests.
 *
 * Exercises runStructuralLint (always) and runSemanticLint (when the
 * scenario provides an llm-response.txt) against a materialized wiki dir.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject } from "@/test-helpers/fs-temp"
import { materializeScenario, copyDir } from "@/test-helpers/scenarios/materialize"
import { lintScenarios } from "@/test-helpers/scenarios/lint-scenarios"
import type { LintScenario } from "@/test-helpers/scenarios/types"

vi.mock("@/commands/fs", () => realFs)

let currentLlmResponse: string | null = null
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _msgs, cb) => {
    if (currentLlmResponse !== null) cb.onToken(currentLlmResponse)
    cb.onDone()
  }),
}))

import { runStructuralLint, runSemanticLint, type LintResult } from "./lint"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"

const FIXTURES_ROOT = path.join(process.cwd(), "tests", "fixtures", "scenarios-lint")

const shimScenarios = lintScenarios // shorthand

beforeAll(async () => {
  await fs.rm(FIXTURES_ROOT, { recursive: true, force: true })
  await fs.mkdir(FIXTURES_ROOT, { recursive: true })
  for (const s of shimScenarios) {
    await materializeScenario(s, FIXTURES_ROOT)
  }
})

beforeEach(() => {
  currentLlmResponse = null
  useActivityStore.setState({ items: [] })
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(scenario: LintScenario): Promise<Ctx> {
  const tmp = await createTempProject(
    `lint-${scenario.name.replace(/\//g, "-")}`,
  )
  const initialWikiDir = path.join(FIXTURES_ROOT, scenario.name, "initial-wiki")
  await copyDir(initialWikiDir, tmp.path)

  useWikiStore.setState({
    project: {
      name: "t",
      path: tmp.path,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  if (scenario.llmResponse !== undefined) {
    currentLlmResponse = await fs.readFile(
      path.join(FIXTURES_ROOT, scenario.name, "llm-response.txt"),
      "utf-8",
    )
  }
  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

// ── Assertions ──────────────────────────────────────────────────────────────

function assertStructural(
  scenario: LintScenario,
  actual: LintResult[],
): void {
  const expected = scenario.expected.structural
  try {
    expect(actual.length).toBe(expected.length)
    for (const e of expected) {
      const match = actual.find(
        (a) =>
          a.type === e.type &&
          a.page.includes(e.page) &&
          (e.linkName === undefined || a.detail.includes(e.linkName)),
      )
      expect(match, `no structural finding matching ${JSON.stringify(e)}`).toBeTruthy()
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `\n[lint: ${scenario.name}] structural mismatch. Actual findings:\n` +
        JSON.stringify(actual, null, 2),
    )
    throw err
  }
}

function assertSemantic(
  scenario: LintScenario,
  actual: LintResult[],
): void {
  const expected = scenario.expected.semantic ?? []
  try {
    expect(actual.length).toBe(expected.length)
    for (const e of expected) {
      const match = actual.find(
        (a) =>
          a.type === e.type &&
          a.severity === (e.severity as "warning" | "info") &&
          (e.titleContains === undefined || a.detail.includes(e.titleContains) ||
            a.page.includes(e.titleContains)),
      )
      expect(match, `no semantic finding matching ${JSON.stringify(e)}`).toBeTruthy()
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `\n[lint: ${scenario.name}] semantic mismatch. Actual findings:\n` +
        JSON.stringify(actual, null, 2),
    )
    throw err
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("lint scenarios (fixture-driven)", () => {
  it.each(shimScenarios.map((s) => [s.name, s]))(
    "%s",
    async (_name, scenario) => {
      ctx = await setup(scenario)

      const structural = await runStructuralLint(ctx.tmp.path)
      assertStructural(scenario, structural)

      if (scenario.llmResponse !== undefined) {
        const semantic = await runSemanticLint(
          ctx.tmp.path,
          useWikiStore.getState().llmConfig,
        )
        assertSemantic(scenario, semantic)
      }
    },
  )
})
