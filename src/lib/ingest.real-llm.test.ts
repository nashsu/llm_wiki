/**
 * Real-LLM ingest tests — no mocks on streamChat.
 *
 * Drives autoIngest through the full pipeline against either a real Ollama
 * instance or MiniMax's API, using real 1500-5500 character source
 * documents. Assertions are CONTRACTS (structural properties any sane LLM
 * output must satisfy), not predicted content.
 *
 * Activated with RUN_LLM_TESTS=1. Provider selection via LLM_PROVIDER env.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs, createTempProject, readFileRaw, fileExists } from "@/test-helpers/fs-temp"

// FS boundary → real node:fs. LLM client stays unmocked so streamChat
// hits the network for real.
vi.mock("@/commands/fs", () => realFs)

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { detectLanguage } from "./detect-language"

// ── Provider / model configuration ──────────────────────────────────────────
const LLM_PROVIDER = (process.env.LLM_PROVIDER ?? "ollama") as "ollama" | "minimax"
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://192.168.1.50:11434"
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b"
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY ?? ""
const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed"
const MINIMAX_ENDPOINT = process.env.MINIMAX_ENDPOINT ?? "https://api.minimaxi.com/v1"
const ENABLED = process.env.RUN_LLM_TESTS === "1"

// Real content documents are checked into git under src/test-helpers/
// (NOT tests/fixtures/ — that path is gitignored) so other developers can
// reproduce these tests without regenerating content.
const REAL_CONTENT_ROOT = path.join(process.cwd(), "src", "test-helpers", "real-content")

// Generous timeout to accommodate peak-hour API latency.
// Two LLM calls per ingest × 1-4 min each + IO overhead.
const TEST_TIMEOUT_MS = 10 * 60 * 1000

// ── Scenarios: real content + target language + expected characteristics ───
interface RealIngestScenario {
  name: string
  description: string
  realContentFile: string
  sourcePath: string
  targetLanguage: "English" | "Chinese"
  /** Wiki pages that already exist and the LLM should link to via [[wikilinks]] */
  seedWikiPages: Record<string, string>
  /**
   * Languages that MUST NOT be detected in the output. Use for cross-family
   * language mismatches: e.g. if we asked for English, a Chinese output is
   * wrong. But Greek (from math notation leaking through) or minor Latin
   * misfires (English detected as Italian) are acceptable.
   */
  languageContractForbidden: Array<string>
}

function pageFile(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`
}

const SHARED_WIKI: Record<string, string> = {
  "purpose.md":
    "# Purpose\n\n" +
    "This wiki tracks deep-learning research: papers, concepts, and\n" +
    "architectures. Each source document becomes a summary page under\n" +
    "wiki/sources/, and the concepts it introduces or refines get their\n" +
    "own pages under wiki/concepts/.\n",
  "wiki/index.md":
    "# Index\n\n## Concepts\n- [[attention]]\n- [[transformer]]\n\n## Papers\n(none yet)\n",
  "wiki/attention.md": pageFile(
    "Attention",
    "Attention assigns per-token weights within a sequence. Given queries, " +
      "keys and values, it computes a weighted sum of values where weights " +
      "come from a similarity function between queries and keys. See also " +
      "[[transformer]].",
  ),
  "wiki/transformer.md": pageFile(
    "Transformer",
    "Transformer is an encoder-decoder neural architecture built entirely " +
      "on [[attention]] without recurrence. Introduced in Vaswani et al. " +
      "2017, it has become the backbone for most modern NLP models.",
  ),
}

const scenarios: RealIngestScenario[] = [
  {
    name: "rope-paper-english",
    description:
      "RoFormer/RoPE paper excerpt (5438 chars). English content, English output. " +
      "References [[attention]] and [[transformer]] in existing wiki.",
    realContentFile: "rope-paper.md",
    sourcePath: "raw/sources/rope-paper.md",
    targetLanguage: "English",
    seedWikiPages: SHARED_WIKI,
    languageContractForbidden: [
      "Chinese", "Japanese", "Korean", "Arabic", "Hindi", "Thai",
    ],
  },
  {
    name: "flash-attention-english",
    description:
      "FlashAttention paper excerpt (4478 chars). Exercises [[attention]] + " +
      "[[transformer]] cross-links and GPU-memory-specific terminology.",
    realContentFile: "flash-attention-paper.md",
    sourcePath: "raw/sources/flash-attention-paper.md",
    targetLanguage: "English",
    seedWikiPages: SHARED_WIKI,
    languageContractForbidden: [
      "Chinese", "Japanese", "Korean", "Arabic", "Hindi", "Thai",
    ],
  },
  {
    name: "lora-paper-english",
    description:
      "LoRA paper excerpt (4367 chars). Parameter-efficient fine-tuning, " +
      "tests generation of math notation and rank decomposition concepts.",
    realContentFile: "lora-paper.md",
    sourcePath: "raw/sources/lora-paper.md",
    targetLanguage: "English",
    seedWikiPages: SHARED_WIKI,
    languageContractForbidden: [
      "Chinese", "Japanese", "Korean", "Arabic", "Hindi", "Thai",
    ],
  },
  {
    name: "transformer-survey-chinese",
    description:
      "Chinese Transformer 综述 (4438 chars). Tests Chinese source → Chinese " +
      "wiki output, UTF-8 round-trip through FILE blocks.",
    realContentFile: "transformer-survey-zh.md",
    sourcePath: "raw/sources/transformer-survey-zh.md",
    targetLanguage: "Chinese",
    seedWikiPages: {
      "purpose.md": "# 用途\n\n深度学习研究笔记。\n",
      "wiki/index.md": "# 索引\n\n- [[注意力机制]]\n- [[transformer]]\n",
      "wiki/注意力机制.md": pageFile(
        "注意力机制",
        "注意力机制是 [[transformer]] 架构的核心组件,用于对序列中每个位置的 token 进行加权聚合。",
      ),
      "wiki/transformer.md": pageFile(
        "Transformer",
        "Transformer 是一种基于 [[注意力机制]] 的神经网络架构。",
      ),
    },
    // Chinese target: everything non-CJK is wrong
    languageContractForbidden: [
      "English", "French", "Italian", "Spanish", "Portuguese", "Japanese",
      "Korean", "Arabic", "Hindi", "Thai", "Russian", "Vietnamese",
      "Indonesian", "German",
    ],
  },
]

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  if (!ENABLED) return
  if (LLM_PROVIDER === "minimax" && !MINIMAX_API_KEY) {
    throw new Error("MINIMAX_API_KEY env var is required when LLM_PROVIDER=minimax")
  }
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

  // Seed the initial wiki pages
  for (const [rel, content] of Object.entries(scenario.seedWikiPages)) {
    const full = path.join(tmp.path, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, "utf-8")
  }

  // Copy the real source document into the project
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
          maxContextSize: 128000,
        }
      : {
          provider: "ollama",
          apiKey: "",
          model: OLLAMA_MODEL,
          ollamaUrl: OLLAMA_URL,
          customEndpoint: "",
          maxContextSize: 128000,
        },
  )
  useWikiStore.getState().setOutputLanguage(scenario.targetLanguage)

  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    if (process.env.KEEP_REAL_LLM_OUTPUT === "1") {
      const scenarioName = ctx.tmp.path.split("/").pop() ?? "latest"
      const keep = path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "real-output",
        scenarioName.replace(/^llmwiki-real-llm-/, ""),
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

// ── Contract assertions ────────────────────────────────────────────────────

async function assertContracts(
  scenario: RealIngestScenario,
  tmpPath: string,
  writtenPaths: string[],
): Promise<void> {
  // 1. At least ONE file was written
  expect(writtenPaths.length, "expected at least one generated wiki file").toBeGreaterThan(0)

  // 2. A source summary page exists (either LLM-created or fallback)
  expect(
    writtenPaths.some((p) => p.startsWith("wiki/sources/")),
    "no wiki/sources/*.md file was written",
  ).toBe(true)

  // 3. Every generated file is on disk + non-empty
  for (const p of writtenPaths) {
    const full = path.join(tmpPath, p)
    expect(await fileExists(full), `${p} not on disk`).toBe(true)
    const content = await readFileRaw(full)
    expect(content.length, `${p} is empty`).toBeGreaterThan(0)
  }

  // 4. Generated content is in the requested language family.
  // Strip frontmatter + code/math blocks before detection since Greek math
  // letters and code would trip a naive detector.
  for (const p of writtenPaths) {
    const raw = await readFileRaw(path.join(tmpPath, p))
    const bodyStart = raw.indexOf("\n---\n", 3)
    let body = bodyStart > 0 ? raw.slice(bodyStart + 5) : raw
    body = body
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\$\$[\s\S]*?\$\$/g, "")
      .replace(/\$[^$\n]*\$/g, "")
    const detected = detectLanguage(body.slice(0, 1500))
    expect(
      !scenario.languageContractForbidden.includes(detected),
      `${p} detected as ${detected}, which is forbidden for target ${scenario.targetLanguage}`,
    ).toBe(true)
  }

  // 5. LLM produced parseable output (more than just the fallback)
  expect(
    writtenPaths.length,
    "LLM produced no parseable FILE blocks — only fallback source summary written",
  ).toBeGreaterThan(1)
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("real-LLM ingest scenarios (4)", () => {
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

        // eslint-disable-next-line no-console
        console.log(
          `\n[${scenario.name}] ${elapsedS}s, ${writtenPaths.length} files: ${writtenPaths.join(", ")}\n`,
        )

        await assertContracts(scenario, ctx.tmp.path, writtenPaths)
      },
      TEST_TIMEOUT_MS,
    )
  }
})
