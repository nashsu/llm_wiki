import { describe, it, expect, vi, beforeEach } from "vitest"
import { mergeCatchupRetryEntities, runFollowUpPasses } from "./ingest"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  buildManifestStub,
  MANIFEST_STUB_MARKER,
} from "./post-ingest-materialize"
import { useWikiStore } from "@/stores/wiki-store"
import type { IngestCheckpoint } from "@/lib/ingest-checkpoint"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock("@/lib/wiki-page-resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wiki-page-resolver")>()
  return {
    ...actual,
    listWikiPageIds: vi.fn().mockResolvedValue([]),
  }
})

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

// post-ingest-wikilinks pulls fs through the same mock above; nothing else
// to stub.

import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"

const mockListDirectory = vi.mocked(listDirectory)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockStreamChat = vi.mocked(streamChat)

function mkLlmConfig(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    apiKey: "k",
    model: "test",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 8000,
    ...over,
  }
}

const LLM_CONFIG = mkLlmConfig()

function testCheckpoint(over: Partial<IngestCheckpoint> = {}): IngestCheckpoint {
  return {
    version: 1,
    contentHash: "test-content-hash",
    startedAt: 0,
    updatedAt: 0,
    ...over,
  }
}

const RUN_CTX = {
  projectPath: "/p",
  sourcePath: "/p/raw/sources/paper.pdf",
  fileName: "paper.pdf",
  llmConfig: LLM_CONFIG,
  signal: undefined,
  folderContext: undefined,
  wiki: { schema: "", purpose: "", index: "", overview: "" },
  source: { raw: "src", enriched: "src" },
}

const PAGE_WITH_DANGLING_REF = [
  "---",
  'type: entity',
  'title: "Ion Stoica"',
  'sources: ["paper.pdf"]',
  "related: [totally-unknown-thing]",
  "---",
  "",
].join("\n")

function wikiTreeFixture() {
  return {
    entities: [
      { name: "ion-stoica.md", path: "/p/wiki/entities/ion-stoica.md", is_dir: false },
    ] as const,
    concepts: [] as const,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useWikiStore.getState().setOutputLanguage("auto")
  // Manifest page already exists on disk → no stub, no catch-up target.
  mockListDirectory.mockImplementation(async (path: string) => {
    if (path.endsWith("/wiki/entities")) {
      return [
        { name: "ion-stoica.md", path: "/p/wiki/entities/ion-stoica.md", is_dir: false },
      ] as never
    }
    if (path.endsWith("/wiki/concepts")) return [] as never
    if (path.endsWith("/wiki")) {
      return [
        {
          name: "entities",
          path: "/p/wiki/entities",
          is_dir: true,
          children: [
            { name: "ion-stoica.md", path: "/p/wiki/entities/ion-stoica.md", is_dir: false },
          ],
        },
      ] as never
    }
    throw new Error(`unexpected listDirectory: ${path}`)
  })
  mockReadFile.mockResolvedValue(PAGE_WITH_DANGLING_REF)
  mockWriteFile.mockResolvedValue(undefined as never)
})

describe("runFollowUpPasses — A2 effect seam", () => {
  it("fires onProgress for Manifest coverage and Link pass, onReviews for dangling refs", async () => {
    const onProgress = vi.fn()
    const onError = vi.fn()
    const onReviews = vi.fn()

    const result = await runFollowUpPasses(
      RUN_CTX,
      [{ name: "Ion Stoica", type: "entity" }],
      "Analysis stub",
      ["wiki/entities/ion-stoica.md"],
      { onProgress, onError, onReviews },
    )

    // Progress fires at the two pass boundaries that are guaranteed to run
    // (manifest coverage always; link pass when contentPagesForPostPass is
    // non-empty — which it is, given primaryWritten is non-empty).
    const progressCalls = onProgress.mock.calls.map((c) => c[0])
    expect(progressCalls).toContain("Step 2a.4/2b: Materializing manifest pages...")
    expect(progressCalls).toContain("Step 2a.5/2b: Post-linking generated pages...")

    // Manifest coverage queues a missing-page review for the non-manifest
    // unresolvable ref. This is the load-bearing assertion for the seam:
    // onReviews receives data, the production review store is not touched.
    expect(onReviews).toHaveBeenCalledTimes(1)
    const [reviewItems] = onReviews.mock.calls[0]
    expect(reviewItems).toHaveLength(1)
    expect(reviewItems[0]).toMatchObject({
      type: "missing-page",
      title: "Missing page: totally-unknown-thing",
    })

    expect(onError).not.toHaveBeenCalled()

    // ADR 0001 line 29 invariant: the path set passed to Link pass is the
    // recomputed union (here just primaryWritten — no stubs, no catch-up).
    expect(result.contentPagesForPostPass).toEqual(["wiki/entities/ion-stoica.md"])
    expect(result.writtenPaths).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.hardFailures).toEqual([])

    // No catch-up targets → streamChat untouched.
    expect(mockStreamChat).not.toHaveBeenCalled()
  })
})

describe("runFollowUpPasses — catch-up", () => {
  const CATCHUP_FILE_OUTPUT = [
    "---FILE: wiki/entities/ion-stoica.md---",
    "---",
    "type: entity",
    'title: "Ion Stoica"',
    'sources: ["paper.pdf"]',
    "tags: [distributed-systems]",
    "related: []",
    "---",
    "",
    "# Ion Stoica",
    "",
    "Full biography from catch-up pass.",
    "---END FILE---",
  ].join("\n")

  beforeEach(() => {
    const tree = wikiTreeFixture()
    mockListDirectory.mockImplementation(async (path: string) => {
      if (path.endsWith("/wiki/entities")) return [...tree.entities] as never
      if (path.endsWith("/wiki/concepts")) return [...tree.concepts] as never
      if (path.endsWith("/wiki")) {
        return [
          {
            name: "entities",
            path: "/p/wiki/entities",
            is_dir: true,
            children: [...tree.entities],
          },
          {
            name: "concepts",
            path: "/p/wiki/concepts",
            is_dir: true,
            children: [...tree.concepts],
          },
        ] as never
      }
      throw new Error(`unexpected listDirectory: ${path}`)
    })

    const ionStub = buildManifestStub(
      { name: "Ion Stoica", type: "entity" },
      "paper.pdf",
      "2026-05-19",
    )

    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("/ion-stoica.md")) return ionStub
      throw new Error(`unexpected readFile: ${filePath}`)
    })

    mockStreamChat.mockImplementation(async (_cfg, messages, cb) => {
      const system = (messages[0] as { content: string }).content
      expect(system).toContain("CATCH-UP PASS")
      cb.onToken(CATCHUP_FILE_OUTPUT)
      cb.onDone()
    })
  })

  it("materializes stubs, streams catch-up LLM, overwrites stub with full page", async () => {
    const onProgress = vi.fn()

    const result = await runFollowUpPasses(
      RUN_CTX,
      [{ name: "Ion Stoica", type: "entity" }],
      "Analysis: Ion Stoica founded …",
      [],
      { onProgress, onError: vi.fn(), onReviews: vi.fn() },
    )

    expect(mockStreamChat).toHaveBeenCalledTimes(1)
    expect(onProgress.mock.calls.map((c) => c[0])).toContain(
      "Step 2a-catchup: Missed entities 1/1 (1 pages)...",
    )

    expect(result.writtenPaths).toContain("wiki/entities/ion-stoica.md")
    expect(result.contentPagesForPostPass).toContain("wiki/entities/ion-stoica.md")

    const ionWrites = mockWriteFile.mock.calls.filter((c) =>
      String(c[0]).endsWith("/ion-stoica.md"),
    )
    expect(ionWrites.length).toBeGreaterThanOrEqual(1)
    const lastWrite = String(ionWrites[ionWrites.length - 1][1])
    expect(lastWrite).toContain("Full biography from catch-up pass.")
    expect(lastWrite).not.toContain(MANIFEST_STUB_MARKER)
  })

  it("skips completed catch-up batches on checkpoint resume", async () => {
    mockStreamChat.mockClear()

    const result = await runFollowUpPasses(
      {
        ...RUN_CTX,
        checkpoint: testCheckpoint({
          catchupTargets: [{ name: "Ion Stoica", type: "entity" }],
          completedCatchupBatches: [0],
          catchupWrittenPaths: ["wiki/entities/ion-stoica.md"],
          pendingCatchupRetries: [],
        }),
      },
      [{ name: "Ion Stoica", type: "entity" }],
      "Analysis stub",
      [],
      { onProgress: vi.fn(), onError: vi.fn(), onReviews: vi.fn() },
    )

    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(result.writtenPaths).toContain("wiki/entities/ion-stoica.md")
    expect(result.contentPagesForPostPass).toContain("wiki/entities/ion-stoica.md")
  })

  it("queues stub pages and drains retry pass after primary catch-up batch", async () => {
    const ionStub = buildManifestStub(
      { name: "Ion Stoica", type: "entity" },
      "paper.pdf",
      "2026-05-19",
    )
    const stubLlmOutput = [
      "---FILE: wiki/entities/ion-stoica.md---",
      ionStub,
      "---END FILE---",
    ].join("\n")

    let diskContent = ionStub
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("/ion-stoica.md")) return diskContent
      throw new Error(`unexpected readFile: ${filePath}`)
    })
    mockWriteFile.mockImplementation(async (filePath: string, content: string) => {
      if (filePath.endsWith("/ion-stoica.md")) diskContent = content
    })

    let streamCalls = 0
    mockStreamChat.mockImplementation(async (_cfg, _messages, cb) => {
      streamCalls++
      cb.onToken(streamCalls === 1 ? stubLlmOutput : CATCHUP_FILE_OUTPUT)
      cb.onDone()
    })

    const onProgress = vi.fn()
    const result = await runFollowUpPasses(
      {
        ...RUN_CTX,
        checkpoint: testCheckpoint({ pendingCatchupRetries: [], catchupRetryRoundsDone: 0 }),
      },
      [{ name: "Ion Stoica", type: "entity" }],
      "Analysis: Ion Stoica founded …",
      [],
      { onProgress, onError: vi.fn(), onReviews: vi.fn() },
    )

    expect(streamCalls).toBe(2)
    expect(onProgress.mock.calls.map((c) => c[0])).toContain(
      "Step 2a-catchup retry 1/2: batch 1/1 (1 pages)...",
    )
    expect(diskContent).toContain("Full biography from catch-up pass.")
    expect(diskContent).not.toContain(MANIFEST_STUB_MARKER)
    expect(result.warnings.some((w) => w.includes("still stub after"))).toBe(false)
  })

  it("runs tail retry on resume when primary catch-up batches are already complete", async () => {
    mockStreamChat.mockClear()
    const ionStub = buildManifestStub(
      { name: "Ion Stoica", type: "entity" },
      "paper.pdf",
      "2026-05-19",
    )
    let diskContent = ionStub
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith("/ion-stoica.md")) return diskContent
      throw new Error(`unexpected readFile: ${filePath}`)
    })
    mockWriteFile.mockImplementation(async (filePath: string, content: string) => {
      if (filePath.endsWith("/ion-stoica.md")) diskContent = content
    })
    mockStreamChat.mockImplementation(async (_cfg, _messages, cb) => {
      cb.onToken(CATCHUP_FILE_OUTPUT)
      cb.onDone()
    })

    await runFollowUpPasses(
      {
        ...RUN_CTX,
        checkpoint: testCheckpoint({
          catchupTargets: [{ name: "Ion Stoica", type: "entity" }],
          completedCatchupBatches: [0],
          catchupWrittenPaths: ["wiki/entities/ion-stoica.md"],
          pendingCatchupRetries: [{ name: "Ion Stoica", type: "entity" }],
          catchupRetryRoundsDone: 0,
        }),
      },
      [{ name: "Ion Stoica", type: "entity" }],
      "Analysis stub",
      [],
      { onProgress: vi.fn(), onError: vi.fn(), onReviews: vi.fn() },
    )

    expect(mockStreamChat).toHaveBeenCalledTimes(1)
    expect(diskContent).not.toContain(MANIFEST_STUB_MARKER)
  })
})

describe("mergeCatchupRetryEntities", () => {
  it("dedupes by case-insensitive name", () => {
    const merged = mergeCatchupRetryEntities(
      [{ name: "Dynamo", type: "entity" }],
      [
        { name: "dynamo", type: "entity" },
        { name: "Kafka", type: "entity" },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged.map((e) => e.name)).toEqual(["Dynamo", "Kafka"])
  })
})
