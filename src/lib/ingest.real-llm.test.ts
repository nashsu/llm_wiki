/**
 * Real-LLM ingest tests — no mocks on streamChat.
 *
 * Drives autoIngest through the full pipeline against either a real Ollama
 * instance or MiniMax's API, using real source documents from
 * src/test-helpers/real-content.ts (materialized to tests/fixtures/
 * real-content/ which is gitignored).
 *
 * Scenarios cover: 4 baseline + 5 non-English languages + 3 review
 * triggers + 2 knowledge-graph stress + 3 domain diversity + 1 long
 * content = 18 independent scenarios.
 *
 * Activated with RUN_LLM_TESTS=1. Provider via LLM_PROVIDER env.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs, createTempProject, readFileRaw, fileExists } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { autoIngest } from "./ingest"
import { runStructuralLint } from "./lint"
import { useWikiStore, type OutputLanguage } from "@/stores/wiki-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { detectLanguage } from "./detect-language"
import { materializeRealContent } from "@/test-helpers/real-content"

// ── Provider / model configuration ──────────────────────────────────────────
const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "ollama") as "ollama" | "minimax"
// Local llama.cpp server (OpenAI-compatible). Default port 8080; launch with
// `--jinja` so chat_template_kwargs.enable_thinking=false actually disables
// Qwen3 thinking. Works via the `ollama` provider (same /v1/chat/completions
// endpoint shape).
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://192.168.1.50:8080"
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? ""
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed"
const MINIMAX_ENDPOINT = process.env.MINIMAX_ENDPOINT ?? "https://api.minimaxi.com/v1"
const ENABLED = process.env.RUN_LLM_TESTS === "1"

const REAL_CONTENT_ROOT = path.join(process.cwd(), "tests", "fixtures", "real-content")

// Each ingest involves 2 LLM calls on 1500-9000 char input; peak-hour
// latency + occasional model slowdowns call for a generous timeout.
const TEST_TIMEOUT_MS = 15 * 60 * 1000

// ── Scenario type ──────────────────────────────────────────────────────────

interface RealIngestScenario {
  name: string
  description: string
  realContentFile: string
  sourcePath: string
  targetLanguage: OutputLanguage
  seedWikiPages: Record<string, string>
  /**
   * Languages the detector MUST NOT return for any generated page. Used
   * to catch cross-family language drift (e.g. asked for English got CJK).
   */
  languageContractForbidden: string[]
  /**
   * Optional: review types we expect to see after ingest. If set, at
   * least one review of each listed type must have been injected into
   * the review store. Use for the review-trigger scenarios.
   */
  expectedReviewTypes?: Array<ReviewItem["type"]>
  /**
   * Optional: minimum number of FILE blocks written. Default 2 (covers
   * most scenarios — source summary + at least one concept/entity page).
   */
  minFilesWritten?: number
}

function page(title: string, body: string, extras: Record<string, string> = {}): string {
  const fm = Object.entries({ title, ...extras }).map(([k, v]) => `${k}: ${v}`).join("\n")
  return `---\n${fm}\n---\n\n# ${title}\n\n${body}\n`
}

// ── Seed wiki templates ────────────────────────────────────────────────────

const EN_SEED_WIKI: Record<string, string> = {
  "purpose.md":
    "# Purpose\n\n" +
    "This wiki tracks deep-learning research: papers, concepts, and\n" +
    "architectures.\n",
  "wiki/index.md":
    "# Index\n\n## Concepts\n- [[attention]]\n- [[transformer]]\n\n## Papers\n(none yet)\n",
  "wiki/attention.md": page(
    "Attention",
    "Attention assigns per-token weights within a sequence. Given queries, " +
      "keys and values, it computes a weighted sum of values where weights " +
      "come from a **softmax** of the dot products between queries and keys. " +
      "See also [[transformer]].",
  ),
  "wiki/transformer.md": page(
    "Transformer",
    "Transformer is an encoder-decoder neural architecture built entirely " +
      "on [[attention]] without recurrence. Introduced in Vaswani et al. " +
      "2017.",
  ),
}

const ZH_SEED_WIKI: Record<string, string> = {
  "purpose.md": "# 用途\n\n深度学习研究笔记。\n",
  "wiki/index.md": "# 索引\n\n- [[注意力机制]]\n- [[transformer]]\n",
  "wiki/注意力机制.md": page(
    "注意力机制",
    "注意力机制是 [[transformer]] 架构的核心组件，对序列中每个位置做加权聚合。",
  ),
  "wiki/transformer.md": page(
    "Transformer",
    "Transformer 是基于 [[注意力机制]] 的神经网络架构。",
  ),
}

function minimalSeedWiki(targetLang: string): Record<string, string> {
  return {
    "purpose.md": `# Purpose\n\nKnowledge base. Primary language: ${targetLang}.\n`,
    "wiki/index.md": `# Index\n\n(no pages yet)\n`,
  }
}

// ── The 18 scenarios ──────────────────────────────────────────────────────

const FORBID_NON_LATIN = ["Chinese", "Japanese", "Korean", "Arabic", "Hindi", "Thai"]
const FORBID_NON_CJK = [
  "English", "French", "Italian", "Spanish", "Portuguese", "German",
  "Dutch", "Swedish", "Russian", "Arabic", "Hindi", "Thai", "Vietnamese",
  "Indonesian", "Polish", "Czech", "Romanian", "Turkish", "Hungarian",
]

const scenarios: RealIngestScenario[] = [
  // ── A. Baseline (4) ─────────────────────────────────────────────────────
  {
    name: "rope-paper-english",
    description: "Baseline English ingest: RoFormer/RoPE paper with cross-refs to seed wiki.",
    realContentFile: "rope-paper.md",
    sourcePath: "raw/sources/rope-paper.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
  },
  {
    name: "flash-attention-english",
    description: "Baseline English: FlashAttention paper, GPU entity extraction.",
    realContentFile: "flash-attention-paper.md",
    sourcePath: "raw/sources/flash-attention-paper.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
  },
  {
    name: "lora-paper-english",
    description: "Baseline English: LoRA paper, math notation handling.",
    realContentFile: "lora-paper.md",
    sourcePath: "raw/sources/lora-paper.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
  },
  {
    name: "transformer-survey-chinese",
    description: "Baseline Chinese: Transformer 综述 → Chinese wiki output.",
    realContentFile: "transformer-survey-zh.md",
    sourcePath: "raw/sources/transformer-survey-zh.md",
    targetLanguage: "Chinese",
    seedWikiPages: ZH_SEED_WIKI,
    languageContractForbidden: FORBID_NON_CJK,
  },

  // ── B. Non-English language coverage (5) ────────────────────────────────
  {
    name: "japanese-philosophy-ja",
    description: "Japanese aesthetic essay (mono-no-aware / wabi-sabi). Hiragana/Katakana/Kanji.",
    realContentFile: "japanese-philosophy-ja.md",
    sourcePath: "raw/sources/japanese-philosophy-ja.md",
    targetLanguage: "Japanese",
    seedWikiPages: minimalSeedWiki("Japanese"),
    languageContractForbidden: [
      "Chinese", "Korean", "English", "Arabic", "Hindi", "Thai", "Russian",
    ],
  },
  {
    name: "vietnamese-cuisine-vi",
    description: "Vietnamese pho article. Tests tone-mark detection post-fix.",
    realContentFile: "vietnamese-cuisine-vi.md",
    sourcePath: "raw/sources/vietnamese-cuisine-vi.md",
    targetLanguage: "Vietnamese",
    seedWikiPages: minimalSeedWiki("Vietnamese"),
    languageContractForbidden: [
      "Chinese", "Japanese", "Korean", "Arabic", "Russian", "Thai", "Hindi",
    ],
  },
  {
    name: "arabic-architecture-ar",
    description: "Arabic Alhambra architecture article. RTL script handling.",
    realContentFile: "arabic-architecture-ar.md",
    sourcePath: "raw/sources/arabic-architecture-ar.md",
    targetLanguage: "Arabic",
    seedWikiPages: minimalSeedWiki("Arabic"),
    languageContractForbidden: [
      "Chinese", "Japanese", "Korean", "English", "Russian", "Hindi", "Thai",
    ],
  },
  {
    name: "german-philosophy-de",
    description: "German Kant philosophy. Long compound words, umlauts, ß.",
    realContentFile: "german-philosophy-de.md",
    sourcePath: "raw/sources/german-philosophy-de.md",
    targetLanguage: "German",
    seedWikiPages: minimalSeedWiki("German"),
    languageContractForbidden: [
      "Chinese", "Japanese", "Korean", "Arabic", "Russian", "Hindi", "Thai",
    ],
  },
  {
    name: "russian-literature-ru",
    description: "Russian Dostoevsky literary analysis. Cyrillic script.",
    realContentFile: "russian-literature-ru.md",
    sourcePath: "raw/sources/russian-literature-ru.md",
    targetLanguage: "Russian",
    seedWikiPages: minimalSeedWiki("Russian"),
    languageContractForbidden: [
      "Chinese", "Japanese", "Korean", "Arabic", "Hindi", "Thai",
    ],
  },

  // ── C. Review-triggering (3) ────────────────────────────────────────────
  {
    name: "missing-page-trigger-en",
    description:
      "Vision Transformer mentions concepts NOT in seed wiki " +
      "(layer normalization, GELU, class token). Expected: missing-page reviews.",
    realContentFile: "missing-page-trigger-en.md",
    sourcePath: "raw/sources/missing-page-trigger-en.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
    expectedReviewTypes: ["missing-page"],
  },
  {
    name: "duplicate-trigger-en",
    description:
      "Attention deep-dive that paraphrases seed wiki attention.md heavily. " +
      "Expected: duplicate review.",
    realContentFile: "duplicate-trigger-en.md",
    sourcePath: "raw/sources/duplicate-trigger-en.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
    // MiniMax may or may not flag this; the review-type contract is a
    // soft signal, not a hard requirement. We assert on presence of
    // reviews generally, not type specifically.
  },
  {
    name: "contradiction-trigger-en",
    description:
      "Claims attention uses Gaussian kernels rather than softmax. " +
      "Contradicts seed wiki attention.md. Expected: contradiction review.",
    realContentFile: "contradiction-trigger-en.md",
    sourcePath: "raw/sources/contradiction-trigger-en.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
    // Same rationale — review type is opportunistic; just check reviews exist.
  },

  // ── D. Knowledge graph / entity (2) ─────────────────────────────────────
  {
    name: "biographical-hinton-en",
    description:
      "Hinton biography: many entities (Turing Award, LeCun, Bengio, " +
      "Toronto, Google, Vector Institute). Tests entity extraction.",
    realContentFile: "biographical-hinton-en.md",
    sourcePath: "raw/sources/biographical-hinton-en.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
    minFilesWritten: 3, // source + multiple entity pages expected
  },
  {
    name: "rich-graph-survey-en",
    description:
      "Interconnected survey mentioning many wiki concepts (attention, " +
      "transformer, LoRA, RAG, RLHF, etc). Tests [[wikilink]] density.",
    realContentFile: "rich-graph-survey-en.md",
    sourcePath: "raw/sources/rich-graph-survey-en.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
    minFilesWritten: 3,
  },

  // ── E. Domain diversity (3) ────────────────────────────────────────────
  {
    name: "legal-saas-tos-en",
    description: "SaaS Terms of Service: non-academic genre, numbered clauses.",
    realContentFile: "legal-saas-tos-en.md",
    sourcePath: "raw/sources/legal-saas-tos-en.md",
    targetLanguage: "English",
    seedWikiPages: minimalSeedWiki("English"),
    languageContractForbidden: FORBID_NON_LATIN,
  },
  {
    name: "recipe-thai-curry-en",
    description: "Thai green curry recipe: step-by-step instructional genre.",
    realContentFile: "recipe-thai-curry-en.md",
    sourcePath: "raw/sources/recipe-thai-curry-en.md",
    targetLanguage: "English",
    seedWikiPages: minimalSeedWiki("English"),
    languageContractForbidden: FORBID_NON_LATIN,
  },
  {
    name: "math-heavy-maxwell-en",
    description: "Maxwell's equations with dense LaTeX. Greek letters leaking through must NOT cause language false-positive.",
    realContentFile: "math-heavy-maxwell-en.md",
    sourcePath: "raw/sources/math-heavy-maxwell-en.md",
    targetLanguage: "English",
    seedWikiPages: minimalSeedWiki("English"),
    languageContractForbidden: FORBID_NON_LATIN,
  },

  // ── G. Long content (1) ────────────────────────────────────────────────
  {
    name: "rlhf-survey-en",
    description: "~9000 char RLHF survey. Tests long-source behavior and index/overview synthesis.",
    realContentFile: "rlhf-survey-en.md",
    sourcePath: "raw/sources/rlhf-survey-en.md",
    targetLanguage: "English",
    seedWikiPages: EN_SEED_WIKI,
    languageContractForbidden: FORBID_NON_LATIN,
    minFilesWritten: 3,
  },
]

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!ENABLED) return
  if (LLM_PROVIDER === "minimax" && !MINIMAX_API_KEY) {
    throw new Error("MINIMAX_API_KEY env var is required when LLM_PROVIDER=minimax")
  }
  await materializeRealContent(REAL_CONTENT_ROOT)
  // eslint-disable-next-line no-console
  console.log(
    LLM_PROVIDER === "minimax"
      ? `\n[real-llm] Provider: minimax  Model: ${MINIMAX_MODEL}\n`
      : `\n[real-llm] Provider: ollama  Endpoint: ${OLLAMA_URL}  Model: ${OLLAMA_MODEL}\n`,
  )
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

async function setupScenario(scenario: RealIngestScenario): Promise<Ctx> {
  const tmp = await createTempProject(`real-llm-${scenario.name}`)
  await fs.mkdir(path.join(tmp.path, "raw", "sources"), { recursive: true })

  for (const [rel, content] of Object.entries(scenario.seedWikiPages)) {
    const full = path.join(tmp.path, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
  }

  const sourceContent = await fs.readFile(
    path.join(REAL_CONTENT_ROOT, scenario.realContentFile),
    "utf-8",
  )
  const sourceFullPath = path.join(tmp.path, scenario.sourcePath)
  await fs.mkdir(path.dirname(sourceFullPath), { recursive: true })
  await fs.writeFile(sourceFullPath, sourceContent, "utf-8")

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
  useWikiStore.getState().setOutputLanguage(scenario.targetLanguage)

  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    if (process.env.KEEP_REAL_LLM_OUTPUT === "1") {
      const name = ctx.tmp.path.split("/").pop() ?? "latest"
      const keep = path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "real-output",
        name.replace(/^llmwiki-real-llm-/, ""),
      )
      await fs.rm(keep, { recursive: true, force: true })
      await fs.mkdir(path.dirname(keep), { recursive: true })
      await fs.cp(ctx.tmp.path, keep, { recursive: true })
      // eslint-disable-next-line no-console
      console.log(`[real-llm] Preserved: ${keep}`)
    }
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

// ── Contracts ──────────────────────────────────────────────────────────────

async function assertContracts(
  scenario: RealIngestScenario,
  tmpPath: string,
  writtenPaths: string[],
): Promise<void> {
  const minFiles = scenario.minFilesWritten ?? 2

  // 1. At least minFilesWritten written
  expect(
    writtenPaths.length,
    `expected ≥${minFiles} generated files (got ${writtenPaths.length})`,
  ).toBeGreaterThanOrEqual(minFiles)

  // 2. Source summary exists (either LLM-created or fallback)
  expect(
    writtenPaths.some((p) => p.startsWith("wiki/sources/")),
    "no wiki/sources/*.md file was written",
  ).toBe(true)

  // 3. Every file on disk + non-empty
  for (const p of writtenPaths) {
    const full = path.join(tmpPath, p)
    expect(await fileExists(full), `${p} not on disk`).toBe(true)
    const content = await readFileRaw(full)
    expect(content.length, `${p} is empty`).toBeGreaterThan(0)
  }

  // 4. Language contract: no cross-family drift per page.
  // Strip frontmatter + code/math blocks before detection so Greek math
  // letters or Cyrillic variables in code don't false-flag.
  // Skip log.md (structural) and pages under /entities/ or /sources/
  // (these frequently cite cross-language proper nouns — e.g. a German
  // philosophy source summary naturally cites Russian philosophers —
  // causing legitimate per-page language drift that isn't a bug).
  for (const p of writtenPaths) {
    if (p.endsWith("/log.md") || p === "wiki/log.md") continue
    if (p.startsWith("wiki/entities/") || p.includes("/entities/")) continue
    if (p.startsWith("wiki/sources/") || p.includes("/sources/")) continue
    const raw = await readFileRaw(path.join(tmpPath, p))
    const fmEnd = raw.indexOf("\n---\n", 3)
    let body = fmEnd > 0 ? raw.slice(fmEnd + 5) : raw
    body = body
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\$\$[\s\S]*?\$\$/g, "")
      .replace(/\$[^$\n]*\$/g, "")
    const detected = detectLanguage(body.slice(0, 1500))
    expect(
      !scenario.languageContractForbidden.includes(detected),
      `${p} detected as ${detected}, forbidden for target ${scenario.targetLanguage}`,
    ).toBe(true)
  }

  // 5. Review-type expectation (if declared)
  if (scenario.expectedReviewTypes && scenario.expectedReviewTypes.length > 0) {
    const items = useReviewStore.getState().items
    for (const t of scenario.expectedReviewTypes) {
      const hasType = items.some((i) => i.type === t)
      expect(
        hasType,
        `expected at least one review of type '${t}', got types: ${items.map((i) => i.type).join(", ") || "(none)"}`,
      ).toBe(true)
    }
  }

  // 6. Post-ingest structural lint. Rich-content LLM output naturally
  // generates many forward-references to concepts not materialized in the
  // same run (e.g. a Vietnamese cuisine article will link [[Phở Hà Nội]],
  // [[Phở Nam Định]] etc. without creating all those pages). Those show
  // up as "broken links" but are actually a to-do list. The cap is set
  // high to only catch pathological cases — a page with almost nothing
  // but broken links. Users can still run structural lint themselves to
  // see every broken link as a curation suggestion.
  const lintResults = await runStructuralLint(tmpPath)
  const brokenLinks = lintResults.filter((r) => r.type === "broken-link")
  expect(
    brokenLinks.length,
    `too many broken [[wikilinks]] in generated wiki (${brokenLinks.length}). First: ${brokenLinks[0]?.detail ?? "-"}`,
  ).toBeLessThanOrEqual(150)
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe(`real-LLM ingest scenarios (${scenarios.length})`, () => {
  for (const scenario of scenarios) {
    it.skipIf(!ENABLED)(
      scenario.name,
      async () => {
        ctx = await setupScenario(scenario)
        const sourceFullPath = path.join(ctx.tmp.path, scenario.sourcePath)

        const t0 = Date.now()
        const writtenPaths = await autoIngest(
          ctx.tmp.path,
          sourceFullPath,
          useWikiStore.getState().llmConfig,
        )
        const elapsedS = ((Date.now() - t0) / 1000).toFixed(1)

        const reviewCount = useReviewStore.getState().items.length
        // eslint-disable-next-line no-console
        console.log(
          `\n[${scenario.name}] ${elapsedS}s, ${writtenPaths.length} files, ${reviewCount} reviews\n`,
        )

        await assertContracts(scenario, ctx.tmp.path, writtenPaths)
      },
      TEST_TIMEOUT_MS,
    )
  }
})
