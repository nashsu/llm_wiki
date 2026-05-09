/**
 * Scenario-driven tests for autoIngest.
 *
 * Each scenario materializes an initial project, a source document, and two
 * canned LLM responses (stage 1 analysis, stage 2 generation with FILE +
 * REVIEW blocks). The runner mocks streamChat to emit them sequentially.
 *
 * After ingest runs, the runner asserts:
 *   - expected files exist on disk with expected substrings
 *   - expected review items were injected into the review store
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import path from "node:path"
import fs from "node:fs/promises"
import { realFs, createTempProject, readFileRaw, fileExists, writeFileRaw } from "@/test-helpers/fs-temp"
import { materializeScenario, copyDir } from "@/test-helpers/scenarios/materialize"
import { ingestScenarios } from "@/test-helpers/scenarios/ingest-scenarios"
import type { IngestScenario } from "@/test-helpers/scenarios/types"

vi.mock("@/commands/fs", () => realFs)

// Sequenced streamChat: stage-1 returns analysisResponse, stage-2 returns
// generationResponse. Ollama split tests can compute the response from the
// requested FILE path. Any further calls return empty.
type PendingResponse = string | ((messages: Array<{ content?: string }>) => string)
let pendingResponses: PendingResponse[] = []
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, msgs, cb) => {
    const next = pendingResponses.shift() ?? ""
    const resp = typeof next === "function" ? next(msgs) : next
    cb.onToken(resp)
    cb.onDone()
  }),
}))

import { autoIngest, executeIngestWrites } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"

const FIXTURES_ROOT = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "scenarios-ingest",
)

beforeAll(async () => {
  await fs.rm(FIXTURES_ROOT, { recursive: true, force: true })
  await fs.mkdir(FIXTURES_ROOT, { recursive: true })
  for (const s of ingestScenarios) {
    await materializeScenario(s, FIXTURES_ROOT)
  }
})

beforeEach(() => {
  pendingResponses = []
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

function minimalProject(pathRoot: string): Promise<void[]> {
  return Promise.all([
    writeFileRaw(path.join(pathRoot, "purpose.md"), "# Purpose\n\n테스트 위키.\n"),
    writeFileRaw(path.join(pathRoot, "schema.md"), "# Schema\n\n기본 스키마.\n"),
    writeFileRaw(path.join(pathRoot, "wiki", "index.md"), "# Index\n"),
    writeFileRaw(path.join(pathRoot, "wiki", "overview.md"), "# Overview\n"),
  ])
}

function requestedFileBlock(messages: Array<{ content?: string }>): string {
  const prompt = messages.map((m) => m.content ?? "").join("\n")
  const pathMatch = prompt.match(/The first line must be exactly: ---FILE: ([\s\S]+?)---/)
  if (!pathMatch) throw new Error("No requested FILE path found in prompt")

  const requestedPath = pathMatch[1].trim()
  const type = requestedPath === "wiki/index.md"
    ? "index"
    : requestedPath === "wiki/overview.md"
      ? "overview"
      : requestedPath.startsWith("wiki/sources/")
        ? "source"
        : "concept"
  const title = requestedPath.split("/").pop()?.replace(/\.md$/, "") ?? type

  return [
    `---FILE: ${requestedPath}---`,
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-05-09",
    "updated: 2026-05-09",
    "tags: []",
    "related: []",
    'sources: ["나를 기억하는 LLM 위키 설계법.md"]',
    "confidence: medium",
    "last_reviewed: 2026-05-09",
    "---",
    "",
    `# ${title}`,
    "",
    "한국어 본문입니다.",
    "---END FILE---",
  ].join("\n")
}

async function setup(scenario: IngestScenario): Promise<Ctx> {
  const tmp = await createTempProject(
    `ingest-${scenario.name.replace(/\//g, "-")}`,
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

  // Queue up the two sequenced LLM responses
  const analysis = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-analysis.txt"),
    "utf-8",
  )
  const generation = await fs.readFile(
    path.join(FIXTURES_ROOT, scenario.name, "llm-generation.txt"),
    "utf-8",
  )
  pendingResponses = [analysis, generation]

  return { tmp }
}

afterEach(async () => {
  if (ctx) {
    await ctx.tmp.cleanup()
    ctx = undefined
  }
})

// ── Assertions ──────────────────────────────────────────────────────────────

async function assertOutcome(
  scenario: IngestScenario,
  tmpPath: string,
): Promise<void> {
  const expected = scenario.expected

  // 1. Expected files exist
  for (const p of expected.writtenPaths) {
    const full = path.join(tmpPath, p)
    const exists = await fileExists(full)
    if (!exists) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[ingest: ${scenario.name}] expected file not written: ${p}`,
      )
    }
    expect(exists, `file not written: ${p}`).toBe(true)
  }

  // 2. File contents contain expected substrings
  if (expected.fileContains) {
    for (const [relPath, substrs] of Object.entries(expected.fileContains)) {
      const full = path.join(tmpPath, relPath)
      const content = await readFileRaw(full)
      for (const sub of substrs) {
        expect(content, `${relPath} missing substring "${sub}"`).toContain(sub)
      }
    }
  }

  // 3. Review store has the expected items
  const expectedReviews = expected.reviewsCreated ?? []
  const actualReviews = useReviewStore.getState().items
  for (const e of expectedReviews) {
    const match = actualReviews.find(
      (r) => r.type === e.type && r.title.includes(e.titleContains),
    )
    if (!match) {
      // eslint-disable-next-line no-console
      console.error(
        `\n[ingest: ${scenario.name}] no review matching ${JSON.stringify(e)}. Actual:\n` +
          JSON.stringify(
            actualReviews.map((r) => ({ type: r.type, title: r.title })),
            null,
            2,
          ),
      )
    }
    expect(match, `review missing: ${JSON.stringify(e)}`).toBeTruthy()
  }

  // 4. If the scenario declared no reviews, store must be empty.
  if (expectedReviews.length === 0) {
    expect(actualReviews).toHaveLength(0)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ingest scenarios (fixture-driven)", () => {
  it.each(ingestScenarios.map((s) => [s.name, s]))(
    "%s",
    async (_name, scenario) => {
      ctx = await setup(scenario)

      const sourceFullPath = path.join(ctx.tmp.path, scenario.source.path)
      await autoIngest(
        ctx.tmp.path,
        sourceFullPath,
        useWikiStore.getState().llmConfig,
      )

      await assertOutcome(scenario, ctx.tmp.path)
    },
  )
})

describe("ollama split ingest", () => {
  it("keeps Korean source concept paths distinct instead of collapsing to an ASCII fallback", async () => {
    ctx = { tmp: await createTempProject("ingest-korean-ollama") }
    await minimalProject(ctx.tmp.path)

    const sourceFullPath = path.join(
      ctx.tmp.path,
      "raw",
      "sources",
      "나를 기억하는 LLM 위키 설계법.md",
    )
    await writeFileRaw(
      sourceFullPath,
      "# 나를 기억하는 LLM 위키 설계법\n\n개인 기억 위키 설계 자료입니다.\n",
    )

    useWikiStore.setState({
      project: {
        name: "t",
        path: ctx.tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
      outputLanguage: "auto",
    })

    pendingResponses = [
      "## 핵심 개념\n- 개인 기억 위키\n",
      requestedFileBlock,
      requestedFileBlock,
      requestedFileBlock,
      requestedFileBlock,
    ]

    const written = await autoIngest(
      ctx.tmp.path,
      sourceFullPath,
      {
        provider: "ollama",
        apiKey: "",
        model: "llama3",
        ollamaUrl: "http://localhost:11434",
        customEndpoint: "",
        maxContextSize: 128000,
      },
    )

    const conceptPath = written.find((p) => p.startsWith("wiki/concepts/"))
    expect(conceptPath).toMatch(
      /^wiki\/concepts\/나를-기억하는-llm-위키-설계법-[a-z0-9]{6}-concept\.md$/,
    )
    expect(conceptPath).not.toBe("wiki/concepts/source-concept-concept.md")
    expect(await fileExists(path.join(ctx.tmp.path, conceptPath!))).toBe(true)
  })
})

describe("manual ingest writes", () => {
  it("ignores LLM-generated log blocks and appends a deterministic actual-write log", async () => {
    ctx = { tmp: await createTempProject("ingest-manual-log") }
    await minimalProject(ctx.tmp.path)

    const sourceFullPath = path.join(ctx.tmp.path, "raw", "sources", "manual-source.md")
    await writeFileRaw(sourceFullPath, "# Manual Source\n\nContent.\n")

    useWikiStore.setState({
      project: {
        name: "t",
        path: ctx.tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
      outputLanguage: "auto",
    })
    useChatStore.setState({
      conversations: [{ id: "conv", title: "Manual", createdAt: 0, updatedAt: 0 }],
      activeConversationId: "conv",
      messages: [{
        id: "m1",
        role: "assistant",
        content: "Create a concept page.",
        timestamp: 0,
        conversationId: "conv",
      }],
      mode: "ingest",
      ingestSource: sourceFullPath,
      isStreaming: false,
      streamingContent: "",
    })

    pendingResponses = [[
      "---FILE: wiki/log.md---",
      "LLM invented a fake page: [[ghost-page]].",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/manual.md---",
      "---",
      "type: concept",
      "title: Manual",
      "tags: []",
      "related: []",
      "---",
      "",
      "# Manual",
      "",
      "Actual page.",
      "---END FILE---",
    ].join("\n")]

    const written = await executeIngestWrites(
      ctx.tmp.path,
      {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
    )

    const log = await readFileRaw(path.join(ctx.tmp.path, "wiki", "log.md"))
    expect(written).toContain(path.join(ctx.tmp.path, "wiki", "concepts", "manual.md"))
    expect(written).toContain(path.join(ctx.tmp.path, "wiki", "log.md"))
    expect(log).toContain("- Source: `manual-source.md`")
    expect(log).toContain("  - `wiki/concepts/manual.md`")
    expect(log).not.toContain("LLM invented")
    expect(log).not.toContain("ghost-page")
  })
})
