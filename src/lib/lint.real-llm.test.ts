/**
 * Real-LLM lint tests — exercises runSemanticLint against MiniMax.
 *
 * Only one scenario (semantic/contradiction-found) actually calls the LLM.
 * The 4 structural scenarios are deterministic and covered by the mocked
 * runner. Here we just verify the semantic path works end-to-end with a
 * real model and that any returned LintResults parse into the right shape.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs, createTempProject } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { runSemanticLint } from "./lint"
import { useWikiStore } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { lintScenarios } from "@/test-helpers/scenarios/lint-scenarios"

const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "ollama") as "ollama" | "minimax"
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://192.168.1.50:8080"
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? ""
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed"
const MINIMAX_ENDPOINT = process.env.MINIMAX_ENDPOINT ?? "https://api.minimaxi.com/v1"
const ENABLED = process.env.RUN_LLM_TESTS === "1"

const TEST_TIMEOUT_MS = 5 * 60 * 1000

// Only the scenarios that invoke the semantic (LLM) stage
const scenarios = lintScenarios.filter((s) => s.llmResponse !== undefined)

beforeAll(() => {
  if (!ENABLED) return
  if (LLM_PROVIDER === "minimax" && !MINIMAX_API_KEY) {
    throw new Error("MINIMAX_API_KEY env var is required when LLM_PROVIDER=minimax")
  }
})

beforeEach(() => {
  useActivityStore.setState({ items: [] })
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(scenario: typeof lintScenarios[number]): Promise<Ctx> {
  const tmp = await createTempProject(`real-llm-lint-${scenario.name.replace(/\//g, "-")}`)

  for (const [rel, content] of Object.entries(scenario.initialWiki)) {
    const full = path.join(tmp.path, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
  }

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

describe("real-LLM lint scenarios (semantic only)", () => {
  for (const scenario of scenarios) {
    it.skipIf(!ENABLED)(
      scenario.name,
      async () => {
        ctx = await setup(scenario)

        const t0 = Date.now()
        const results = await runSemanticLint(
          ctx.tmp.path,
          useWikiStore.getState().llmConfig,
        )
        const elapsedS = ((Date.now() - t0) / 1000).toFixed(1)

        // eslint-disable-next-line no-console
        console.log(
          `\n[lint-real: ${scenario.name}] ${elapsedS}s, ${results.length} findings: ` +
            results.map((r) => `[${r.type}|${r.severity}] ${r.page}`).join("; ") +
            "\n",
        )

        // Contract 1: runSemanticLint returns an array (possibly empty)
        expect(Array.isArray(results)).toBe(true)

        // Contract 2: every result has the expected shape
        for (const r of results) {
          expect(r.type, "missing type").toBeTruthy()
          expect(r.severity, "missing severity").toBeTruthy()
          expect(["warning", "info"].includes(r.severity)).toBe(true)
          expect(typeof r.page, "page not a string").toBe("string")
          expect(typeof r.detail, "detail not a string").toBe("string")
          expect(r.page.length, "empty page").toBeGreaterThan(0)
        }

        // Contract 3: activity store has a terminal entry
        const items = useActivityStore.getState().items
        expect(items.length).toBeGreaterThan(0)
        expect(
          ["done", "error"].includes(items[0].status),
          `activity item not in terminal state: ${items[0].status}`,
        ).toBe(true)
      },
      TEST_TIMEOUT_MS,
    )
  }
})
