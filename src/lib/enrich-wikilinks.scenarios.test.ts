/**
 * Scenario-driven tests for enrichWithWikilinks.
 *
 * Each scenario materializes an initial wiki, runs enrichWithWikilinks on
 * a specified page with a canned LLM response, then asserts whether the
 * file on disk was overwritten and (if so) whether it has the expected
 * content exactly.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject, readFileRaw } from "@/test-helpers/fs-temp"
import { materializeScenario, copyDir } from "@/test-helpers/scenarios/materialize"
import { enrichScenarios } from "@/test-helpers/scenarios/enrich-scenarios"
import type { EnrichScenario } from "@/test-helpers/scenarios/types"

vi.mock("@/commands/fs", () => realFs)

let currentLlmResponse = ""
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, _msgs, cb) => {
    cb.onToken(currentLlmResponse)
    cb.onDone()
  }),
}))

import { enrichWithWikilinks } from "./enrich-wikilinks"
import { useWikiStore } from "@/stores/wiki-store"

const FIXTURES_ROOT = path.join(process.cwd(), "tests", "fixtures", "scenarios-enrich")

beforeAll(async () => {
  await fs.rm(FIXTURES_ROOT, { recursive: true, force: true })
  await fs.mkdir(FIXTURES_ROOT, { recursive: true })
  for (const s of enrichScenarios) {
    await materializeScenario(s, FIXTURES_ROOT)
  }
})

beforeEach(() => {
  currentLlmResponse = ""
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(scenario: EnrichScenario): Promise<Ctx> {
  const tmp = await createTempProject(
    `enrich-${scenario.name.replace(/\//g, "-")}`,
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

  currentLlmResponse = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-response.txt"),
    "utf-8",
  )
  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

describe("enrich-wikilinks scenarios (fixture-driven)", () => {
  it.each(enrichScenarios.map((s) => [s.name, s]))(
    "%s",
    async (_name, scenario) => {
      ctx = await setup(scenario)
      const pagePath = path.join(ctx.tmp.path, scenario.pageToEnrich)
      const originalContent = await readFileRaw(pagePath)

      await enrichWithWikilinks(
        ctx.tmp.path,
        pagePath,
        useWikiStore.getState().llmConfig,
      )

      const finalContent = await readFileRaw(pagePath)

      try {
        if (scenario.expected.writeCalled) {
          expect(finalContent).not.toBe(originalContent)
          if (scenario.expected.expectedContent !== undefined) {
            expect(finalContent).toBe(scenario.expected.expectedContent)
          }
        } else {
          expect(finalContent).toBe(originalContent)
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `\n[enrich: ${scenario.name}] FAILED.\n` +
            `--- ORIGINAL ---\n${originalContent}\n` +
            `--- FINAL ---\n${finalContent}\n` +
            `--- LLM RESPONSE ---\n${currentLlmResponse}\n`,
        )
        throw err
      }
    },
  )
})
