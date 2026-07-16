/**
 * Real-LLM end-to-end chained scenario.
 *
 * Tests the full review → ingest → sweep feedback loop with real LLM:
 *   1. Ingest missing-page-trigger-en (Vision Transformer paper) against
 *      a seed wiki that has no Layer Normalization page. The LLM is
 *      expected to emit a missing-page review like "Missing page: Layer
 *      Normalization".
 *   2. Ingest layer-norm-resolver-en, which creates a concept page for
 *      Layer Normalization in the wiki.
 *   3. Run sweepResolvedReviews. The previously-pending missing-page
 *      review should now auto-resolve because the concept page exists.
 *
 * This exercises behavior no single-scenario test can: the review queue
 * persists across ingests, and sweep uses the evolving wiki state to
 * retire stale reviews.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs, createTempProject } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { autoIngest } from "./ingest"
import { sweepResolvedReviews } from "./sweep-reviews"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { materializeRealContent } from "@/test-helpers/real-content"

const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "ollama") as "ollama" | "minimax"
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://192.168.1.50:8080"
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? ""
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed"
const MINIMAX_ENDPOINT = process.env.MINIMAX_ENDPOINT ?? "https://api.minimaxi.com/v1"
const ENABLED = process.env.RUN_LLM_TESTS === "1"

const REAL_CONTENT_ROOT = path.join(process.cwd(), "tests", "fixtures", "real-content")
const TEST_TIMEOUT_MS = 20 * 60 * 1000

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`
}

const EN_SEED_WIKI: Record<string, string> = {
  "purpose.md": "# Purpose\n\nDeep-learning research notes.\n",
  "wiki/index.md":
    "# Index\n\n## Concepts\n- [[attention]]\n- [[transformer]]\n\n## Papers\n(none yet)\n",
  "wiki/attention.md": page(
    "Attention",
    "Attention assigns per-token weights within a sequence. See also [[transformer]].",
  ),
  "wiki/transformer.md": page(
    "Transformer",
    "Transformer is built on [[attention]]. Introduced in 2017.",
  ),
}

beforeAll(async () => {
  if (!ENABLED) return
  if (LLM_PROVIDER === "minimax" && !MINIMAX_API_KEY) {
    throw new Error("MINIMAX_API_KEY env var is required when LLM_PROVIDER=minimax")
  }
  await materializeRealContent(REAL_CONTENT_ROOT)
})

beforeEach(() => {
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })
})

interface Ctx {
  tmp: { path: string; cleanup: () => Promise<void> }
}
let ctx: Ctx | undefined

async function setup(): Promise<Ctx> {
  const tmp = await createTempProject("sweep-chained")
  await fs.mkdir(path.join(tmp.path, "raw", "sources"), { recursive: true })

  for (const [rel, content] of Object.entries(EN_SEED_WIKI)) {
    const full = path.join(tmp.path, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
  }

  useWikiStore.setState({
    project: {
      name: "sweep-chained",
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
  useWikiStore.getState().setOutputLanguage("English")

  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

async function copySourceIntoProject(
  fileName: string,
  tmpPath: string,
): Promise<string> {
  const content = await fs.readFile(
    path.join(REAL_CONTENT_ROOT, fileName),
    "utf-8",
  )
  const dest = path.join(tmpPath, "raw", "sources", fileName)
  await fs.writeFile(dest, content, "utf-8")
  return dest
}

describe("real-LLM sweep chained (ingest → ingest → sweep)", () => {
  it.skipIf(!ENABLED)(
    "second ingest satisfies missing-page review from first ingest",
    async () => {
      ctx = await setup()

      // ─── Step 1: First ingest. Expected to produce missing-page reviews.
      const trigger = await copySourceIntoProject(
        "missing-page-trigger-en.md",
        ctx.tmp.path,
      )
      const t1 = Date.now()
      const firstWritten = await autoIngest(
        ctx.tmp.path,
        trigger,
        useWikiStore.getState().llmConfig,
      )
      // eslint-disable-next-line no-console
      console.log(
        `\n[chain step 1] ${((Date.now() - t1) / 1000).toFixed(1)}s, ` +
          `${firstWritten.length} files, ${useReviewStore.getState().items.length} reviews\n`,
      )

      const reviewsAfterFirst = useReviewStore.getState().items
      // Must produce at least one missing-page review (otherwise the chain
      // scenario can't proceed).
      const missingPageReviews = reviewsAfterFirst.filter(
        (r) => r.type === "missing-page",
      )
      expect(
        missingPageReviews.length,
        "expected at least one missing-page review from first ingest",
      ).toBeGreaterThanOrEqual(1)
      // eslint-disable-next-line no-console
      console.log(
        `  missing-page reviews: ${missingPageReviews
          .map((r) => JSON.stringify(r.title))
          .join(", ")}`,
      )

      // ─── Step 2: Ingest the resolver doc for Layer Normalization.
      const resolver = await copySourceIntoProject(
        "layer-norm-resolver-en.md",
        ctx.tmp.path,
      )
      const t2 = Date.now()
      const secondWritten = await autoIngest(
        ctx.tmp.path,
        resolver,
        useWikiStore.getState().llmConfig,
      )
      // eslint-disable-next-line no-console
      console.log(
        `\n[chain step 2] ${((Date.now() - t2) / 1000).toFixed(1)}s, ` +
          `${secondWritten.length} files, ${useReviewStore.getState().items.length} reviews total\n`,
      )

      // Confirm a Layer Normalization page was actually written. The
      // resolver doc is explicit enough that the LLM should always
      // produce a wiki/concepts/*normalization*.md-ish file.
      const hasLayerNormPage = secondWritten.some((p) =>
        /layer[-_]?norm|normalization/i.test(p.toLowerCase()),
      )
      expect(
        hasLayerNormPage,
        `no layer-norm concept page written in step 2 (got: ${secondWritten.join(", ")})`,
      ).toBe(true)

      // ─── Step 3: Run sweep and expect auto-resolution.
      const t3 = Date.now()
      const resolvedCount = await sweepResolvedReviews(ctx.tmp.path)
      // eslint-disable-next-line no-console
      console.log(
        `\n[chain step 3] sweep ${((Date.now() - t3) / 1000).toFixed(1)}s, ` +
          `resolved ${resolvedCount} items\n`,
      )

      // Check if any of the missing-page reviews from step 1 have been
      // marked resolved. The titles should mention concepts the resolver
      // doc covered (layer normalization).
      const itemsAfterSweep = useReviewStore.getState().items
      const step1Ids = missingPageReviews.map((r) => r.id)
      const step1Resolved = itemsAfterSweep.filter(
        (i) => step1Ids.includes(i.id) && i.resolved,
      )

      // eslint-disable-next-line no-console
      console.log(
        `  step-1 reviews now resolved: ${step1Resolved
          .map((i) => `${i.id}:${i.title}`)
          .join(", ") || "(none)"}`,
      )

      // Contract: sweep must have resolved at least ONE step-1 review
      // (the Layer Normalization one, since we explicitly created that
      // concept page). If the LLM's review title doesn't mention Layer
      // Normalization specifically, this might not trigger — which is
      // itself useful diagnostic signal.
      expect(
        step1Resolved.length,
        "sweep should have resolved at least one missing-page review " +
          "after its concept page was created in step 2",
      ).toBeGreaterThanOrEqual(1)

      // Sanity: resolvedCount total includes step-1 items
      expect(resolvedCount).toBeGreaterThanOrEqual(step1Resolved.length)
    },
    TEST_TIMEOUT_MS,
  )
})
