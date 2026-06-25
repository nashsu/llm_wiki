/**
 * Scenario-driven sweep tests.
 *
 * Each scenario (defined in src/test-helpers/scenarios/sweep-scenarios.ts):
 *   1. Materializes a tests/fixtures/scenarios/<name>/ folder with a real
 *      initial-wiki, reviews.json, llm-response.txt, expected.json.
 *   2. Copies initial-wiki into a tmp project dir.
 *   3. Injects the reviews into useReviewStore.
 *   4. If an llm-response.txt exists, mocks streamChat to emit it; otherwise
 *      disables the LLM stage entirely (apiKey="").
 *   5. Runs sweepResolvedReviews.
 *   6. Asserts resolvedIds / pendingIds / per-ID resolvedActions.
 *
 * The materialized fixtures are gitignored — the TS definitions are the
 * only source tracked in version control. This lets the author eyeball the
 * generated files on disk during debugging.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject } from "@/test-helpers/fs-temp"
import {
  materializeScenario,
  copyDir,
} from "@/test-helpers/scenarios/materialize"
import { sweepScenarios } from "@/test-helpers/scenarios/sweep-scenarios"
import type { SweepScenario, ReviewFixture } from "@/test-helpers/scenarios/types"

vi.mock("@/commands/fs", () => realFs)

// The LLM client is mocked per-test so we can inject the scenario's
// llm-response.txt verbatim (streamed as a single token chunk, then onDone).
let currentLlmResponse: string | null = null
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _msgs, cb) => {
    if (currentLlmResponse !== null) {
      cb.onToken(currentLlmResponse)
    }
    cb.onDone()
  }),
}))

import { sweepResolvedReviews } from "./sweep-reviews"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"

const FIXTURES_ROOT = path.join(process.cwd(), "tests", "fixtures", "scenarios")

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Fresh start — clear any stale fixtures from previous runs so the disk
  // tree is always an accurate reflection of the TS source.
  await fs.rm(FIXTURES_ROOT, { recursive: true, force: true })
  await fs.mkdir(FIXTURES_ROOT, { recursive: true })
  // Materialize every scenario upfront.
  for (const scenario of sweepScenarios) {
    await materializeScenario(scenario, FIXTURES_ROOT)
  }
})

beforeEach(() => {
  currentLlmResponse = null
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
})

// ── Scenario runner ─────────────────────────────────────────────────────────

interface RunContext {
  tmp: { path: string; cleanup: () => Promise<void> }
}

async function setupScenario(scenario: SweepScenario): Promise<RunContext> {
  const tmp = await createTempProject(`scenario-${scenario.name.replace(/\//g, "-")}`)

  // Copy initial-wiki into the tmp project
  const initialWikiDir = path.join(FIXTURES_ROOT, scenario.name, "initial-wiki")
  await copyDir(initialWikiDir, tmp.path)

  // Inject reviews (fill in the runtime-only fields)
  const reviewsPath = path.join(FIXTURES_ROOT, scenario.name, "reviews.json")
  const reviewsRaw = JSON.parse(await fs.readFile(reviewsPath, "utf-8")) as ReviewFixture[]
  useReviewStore.setState({
    items: reviewsRaw.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      description: r.description ?? "",
      affectedPages: r.affectedPages,
      searchQueries: r.searchQueries,
      sourcePath: r.sourcePath,
      options: [],
      resolved: false,
      createdAt: 0,
    })),
  })

  // Project identity for the sweep's project-identity guard
  useWikiStore.setState({
    project: {
      name: "test",
      path: tmp.path,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })

  // LLM config: real key iff the scenario has an LLM response. Otherwise,
  // empty apiKey makes judgeBatch return an empty Set (no LLM calls).
  const llmResponsePath = path.join(FIXTURES_ROOT, scenario.name, "llm-response.txt")
  try {
    currentLlmResponse = await fs.readFile(llmResponsePath, "utf-8")
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
  } catch {
    // No llm-response.txt — disable LLM stage
    currentLlmResponse = null
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 0,
    })
  }

  return { tmp }
}

function assertWithDump(
  scenario: SweepScenario,
  actualResolved: string[],
  actualPending: string[],
  actualActions: Record<string, string>,
) {
  const expected = scenario.expected
  const storeItems = useReviewStore.getState().items

  try {
    expect(actualResolved.sort()).toEqual(expected.resolvedIds.slice().sort())
    expect(actualPending.sort()).toEqual(expected.pendingIds.slice().sort())
    if (expected.resolvedActions) {
      for (const [id, action] of Object.entries(expected.resolvedActions)) {
        expect(actualActions[id]).toBe(action)
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `\n[scenario: ${scenario.name}] FAILED — actual review store state:\n` +
        JSON.stringify(
          storeItems.map((i) => ({
            id: i.id,
            type: i.type,
            title: i.title,
            resolved: i.resolved,
            resolvedAction: i.resolvedAction,
          })),
          null,
          2,
        ),
    )
    throw err
  }
}

// ── Test cases ──────────────────────────────────────────────────────────────

describe("sweep scenarios (fixture-driven)", () => {
  // Keep context at the describe scope so afterEach can clean up even if
  // the test itself throws.
  let ctx: RunContext | undefined

  afterEach(async () => {
    if (ctx) {
      await ctx.tmp.cleanup()
      ctx = undefined
    }
  })

  it.each(sweepScenarios.map((s) => [s.name, s]))(
    "%s",
    async (_name, scenario) => {
      ctx = await setupScenario(scenario)

      await sweepResolvedReviews(ctx.tmp.path)

      const state = useReviewStore.getState().items
      const actualResolved = state.filter((i) => i.resolved).map((i) => i.id)
      const actualPending = state.filter((i) => !i.resolved).map((i) => i.id)
      const actualActions = Object.fromEntries(
        state
          .filter((i) => i.resolved && i.resolvedAction)
          .map((i) => [i.id, i.resolvedAction!]),
      )

      assertWithDump(scenario, actualResolved, actualPending, actualActions)
    },
  )
})
