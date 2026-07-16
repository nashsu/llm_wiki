/**
 * Real-LLM sweep tests — exercises the LLM-judged stage against MiniMax.
 *
 * Uses only the sweep scenarios whose rule stage can't resolve everything
 * (so the LLM stage actually fires). Asserts contracts:
 *   - Sweep completes without throwing
 *   - All resolved IDs came from the input review set
 *   - Review types that must stay pending (contradiction/confirm) aren't
 *     mass-resolved
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs, createTempProject } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { sweepResolvedReviews } from "./sweep-reviews"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { sweepScenarios } from "@/test-helpers/scenarios/sweep-scenarios"

const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "ollama") as "ollama" | "minimax"
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://192.168.1.50:8080"
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? ""
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed"
const MINIMAX_ENDPOINT = process.env.MINIMAX_ENDPOINT ?? "https://api.minimaxi.com/v1"
const ENABLED = process.env.RUN_LLM_TESTS === "1"

const TEST_TIMEOUT_MS = 5 * 60 * 1000

// Only run scenarios that actually invoke the LLM stage (i.e. have reviews
// the rule stage can't resolve). The 10 rule-only scenarios are fully
// deterministic and already covered by the mocked runner.
const LLM_SCENARIO_NAMES = new Set([
  "llm-judged/semantic-match",
  "mixed-batch/partial-resolution",
])
const scenarios = sweepScenarios.filter((s) => LLM_SCENARIO_NAMES.has(s.name))

beforeAll(() => {
  if (!ENABLED) return
  if (LLM_PROVIDER === "minimax" && !MINIMAX_API_KEY) {
    throw new Error("MINIMAX_API_KEY env var is required when LLM_PROVIDER=minimax")
  }
})

beforeEach(() => {
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(scenario: typeof sweepScenarios[number]): Promise<Ctx> {
  const tmp = await createTempProject(`real-llm-sweep-${scenario.name.replace(/\//g, "-")}`)

  for (const [rel, content] of Object.entries(scenario.initialWiki)) {
    const full = path.join(tmp.path, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
  }

  useReviewStore.setState({
    items: scenario.reviews.map((r) => ({
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

  useWikiStore.setState({
    project: {
      name: "test",
      path: tmp.path,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })
  useWikiStore.getState().setLlmConfig(
    LLM_PROVIDER === "minimax"
      ? {
          provider: "custom",
          apiKey: MINIMAX_API_KEY,
          model: MINIMAX_MODEL,
          ollamaUrl: "",
          customEndpoint: MINIMAX_ENDPOINT,
          maxContextSize: 110000,
        }
      : {
          provider: "ollama",
          apiKey: "",
          model: OLLAMA_MODEL,
          ollamaUrl: OLLAMA_URL,
          customEndpoint: "",
          maxContextSize: 110000,
        },
  )

  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

describe("real-LLM sweep scenarios (LLM-judged only)", () => {
  for (const scenario of scenarios) {
    it.skipIf(!ENABLED)(
      scenario.name,
      async () => {
        ctx = await setup(scenario)
        const inputIds = new Set(scenario.reviews.map((r) => r.id))

        const t0 = Date.now()
        const total = await sweepResolvedReviews(ctx.tmp.path)
        const elapsedS = ((Date.now() - t0) / 1000).toFixed(1)

        const state = useReviewStore.getState().items
        const resolved = state.filter((i) => i.resolved)
        const resolvedIds = resolved.map((i) => i.id)

        // eslint-disable-next-line no-console
        console.log(
          `\n[sweep-real: ${scenario.name}] ${elapsedS}s, ` +
            `resolved ${total}/${scenario.reviews.length} ` +
            `(${resolvedIds.join(", ") || "none"})\n`,
        )

        // Contract 1: Every resolved ID must have come from the input batch
        for (const id of resolvedIds) {
          expect(
            inputIds.has(id),
            `unexpected resolved ID ${id} not in input`,
          ).toBe(true)
        }

        // Contract 2: Resolved items carry a valid resolvedAction
        for (const item of resolved) {
          expect(
            item.resolvedAction,
            `${item.id} resolved but has no resolvedAction`,
          ).toBeTruthy()
          expect(
            ["auto-resolved", "llm-judged"].includes(item.resolvedAction!),
            `${item.id} has unknown action: ${item.resolvedAction}`,
          ).toBe(true)
        }

        // Contract 3: Total count matches the number of resolved items
        expect(total).toBe(resolvedIds.length)

        // Contract 4: Input item count preserved (nothing added, nothing lost)
        expect(state.length).toBe(scenario.reviews.length)

        // ── Scenario-specific strict assertions ────────────────────────
        // These catch regressions that the generic contracts miss.
        if (scenario.name === "mixed-batch/partial-resolution") {
          // r-mix-rule is a rule-resolvable missing-page review — its
          // target page DOES exist in the wiki, so rules must resolve it.
          const ruleResolved = state.find((i) => i.id === "r-mix-rule")
          expect(
            ruleResolved?.resolved,
            "r-mix-rule should ALWAYS be resolved by rule stage",
          ).toBe(true)
          expect(ruleResolved?.resolvedAction).toBe("auto-resolved")

          // r-mix-contra is a contradiction — MUST stay pending regardless
          // of LLM behavior. If this ever resolves, the conservative
          // filter in sweep is broken.
          const contraItem = state.find((i) => i.id === "r-mix-contra")
          expect(
            contraItem?.resolved,
            "r-mix-contra (contradiction) must NEVER be auto-resolved",
          ).toBe(false)

          // r-mix-sugg is a suggestion — rule stage must NOT touch it
          // (LLM stage might, conservatively). Check it's not resolved
          // by rules specifically.
          const suggItem = state.find((i) => i.id === "r-mix-sugg")
          if (suggItem?.resolved) {
            expect(
              suggItem.resolvedAction,
              "suggestion can only be resolved by LLM, not rules",
            ).toBe("llm-judged")
          }
        }

        if (scenario.name === "llm-judged/semantic-match") {
          // LIMITATION: the sweep judge only sends page FILENAMES + TITLES
          // to the LLM, not body content. Semantic matching of 'Context
          // Window' to attention.md depends on the LLM's general knowledge
          // that attention windows = context windows. This is best-effort;
          // we assert the operation completes cleanly rather than demand
          // the LLM always make the leap.
          // If it ever resolves, the action must be llm-judged.
          for (const item of resolved) {
            expect(item.resolvedAction).toBe("llm-judged")
          }
        }
      },
      TEST_TIMEOUT_MS,
    )
  }
})
