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
  const sourceMatch = prompt.match(/## Source file\n([^\n]+)/) ??
    prompt.match(/sources array MUST include "([^"]+)"/)
  const sourceFileName = sourceMatch?.[1]?.trim() ?? "나를 기억하는 LLM 위키 설계법.md"
  const type = requestedPath === "wiki/index.md"
    ? "index"
    : requestedPath === "wiki/overview.md"
      ? "overview"
      : requestedPath.startsWith("wiki/sources/")
        ? "source"
        : requestedPath.startsWith("wiki/comparisons/")
          ? "comparison"
          : "concept"
  const title = requestedPath.split("/").pop()?.replace(/\.md$/, "") ?? type
  const qualityFrontmatter = ["source", "concept", "comparison", "synthesis", "query"].includes(type)
    ? [
        "quality: reviewed",
        "coverage: high",
        "needs_upgrade: false",
        "source_count: 1",
      ]
    : []
  const bodyByType: Record<string, string[]> = {
    source: [
      "## 요약",
      "이 source summary는 테스트 raw source의 핵심 주장과 운영 적용 범위를 보존하기 위해 생성된 충분한 본문입니다.",
      "",
      "## Source Coverage Matrix",
      "- 원본의 핵심 정의, 운영 적용, 검증 필요 항목을 각각 위키 source summary와 관련 concept 후보로 반영합니다.",
      "",
      "## Atomic Claims",
      "- 원본은 개인 기억 위키를 AI 작업 맥락과 연결하는 운영 패턴을 설명합니다.",
      "",
      "## Evidence Map",
      "- Primary evidence는 테스트 raw source이며, 외부 최신성 검증은 별도 review에서 다룹니다.",
      "",
      "## Kevin 운영체계 적용",
      "- AI Memory Systems와 Personal Operating System 사이에서 장기 기억 후보를 선별하는 기준으로 사용합니다.",
      "",
      "## 운영 노트",
      "- source summary는 원본 추적을 위해 보존하고, durable concept은 별도 품질 게이트를 통과한 경우에만 승격합니다.",
      "",
      "## 열린 질문",
      "- 실제 Vault 규모에서 retrieval 품질과 최신성 검증 비용이 어느 정도인지 추가 확인합니다.",
    ],
    concept: [
      "## 정의",
      "이 concept page는 테스트 source에서 반복 사용 가능한 운영 개념을 추출해 장기 위키 노드로 보존합니다.",
      "",
      "## 판단 기준",
      "원본 claim이 재사용 가능하고 다른 도구나 운영 흐름과 연결될 때만 독립 concept으로 유지합니다.",
      "",
      "## 적용 조건",
      "AI Agent Engineering 또는 Memory Systems의 실행 판단에 직접 영향을 줄 때 이 개념을 사용합니다.",
      "같은 원본에서 나온 단순 배경 설명은 source summary에 남기고, 반복 판단 기준으로 쓰일 claim만 concept으로 승격합니다.",
      "",
      "## 실패 모드",
      "근거가 약하거나 일회성 용어에 가까우면 concept page로 승격하지 않고 review나 source note에 남깁니다.",
      "검증 범위가 부족한 최신 claim은 needs_upgrade 대상으로 남겨 두고, 검색 보강 후에만 운영 지식으로 확정합니다.",
      "",
      "## Source Trace",
      `- Primary source: ${sourceFileName}`,
      "",
      "## 운영 적용",
      "이 노드는 source summary, related entity, future query answer가 같은 판단 기준을 재사용할 수 있을 때만 유지합니다.",
      "따라서 저장 전 품질 게이트는 제목만 있는 문서나 짧은 요약 문장을 durable knowledge로 남기지 않아야 합니다.",
    ],
    comparison: [
      "## 핵심 비교",
      "비교 page는 원본 source가 제시한 선택지의 역할, 적용 조건, 한계를 나란히 검토합니다.",
      "",
      "## 판단 기준",
      "현재 병목이 실행 자동화인지, 기억 시스템인지, 콘텐츠 생산인지에 따라 선택 기준을 분리합니다.",
      "",
      "## 검증 및 최신성",
      "최신 release나 공식 문서 기준이 필요한 claim은 canonical fact로 승격하기 전에 별도 확인합니다.",
    ],
    index: ["- [[테스트-노드]] 품질 게이트 테스트 항목"],
    overview: ["이 테스트 위키는 ingest 품질 게이트가 저장 전 품질을 보장하는지 확인합니다."],
  }

  return [
    `---FILE: ${requestedPath}---`,
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-05-09",
    "updated: 2026-05-09",
    "tags: []",
    "related: []",
    `sources: ["${sourceFileName}"]`,
    "confidence: medium",
    "last_reviewed: 2026-05-09",
    ...qualityFrontmatter,
    "---",
    "",
    `# ${title}`,
    "",
    ...(bodyByType[type] ?? bodyByType.concept),
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
  const nonQualityReviews = actualReviews.filter(
    (r) => !r.title.startsWith("Quality upgrade needed:"),
  )
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

  // 4. If the scenario declared no reviews, store must be empty aside
  // from the ingest quality gate. The quality gate is allowed to flag
  // old intentionally-thin fixtures as upgrade candidates.
  if (expectedReviews.length === 0) {
    expect(nonQualityReviews).toHaveLength(0)
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

describe("focused source-summary recovery", () => {
  it("retries a missing source summary as a small focused task before writing fallback", async () => {
    ctx = { tmp: await createTempProject("ingest-focused-source-retry") }
    await minimalProject(ctx.tmp.path)

    const sourceFullPath = path.join(
      ctx.tmp.path,
      "raw",
      "sources",
      "제미나이 리커버리.md",
    )
    await writeFileRaw(
      sourceFullPath,
      "# 제미나이 리커버리\n\n빠른 모델은 큰 작업보다 작은 source summary 작업을 안정적으로 처리한다.\n",
    )

    useWikiStore.setState({
      project: {
        name: "t",
        path: ctx.tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
      outputLanguage: "Korean",
    })

    pendingResponses = [
      "## Key Concepts\n- Gemini 3 focused ingest retry\n",
      requestedFileBlock,
      "The broad generation failed to emit FILE blocks.",
    ]

    const written = await autoIngest(
      ctx.tmp.path,
      sourceFullPath,
      {
        provider: "google",
        apiKey: "test-key",
        model: "gemini-3-flash-preview",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
    )

    const sourcePath = written.find((p) => p.startsWith("wiki/sources/"))
    expect(sourcePath).toBeTruthy()
    const sourceSummary = await readFileRaw(path.join(ctx.tmp.path, sourcePath!))
    expect(sourceSummary).toContain("이 source summary는 테스트 raw source의 핵심 주장")
    expect(sourceSummary).not.toContain("Fallback summary generated because the model did not emit a valid source summary page.")
  })
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
      /^wiki\/concepts\/나를 기억하는 LLM 위키 설계법 [a-z0-9]{6} concept\.md$/,
    )
    expect(conceptPath).not.toBe("wiki/concepts/source-concept-concept.md")
    expect(await fileExists(path.join(ctx.tmp.path, conceptPath!))).toBe(true)
  })
})

describe("comparison source enforcement", () => {
  it("creates a comparison page when the main generation omits one", async () => {
    ctx = { tmp: await createTempProject("ingest-comparison-enforced") }
    await minimalProject(ctx.tmp.path)

    const sourceFullPath = path.join(
      ctx.tmp.path,
      "raw",
      "sources",
      "OpenClaw vs Hermes.md",
    )
    await writeFileRaw(
      sourceFullPath,
      [
        "---",
        "tags: [ai-agent, comparison]",
        "---",
        "",
        "# OpenClaw vs Hermes",
        "",
        "| 구분 | OpenClaw | Hermes |",
        "| --- | --- | --- |",
        "| 역할 | 데이터 엔진 | 운영 콘솔 |",
        "",
        "## 실무 선택 기준",
        "맥락 부족이면 OpenClaw, 실행 마찰이면 Hermes를 먼저 본다.",
      ].join("\n"),
    )

    useWikiStore.setState({
      project: {
        name: "t",
        path: ctx.tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
      outputLanguage: "Korean",
    })

    pendingResponses = [
      "## Recommendations\n- Create a reusable comparison page for OpenClaw and Hermes.\n",
      [
        "---FILE: wiki/sources/OpenClaw vs Hermes.md---",
        "---",
        "type: source",
        "title: OpenClaw vs Hermes",
        "created: 2026-05-09",
        "updated: 2026-05-09",
        "tags: [comparison]",
        "related: []",
        'sources: ["OpenClaw vs Hermes.md"]',
        "confidence: high",
        "last_reviewed: 2026-05-09",
        "---",
        "",
        "# OpenClaw vs Hermes",
        "",
        "source summary only.",
        "---END FILE---",
        "",
        "---FILE: wiki/index.md---",
        "---",
        "type: index",
        "title: Index",
        "tags: []",
        "related: []",
        "---",
        "",
        "# Index",
        "---END FILE---",
        "",
        "---FILE: wiki/overview.md---",
        "---",
        "type: overview",
        "title: Overview",
        "tags: []",
        "related: []",
        "---",
        "",
        "# Overview",
        "---END FILE---",
      ].join("\n"),
      requestedFileBlock,
    ]

    const written = await autoIngest(
      ctx.tmp.path,
      sourceFullPath,
      {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
    )

    const comparisonPath = "wiki/comparisons/OpenClaw vs Hermes.md"
    expect(written).toContain(comparisonPath)
    const content = await readFileRaw(path.join(ctx.tmp.path, comparisonPath))
    expect(content).toContain("type: comparison")
    expect(content).toContain('sources: ["OpenClaw vs Hermes.md"]')
  })
})

describe("Obsidian graph link sync", () => {
  it("adds graph_links for resolved related and source references after ingest", async () => {
    ctx = { tmp: await createTempProject("ingest-obsidian-graph-links") }
    await minimalProject(ctx.tmp.path)

    await writeFileRaw(
      path.join(ctx.tmp.path, "wiki", "entities", "openclaw.md"),
      [
        "---",
        "type: entity",
        "title: OpenClaw",
        "tags: []",
        "related: []",
        "sources: []",
        "---",
        "",
        "# OpenClaw",
      ].join("\n"),
    )

    const sourceFullPath = path.join(ctx.tmp.path, "raw", "sources", "agent-note.md")
    await writeFileRaw(sourceFullPath, "# Agent Note\n\nOpenClaw 운영 메모.\n")

    useWikiStore.setState({
      project: {
        name: "t",
        path: ctx.tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
      outputLanguage: "Korean",
    })

    pendingResponses = [
      "## Key Concepts\n- OpenClaw 운영\n",
      [
        "---FILE: wiki/sources/agent-note.md---",
        "---",
        "type: source",
        "title: Agent Note",
        "created: 2026-05-09",
        "updated: 2026-05-09",
        "tags: []",
        "related: [openclaw]",
        'sources: ["agent-note.md"]',
        "confidence: medium",
        "last_reviewed: 2026-05-09",
        "---",
        "",
        "# Agent Note",
        "OpenClaw 요약.",
        "---END FILE---",
        "",
        "---FILE: wiki/concepts/agent-ops.md---",
        "---",
        "type: concept",
        "title: Agent Ops",
        "created: 2026-05-09",
        "updated: 2026-05-09",
        "tags: []",
        "related: [openclaw]",
        'sources: ["agent-note.md"]',
        "confidence: medium",
        "last_reviewed: 2026-05-09",
        "quality: reviewed",
        "coverage: high",
        "needs_upgrade: false",
        "source_count: 1",
        "---",
        "",
        "# Agent Ops",
        "",
        "## 정의",
        "OpenClaw 운영 개념은 agent 실행 흐름을 반복 가능한 운영 판단 단위로 정리하는 테스트 concept입니다.",
        "",
        "## 판단 기준",
        "OpenClaw 관련 claim이 실행 순서, 승인 경계, graph link와 연결될 때 독립 concept으로 유지합니다.",
        "",
        "## 적용 조건",
        "agent note가 기존 entity와 연결되고 Obsidian graph link 동기화가 필요한 상황에서 적용합니다.",
        "동일한 운영 claim이 source summary와 entity 양쪽에서 재사용될 때 graph_links가 회귀 없이 유지되는지도 함께 확인합니다.",
        "",
        "## 실패 모드",
        "단순한 도구 이름 언급이나 source 한 줄 요약이면 concept으로 승격하지 않고 source summary에만 남깁니다.",
        "검증되지 않은 연결을 강제로 추가하면 Knowledge graph가 왜곡되므로 source trace와 related link를 동시에 확인합니다.",
        "",
        "## Source Trace",
        "- Primary source: agent-note.md",
        "",
        "## 운영 적용",
        "이 노드는 App ingest가 생성한 graph_links가 실제 Obsidian graph와 LLM Wiki App graph 양쪽에서 안정적으로 재사용되는지 검증합니다.",
        "따라서 source trace, related entity, graph link 보강이 한 번의 ingest 결과 안에서 서로 충돌하지 않아야 합니다.",
        "---END FILE---",
      ].join("\n"),
    ]

    await autoIngest(
      ctx.tmp.path,
      sourceFullPath,
      {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
    )

    const content = await readFileRaw(path.join(ctx.tmp.path, "wiki", "concepts", "Agent Ops.md"))
    expect(content).toContain("graph_links:")
    expect(content).toContain('  - "[[Agent Note 소스 요약]]"')
    expect(content).toContain('  - "[[openclaw]]"')
  })
})

describe("ingest write scope guard", () => {
	  it("normalizes overclaimed source metadata and strips links to held pages", async () => {
    ctx = { tmp: await createTempProject("ingest-quality-held-link-prune") }
    await minimalProject(ctx.tmp.path)

    const sourceFullPath = path.join(ctx.tmp.path, "raw", "sources", "dify.md")
    await writeFileRaw(sourceFullPath, "# Dify\n\nDify platform source.\n")

    useWikiStore.setState({
      project: {
        name: "t",
        path: ctx.tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
      outputLanguage: "Korean",
    })

    pendingResponses = [
      "## Key Entities\n- Dify\n\n## Verification & Freshness Plan\n- 최신 공식 문서 확인 필요.",
      [
        "---FILE: wiki/sources/dify-source.md---",
        "---",
        "type: source",
        "title: dify",
        "created: 2024-05-10",
        "updated: 2024-05-10",
        "tags: [ai-agent]",
        "related: [dify, ghost-tool]",
        'sources: ["dify.md"]',
        "confidence: high",
        "last_reviewed: 2024-05-10",
        "quality: gold",
        "coverage: high",
        "needs_upgrade: false",
        "source_count: 1",
        "---",
        "",
        "# dify",
        "",
        "## 요약",
        "Dify는 LLM 애플리케이션 운영을 돕는 플랫폼입니다.",
        "",
        "## Source Coverage Matrix",
        "- 기능, 배포, 운영 항목을 검토해야 합니다.",
        "",
        "## Atomic Claims",
        "- Dify는 workflow와 RAG 기능을 제공합니다.",
        "",
        "## Evidence Map",
        "- Primary source: dify.md",
        "",
        "## Kevin 운영체계 적용",
        "- AI Agent Engineering과 Infra 계층 후보입니다.",
        "",
        "## 운영 노트",
        "- 최신 공식 문서 확인 전에는 운영 기준으로 확정하지 않습니다.",
        "",
        "## 열린 질문",
        "- Dify의 최신 기능과 MCP 호환성을 확인해야 합니다.",
        "",
        "본문에서 [[dify]] 후보와 [[ghost-tool]] 미생성 후보를 언급합니다.",
        "---END FILE---",
        "",
        "---FILE: wiki/entities/dify.md---",
        "---",
        "type: entity",
        "title: Dify",
        "created: 2024-05-10",
        "updated: 2024-05-10",
        "tags: []",
        "related: []",
        'sources: ["dify.md"]',
        "confidence: medium",
        "last_reviewed: 2024-05-10",
        "quality: reviewed",
        "coverage: high",
        "needs_upgrade: false",
        "source_count: 1",
        "---",
        "",
        "# Dify",
        "",
        "짧은 entity stub.",
        "---END FILE---",
        "",
        "---FILE: wiki/index.md---",
        "---",
        "type: index",
        "title: Index",
        "tags: []",
        "related: []",
        "---",
        "",
        "# Index",
        "- [[dify]] — 보류 후보",
        "- [[ghost-tool]] — 미생성 후보",
        "---END FILE---",
      ].join("\n"),
    ]

    await autoIngest(
      ctx.tmp.path,
      sourceFullPath,
      {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
    )

    const today = new Date().toISOString().slice(0, 10)
    const sourceSummary = await readFileRaw(path.join(ctx.tmp.path, "wiki", "sources", "Dify 소스 요약.md"))
    expect(sourceSummary).toContain(`created: ${today}`)
    expect(sourceSummary).toContain(`updated: ${today}`)
    expect(sourceSummary).toContain(`last_reviewed: ${today}`)
    expect(sourceSummary).not.toContain("quality: gold")
    expect(sourceSummary).toContain("quality: draft")
    expect(sourceSummary).toContain("needs_upgrade: true")
    expect(sourceSummary).not.toContain("[[dify]]")
    expect(sourceSummary).not.toContain("[[ghost-tool]]")
    expect(sourceSummary).toContain("ghost-tool")
    expect(sourceSummary).not.toContain("related: [dify")
    expect(sourceSummary).not.toContain("ghost-tool]")

    const indexContent = await readFileRaw(path.join(ctx.tmp.path, "wiki", "index.md"))
    expect(indexContent).not.toContain("[[dify]]")
    expect(indexContent).not.toContain("[[ghost-tool]]")
    expect(indexContent).toContain("dify")
    expect(indexContent).toContain("ghost-tool")
	    expect(await fileExists(path.join(ctx.tmp.path, "wiki", "entities", "dify.md"))).toBe(false)
	    expect(useReviewStore.getState().items.some((item) => item.title === "Quality hold: wiki/entities/dify.md")).toBe(true)
	  })

	  it("normalizes Gemini-style missing source trace, block related links, freshness, and compact index", async () => {
	    ctx = { tmp: await createTempProject("ingest-gemini-postprocess-safety-net") }
	    await minimalProject(ctx.tmp.path)

	    const sourceFileName = "케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법.md"
	    const sourceFullPath = path.join(ctx.tmp.path, "raw", "sources", sourceFileName)
	    await writeFileRaw(
	      sourceFullPath,
	      [
	        "---",
	        "freshness_tier: short",
	        "freshness_domain: ai_tooling",
	        "---",
	        "# 케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법",
	        "",
	        "Caveman 프롬프트 방식은 최신 AI 도구 사용에서 토큰을 아끼고 답변을 빠르게 만드는 운영 패턴이다.",
	      ].join("\n"),
	    )

	    useWikiStore.setState({
	      project: {
	        name: "t",
	        path: ctx.tmp.path,
	        createdAt: 0,
	        purposeText: "",
	        fileTree: [],
	      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
	      outputLanguage: "Korean",
	    })

	    pendingResponses = [
	      "## Key Entities\n- Caveman\n\n## Verification & Freshness Plan\n- 최신 AI tooling 맥락이므로 freshness_required가 필요합니다.",
	      [
	        "---FILE: wiki/sources/케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법 소스 요약.md---",
	        "---",
	        "type: source",
	        "title: 케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법 소스 요약",
	        "created: 2024-05-10",
	        "updated: 2024-05-10",
	        "tags: [ai-tooling]",
	        "related:",
	        "  - wiki/entities/Caveman",
	        "  - Cursor",
	        `sources: ["${sourceFileName}"]`,
	        "confidence: medium",
	        "evidence_strength: moderate",
	        "review_status: ai_generated",
	        "knowledge_type: operational",
	        "last_reviewed: 2024-05-10",
	        "quality: draft",
	        "coverage: medium",
	        "needs_upgrade: true",
	        "source_count: 1",
	        "---",
	        "",
	        "# 케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법 소스 요약",
	        "",
	        "## 요약",
	        "이 source summary는 Caveman 방식이 긴 프롬프트 대신 짧고 직접적인 명령을 사용해 AI 답변 비용과 시간을 줄이려는 운영 패턴임을 설명합니다. 원문은 프롬프트 설계, 토큰 절약, 빠른 반복, 간결한 질문 구조를 함께 다룹니다.",
	        "",
	        "## Source Coverage Matrix",
	        "- 핵심 주장: 짧은 명령은 반복 작업에서 비용과 시간을 줄일 수 있습니다.",
	        "- 구조: 문제 정의, 짧은 명령 예시, 운영 적용 조건, 주의점으로 나뉩니다.",
	        "",
	        "## Atomic Claims",
	        "- Caveman 방식은 복잡한 역할극보다 목적어와 동사를 명확히 쓰는 방식입니다.",
	        "- 최신 모델과 도구별 응답 품질은 별도 검증이 필요합니다.",
	        "",
	        "## Evidence Map",
	        `- Primary source: ${sourceFileName}`,
	        "",
	        "## 검증 및 최신성",
	        "AI tooling과 모델 응답 품질은 빠르게 바뀌므로 최신 모델별 효과는 외부 확인이 필요합니다. 이 문서는 원문 기반 draft로 보존합니다.",
	        "",
	        "## Kevin 운영체계 적용",
	        "반복 Codex/Gemini 작업에서 짧은 명령 템플릿을 운영 패턴으로 시험하고, 성공한 표현만 재사용 지식으로 승격합니다.",
	        "",
	        "## 운영 노트",
	        "이 source page는 원문 근거 추적용이며, 독립 concept 승격은 반복 검증 후 수행합니다.",
	        "",
	        "## 열린 질문",
	        "- 어떤 모델에서 짧은 명령이 실제 비용과 품질 모두에 유리한가?",
	        "---END FILE---",
	        "",
	        "---FILE: wiki/entities/Caveman.md---",
	        "---",
	        "type: entity",
	        "title: Caveman",
	        "created: 2024-05-10",
	        "updated: 2024-05-10",
	        "tags: [ai-tooling]",
	        "related: []",
	        `sources: ["${sourceFileName}"]`,
	        "confidence: high",
	        "evidence_strength: moderate",
	        "review_status: ai_reviewed",
	        "knowledge_type: operational",
	        "last_reviewed: 2024-05-10",
	        "quality: reviewed",
	        "coverage: high",
	        "needs_upgrade: false",
	        "source_count: 1",
	        "---",
	        "",
	        "# Caveman",
	        "",
	        "## Kevin OS에서의 역할",
	        "Caveman은 복잡한 지시문을 줄이고 핵심 동작만 짧게 전달하는 프롬프트 운영 방식의 이름으로 쓰입니다. Kevin의 LLM Wiki에서는 반복 작업 명령을 빠르게 만들고, 모델별 반응을 비교하는 기준 엔티티로 사용합니다. 이 엔티티는 특정 회사나 제품이라기보다 원문에서 명명된 작업 방식의 식별자로 남깁니다. 실제 운영에서는 긴 프롬프트를 무조건 버리는 뜻이 아니라, 먼저 작은 명령으로 모델 반응을 확인하고 필요한 검증 조건을 뒤에 붙이는 출발점으로 해석합니다.",
	        "",
	        "## 제약",
	        "짧은 명령이 항상 좋은 결과를 보장하지는 않습니다. 복잡한 법률, 재무, 시스템 설계 작업처럼 맥락과 검증 조건이 중요한 경우에는 짧은 명령 뒤에 품질 기준과 검증 루프를 별도로 붙여야 합니다. 최신 모델별 성능은 계속 바뀌므로 freshness 확인이 필요합니다. 특히 Gemini 3처럼 속도가 빠른 모델은 작은 작업을 빠르게 여러 번 수행하는 데 강점이 있지만, 한 번에 지나치게 많은 문서 구조를 요구하면 누락이나 형식 흔들림이 생길 수 있습니다.",
	        "",
	        "## 연결",
	        "- source summary와 비교 문서에서 Caveman 방식의 비용, 속도, 품질 균형을 추적합니다.",
	        "- AI Agent Engineering 작업에서는 작은 단계로 쪼개는 Gemini 3 ingest 전략과 함께 사용됩니다.",
	        "- LLM Wiki의 품질 계약에서는 이 엔티티를 active로 둘 수 있지만, 모델별 성능 claim은 항상 source summary나 comparison 문서에서 검증 필요 항목으로 남깁니다.",
	        "",
	        "## Source Trace",
	        `- Primary source: ${sourceFileName}`,
	        "---END FILE---",
	        "",
	        "---FILE: wiki/comparisons/케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법.md---",
	        "---",
	        "type: comparison",
	        "title: 케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법",
	        "created: 2024-05-10",
	        "updated: 2024-05-10",
	        "tags: [ai-tooling]",
	        "related:",
	        "  - wiki/entities/Caveman",
	        "  - wiki/concepts/토큰 압축",
	        "  - wiki/concepts/메모리 압축",
	        "graph_links:",
	        "  - \"[[Caveman]]\"",
	        "  - \"[[Kevin 운영체계 적용]]\"",
	        "confidence: high",
	        "evidence_strength: moderate",
	        "review_status: ai_generated",
	        "knowledge_type: strategic",
	        "last_reviewed: 2024-05-10",
	        "quality: draft",
	        "coverage: medium",
	        "needs_upgrade: true",
	        "source_count: 0",
	        "---",
	        "",
	        "# 케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법",
	        "",
	        "## 핵심 비교",
	        "Caveman 방식은 길고 장식적인 프롬프트보다 짧고 직접적인 명령을 선호합니다. 장점은 반복 비용과 작성 시간을 줄인다는 점이고, 단점은 복잡한 품질 조건을 빠뜨릴 수 있다는 점입니다. 기존 긴 프롬프트 방식은 맥락을 많이 넣어 안정성을 확보하지만 매번 토큰 비용과 작성 시간이 커질 수 있습니다.",
	        "",
	        "## 판단 기준",
	        "반복적이고 위험도가 낮은 작업에서는 Caveman 방식이 유리합니다. 반면 계약, 법률, 재무, 보안, 구조 설계처럼 누락 위험이 큰 작업에서는 짧은 명령만으로는 부족합니다. 이때는 짧은 명령을 쓰더라도 완료 기준, 검증 기준, rollback 조건을 함께 붙여야 합니다.",
	        "",
	        "## 운영 적용",
	        "Kevin 운영체계 적용 관점에서는 Caveman 명령을 기본 초안으로 사용하고, 중요한 작업에는 LLM Wiki 품질 계약을 붙여 보강합니다. 예를 들어 '이 source 위키에 넣어줘' 같은 짧은 명령은 빠르게 시작하기 좋지만, 최종 저장 전에는 source trace, freshness, review_status를 확인해야 합니다.",
	        "",
	        "## 검증 및 최신성",
	        "AI 모델별 짧은 명령 처리 능력은 빠르게 변합니다. Gemini 3 Flash Preview 같은 빠른 모델은 작은 단계로 나누면 충분히 좋은 결과를 낼 수 있지만, 모델 업데이트나 provider 설정에 따라 결과가 달라질 수 있어 최신성 검증이 필요합니다.",
	        "",
	        "## Source Trace",
	        `- Primary source: ${sourceFileName}`,
	        "---END FILE---",
	      ].join("\n"),
	    ]

	    await autoIngest(
	      ctx.tmp.path,
	      sourceFullPath,
	      {
	        provider: "google",
	        apiKey: "test-key",
	        model: "gemini-3-flash-preview",
	        ollamaUrl: "",
	        customEndpoint: "",
	        maxContextSize: 128000,
	      },
	    )

	    const today = new Date().toISOString().slice(0, 10)
	    const comparison = await readFileRaw(
	      path.join(ctx.tmp.path, "wiki", "comparisons", "케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법.md"),
	    )
	    expect(comparison).toContain(`sources: ["${sourceFileName}"]`)
	    expect(comparison).toContain("source_count: 1")
	    expect(comparison).toContain("freshness_required: true")
	    expect(comparison).toContain(`created: ${today}`)
	    expect(comparison).not.toContain("wiki/concepts/토큰 압축")
	    expect(comparison).not.toContain("wiki/concepts/메모리 압축")
	    expect(comparison).not.toContain("[[Kevin 운영체계 적용]]")
	    expect(comparison).toContain("Kevin 운영체계 적용")

	    const sourceSummary = await readFileRaw(
	      path.join(ctx.tmp.path, "wiki", "sources", "케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법 소스 요약.md"),
	    )
	    expect(sourceSummary).not.toContain("Cursor")
	    expect(sourceSummary).toContain("freshness_required: true")
	    expect(sourceSummary).not.toContain("retention:")

	    const indexContent = await readFileRaw(path.join(ctx.tmp.path, "wiki", "index.md"))
	    expect(indexContent).toContain("## Entities")
	    expect(indexContent).toContain("[[Caveman]]")
	    expect(indexContent).not.toContain("케이브맨으로 AI 답변을 짧고 싸고 빠르게 만드는 법 소스 요약")

	    const reviewTitles = useReviewStore.getState().items.map((item) => item.title)
	    expect(reviewTitles.some((title) => title.includes("Cursor"))).toBe(false)
	    expect(reviewTitles.some((title) => title.includes("Kevin 운영체계 적용"))).toBe(false)
	  })

	  it("reuses an existing legacy source page and drops over-generated or noncanonical paths", async () => {
    ctx = { tmp: await createTempProject("ingest-write-scope-guard") }
    await minimalProject(ctx.tmp.path)
    await writeFileRaw(
      path.join(ctx.tmp.path, "wiki", "sources", "codexian.md"),
      [
        "---",
        "type: source",
        "title: Codexian",
        'sources: ["codexian.md"]',
        "---",
        "",
        "# Codexian",
        "",
        "기존 legacy source summary.",
      ].join("\n"),
    )

    const sourceFullPath = path.join(ctx.tmp.path, "raw", "sources", "codexian.md")
    await writeFileRaw(sourceFullPath, "# Codexian\n\nObsidian Codex CLI plugin.\n")

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

    const page = (relPath: string, type: string, title: string) => [
      `---FILE: ${relPath}---`,
      "---",
      `type: ${type}`,
      `title: ${title}`,
      "created: 2026-05-09",
      "updated: 2026-05-09",
      "tags: []",
      "related: []",
      'sources: ["codexian.md"]',
      "confidence: medium",
      "last_reviewed: 2026-05-09",
      "quality: reviewed",
      "coverage: high",
      "needs_upgrade: false",
      "source_count: 1",
      "---",
      "",
      `# ${title}`,
      "",
      "## 정의",
      "Codexian 관련 문서를 장기 지식 후보로 평가하기 위한 충분한 테스트 본문입니다.",
      "",
      "## 판단 기준",
      "운영 가치가 있고 다른 agent workflow나 memory layer와 연결될 때만 독립 문서로 유지합니다.",
      "",
      "## 적용 조건",
      "Obsidian과 Codex CLI를 함께 사용하며 source trace가 명확한 경우에만 이 페이지를 작성합니다.",
      "허용된 write scope 안에서만 생성되고, canonical source summary와 durable concept가 분리될 때 통과합니다.",
      "",
      "## 실패 모드",
      "검증되지 않은 최신 주장이나 단순한 이름 나열은 보류하고 review item으로 넘깁니다.",
      "중복 source-map, registry, manifest 성격의 파일이 graph input으로 섞이면 App graph 판단이 흔들리므로 저장 전 차단합니다.",
      "",
      "## Source Trace",
      "- Primary source: codexian.md",
      "",
      "## 운영 적용",
      "이 테스트 문서는 저장 전 품질 게이트가 허용된 wiki node만 남기고 source-map 성격의 중복 산출물을 제거하는지 확인합니다.",
      "실제 운영에서는 이 기준이 그래프 왜곡을 막고, 사람이 검토해야 할 애매한 항목은 review queue로 남기는 역할을 합니다.",
      "---END FILE---",
    ].join("\n")

    pendingResponses = [
      "## Key Concepts\n- Codexian\n",
      [
        page("wiki/sources/codexian.md", "source", "Codexian"),
        page("wiki/sources/codexian-source.md", "source", "Codexian Source Duplicate"),
        page("wiki/comparisons/OpenClaw vs Hermes.md", "comparison", "OpenClaw vs Hermes"),
        page("wiki/concepts/one.md", "concept", "One"),
        page("wiki/concepts/two.md", "concept", "Two"),
        page("wiki/concepts/three.md", "concept", "Three"),
        page("wiki/index.md", "index", "Index"),
        page("wiki/overview.md", "overview", "Overview"),
      ].join("\n\n"),
    ]

    const written = await autoIngest(
      ctx.tmp.path,
      sourceFullPath,
      {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
    )

    expect(written).toContain("wiki/sources/codexian.md")
    expect(written).toContain("wiki/concepts/One.md")
    expect(written).toContain("wiki/concepts/Two.md")
    expect(written).toContain("wiki/index.md")
    expect(written).toContain("wiki/overview.md")
    expect(written).not.toContain("wiki/sources/codexian-source.md")
    expect(written).not.toContain("wiki/comparisons/OpenClaw vs Hermes.md")
    expect(written).not.toContain("wiki/concepts/Three.md")
    expect(await fileExists(path.join(ctx.tmp.path, "wiki", "sources", "codexian-source.md"))).toBe(false)
    expect(await fileExists(path.join(ctx.tmp.path, "wiki", "comparisons", "OpenClaw vs Hermes.md"))).toBe(false)
    expect(await fileExists(path.join(ctx.tmp.path, "wiki", "concepts", "Three.md"))).toBe(false)
  })
})

describe("deep research ingest options", () => {
  it("pins query-only source summary titles to the canonical research title", async () => {
    ctx = { tmp: await createTempProject("ingest-deep-research-source-title") }
    await minimalProject(ctx.tmp.path)

    const sourceFullPath = path.join(
      ctx.tmp.path,
      "wiki",
      "queries",
      "deep-research-karpathy.md",
    )
    await writeFileRaw(
      sourceFullPath,
      [
        "---",
        "type: query",
        "title: Research Log: 안드레 카파시 스킬",
        "origin: deep-research",
        "---",
        "",
        "# Research Log: 안드레 카파시 스킬",
        "",
        "안드레이 카파시 스킬 조사.",
      ].join("\n"),
    )

    useWikiStore.setState({
      project: {
        name: "t",
        path: ctx.tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
      outputLanguage: "Korean",
    })

    pendingResponses = [
      "## Key Concepts\n- 카파시 스킬\n",
      [
        "---FILE: wiki/sources/안드레 카파시 스킬 소스 요약.md---",
        "---",
        "type: source",
        "title: Research: 안드레이 카파시가 만든 skill 조사해서 핵심 인사이트 정리해줘",
        "created: 2026-05-09",
        "updated: 2026-05-09",
        "tags: [research]",
        "related: []",
        'sources: ["deep-research-karpathy.md"]',
        "confidence: medium",
        "last_reviewed: 2026-05-09",
        "---",
        "",
        "# Research: 안드레이 카파시가 만든 skill 조사해서 핵심 인사이트 정리해줘",
        "",
        "카파시 스킬 요약.",
        "---END FILE---",
      ].join("\n"),
    ]

    const written = await autoIngest(
      ctx.tmp.path,
      sourceFullPath,
      {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
      undefined,
      undefined,
      { sourceSummaryTitle: "안드레 카파시 스킬" },
    )

    expect(written).toContain("wiki/sources/안드레 카파시 스킬 소스 요약.md")
    const content = await readFileRaw(path.join(ctx.tmp.path, "wiki", "sources", "안드레 카파시 스킬 소스 요약.md"))
    expect(content).toContain('title: "안드레 카파시 스킬 소스 요약"')
    expect(content).toContain("# 안드레 카파시 스킬 소스 요약")
    expect(content).not.toContain("# Research: 안드레이 카파시")
  })

  it("does not duplicate curated deep research artifacts into wiki/sources", async () => {
    ctx = { tmp: await createTempProject("ingest-deep-research-no-source-summary") }
    await minimalProject(ctx.tmp.path)

    const sourceFullPath = path.join(
      ctx.tmp.path,
      "wiki",
      "queries",
      "deep-research-karpathy.md",
    )
    await writeFileRaw(
      sourceFullPath,
      [
        "---",
        "type: query",
        "title: Research Log: 안드레 카파시 스킬",
        "origin: deep-research",
        "---",
        "",
        "# Research Log: 안드레 카파시 스킬",
        "",
        "## Original Query",
        "안드레이 카파시 스킬 조사.",
        "",
        "## Result",
        "카파시 스킬은 AI 코딩 워크플로를 정리한다.",
      ].join("\n"),
    )

    useWikiStore.setState({
      project: {
        name: "t",
        path: ctx.tmp.path,
        createdAt: 0,
        purposeText: "",
        fileTree: [],
      } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
      outputLanguage: "Korean",
    })

    pendingResponses = [
      "## Key Concepts\n- 카파시 스킬\n",
      [
        "---FILE: wiki/sources/deep-research-karpathy.md---",
        "---",
        "type: source",
        "title: 안드레 카파시 스킬 조사",
        "created: 2026-05-09",
        "updated: 2026-05-09",
        "tags: [research]",
        "related: []",
        'sources: ["deep-research-karpathy.md"]',
        "confidence: medium",
        "last_reviewed: 2026-05-09",
        "---",
        "",
        "# 안드레 카파시 스킬 조사",
        "",
        "중복 source summary.",
        "---END FILE---",
        "",
        "---FILE: wiki/concepts/karpathy-skills.md---",
        "---",
        "type: concept",
        "title: 카파시 스킬",
        "created: 2026-05-09",
        "updated: 2026-05-09",
        "tags: [ai-coding]",
        "related: []",
        'sources: ["deep-research-karpathy.md"]',
        "confidence: medium",
        "last_reviewed: 2026-05-09",
        "quality: reviewed",
        "coverage: high",
        "needs_upgrade: false",
        "source_count: 1",
        "---",
        "",
        "# 카파시 스킬",
        "",
        "## 정의",
        "카파시 스킬은 AI 코딩 워크플로에서 반복 가능한 행동 원칙을 추출해 agent 운영에 적용하는 concept입니다.",
        "",
        "## 판단 기준",
        "원본 research 결과가 구체적인 작업 방식, 검토 기준, 반복 가능한 prompt 구조를 제공할 때 유지합니다.",
        "",
        "## 적용 조건",
        "AI Agent Engineering이나 Content Factory에서 실전 작업 품질을 높이는 운영 기준이 필요할 때 적용합니다.",
        "특히 prompt, review, 반복 실행 루프처럼 다른 source에서도 다시 등장할 수 있는 절차형 claim을 연결 대상으로 삼습니다.",
        "",
        "## 실패 모드",
        "영감성 문구만 있고 source-grounded 행동 기준이 없으면 concept으로 승격하지 않습니다.",
        "최신 도구 기능이나 개인 경험담을 일반 원칙으로 확장할 때는 근거와 한계를 분리해 표시해야 합니다.",
        "",
        "## Source Trace",
        "- Primary source: deep-research-karpathy.md",
        "",
        "## 운영 적용",
        "이 노드는 deep research 결과가 source summary로 중복 저장되지 않아도 reusable concept은 유지될 수 있음을 검증합니다.",
        "실제 운영에서는 research 산출물을 그대로 복사하지 않고, 반복 가능한 판단 기준과 적용 한계만 concept으로 승격해야 합니다.",
        "---END FILE---",
        "",
        "---FILE: wiki/index.md---",
        "---",
        "type: index",
        "title: Index",
        "tags: []",
        "related: []",
        "---",
        "",
        "# 색인",
        "- [[karpathy-skills]] 카파시 스킬",
        "---END FILE---",
        "",
        "---FILE: wiki/overview.md---",
        "---",
        "type: overview",
        "title: Overview",
        "tags: []",
        "related: []",
        "---",
        "",
        "# Overview",
        "카파시 스킬을 포함한다.",
        "---END FILE---",
      ].join("\n"),
    ]

    const written = await autoIngest(
      ctx.tmp.path,
      sourceFullPath,
      {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
      undefined,
      undefined,
      { skipSourceSummary: true },
    )

    expect(written).not.toContain("wiki/sources/deep-research-karpathy.md")
    expect(await fileExists(path.join(ctx.tmp.path, "wiki", "sources", "deep-research-karpathy.md"))).toBe(false)
    expect(written).toContain("wiki/concepts/카파시 스킬.md")
    expect(await fileExists(path.join(ctx.tmp.path, "wiki", "concepts", "카파시 스킬.md"))).toBe(true)
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
