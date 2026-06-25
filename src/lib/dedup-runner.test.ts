/**
 * Unit coverage for `buildDedupLlmCall`. Mocks streamChat so we can
 * pin the request overrides it forwards — specifically that dedup
 * (like every other structured-output caller) disables thinking. A
 * reasoning-capable model left thinking-on burns its whole budget on
 * chain-of-thought and ends the stream with empty content, which on
 * the scan path runs silently to the 30-min backstop and surfaces as
 * a bare "Request cancelled".
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.mock is hoisted above imports; vi.hoisted keeps the fn out of the TDZ.
const {
  mockCandidatePairs,
  mockClusterByPairs,
  mockListDirectory,
  mockLoadEmbeddingConfig,
  mockLoadNotDuplicates,
  mockReadFile,
  mockStreamChat,
} = vi.hoisted(() => ({
  mockCandidatePairs: vi.fn(),
  mockClusterByPairs: vi.fn(),
  mockListDirectory: vi.fn(),
  mockLoadEmbeddingConfig: vi.fn(),
  mockLoadNotDuplicates: vi.fn(),
  mockReadFile: vi.fn(),
  mockStreamChat: vi.fn(),
}))
vi.mock("./llm-client", async () => {
  const actual = await vi.importActual<typeof import("./llm-client")>("./llm-client")
  return { ...actual, streamChat: mockStreamChat }
})
vi.mock("@/commands/fs", () => ({
  listDirectory: mockListDirectory,
  readFile: mockReadFile,
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}))
vi.mock("@/lib/project-store", () => ({
  loadEmbeddingConfig: mockLoadEmbeddingConfig,
}))
vi.mock("./dedup-storage", () => ({
  loadNotDuplicates: mockLoadNotDuplicates,
}))
vi.mock("@/lib/dedup_embedding", () => ({
  candidatePairs: mockCandidatePairs,
  clusterByPairs: mockClusterByPairs,
  DuplicatePrefilterCancelledError: class DuplicatePrefilterCancelledError extends Error {
    name = "AbortError"
  },
}))

import { buildDedupLlmCall, runDuplicateDetection } from "./dedup-runner"
import type { LlmConfig } from "@/stores/wiki-store"

const cfg: LlmConfig = {
  provider: "ollama",
  apiKey: "",
  model: "qwen3:8b",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxContextSize: 8192,
}

const FOO_PATH = "/project/wiki/entities/foo.md"
const BAR_PATH = "/project/wiki/entities/bar.md"
const BAZ_PATH = "/project/wiki/entities/baz.md"
const FOO_REL = "wiki/entities/foo.md"
const BAR_REL = "wiki/entities/bar.md"

beforeEach(() => {
  mockCandidatePairs.mockReset()
  mockClusterByPairs.mockReset()
  mockListDirectory.mockReset()
  mockLoadEmbeddingConfig.mockReset()
  mockLoadNotDuplicates.mockReset()
  mockReadFile.mockReset()
  mockStreamChat.mockReset()
})

function setupThreePageProject() {
  mockListDirectory.mockResolvedValue([
    {
      name: "wiki",
      path: "/project/wiki",
      is_dir: true,
      children: [
        {
          name: "entities",
          path: "/project/wiki/entities",
          is_dir: true,
          children: [
            { name: "foo.md", path: FOO_PATH, is_dir: false },
            { name: "bar.md", path: BAR_PATH, is_dir: false },
            { name: "baz.md", path: BAZ_PATH, is_dir: false },
          ],
        },
      ],
    },
  ])
  mockReadFile.mockImplementation(async (path: string) => {
    const slug = path.split("/").pop()?.replace(/\.md$/, "") ?? "unknown"
    return `---\ntype: entity\ntitle: ${slug}\ntags: []\n---\n${slug} body`
  })
}

function setupEmbeddingConfig(enabled = true) {
  mockLoadEmbeddingConfig.mockResolvedValue({
    enabled,
    endpoint: "http://localhost:1234/v1/embeddings",
    apiKey: "",
    model: "mock",
  })
}

function setupLargeProject(count = 251) {
  const children = Array.from({ length: count }, (_, i) => ({
    name: `p${i}.md`,
    path: `/project/wiki/entities/p${i}.md`,
    is_dir: false,
  }))
  mockListDirectory.mockResolvedValue([
    {
      name: "wiki",
      path: "/project/wiki",
      is_dir: true,
      children: [
        { name: "entities", path: "/project/wiki/entities", is_dir: true, children },
      ],
    },
  ])
  mockReadFile.mockImplementation(async (path: string) => {
    const slug = path.split("/").pop()?.replace(/\.md$/, "") ?? "unknown"
    return `---\ntype: entity\ntitle: ${slug}\ntags: []\n---\n${slug} body`
  })
}

function mockDetectorGroup(slugs: string[] = ["foo", "bar"]) {
  mockStreamChat.mockImplementation(async (_c, _m, cb) => {
    cb.onToken(JSON.stringify({
      groups: [{ slugs, reason: "same topic", confidence: "high" }],
    }))
    cb.onDone()
  })
}

describe("buildDedupLlmCall", () => {
  it("disables thinking and caps output so reasoning models answer instead of streaming chain-of-thought to the backstop", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken('{"groups": []}')
      cb.onDone()
    })

    const call = buildDedupLlmCall(cfg, 8192)
    const out = await call("system prompt", "user message", undefined)
    expect(out).toBe('{"groups": []}')

    const overrides = mockStreamChat.mock.calls[0][4]
    expect(overrides).toMatchObject({
      temperature: 0.1,
      reasoning: { mode: "off" },
      max_tokens: 8192,
    })
  })

  it("forwards the caller's max_tokens budget (detection small, merge generous)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    await buildDedupLlmCall(cfg, 32768)("s", "u", undefined)
    expect(mockStreamChat.mock.calls[0][4]).toMatchObject({ max_tokens: 32768 })
  })

  it("forces reasoning off even when the config requests a thinking mode", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    const reasoningCfg: LlmConfig = { ...cfg, reasoning: { mode: "high" } }
    await buildDedupLlmCall(reasoningCfg, 8192)("s", "u", undefined)

    expect(mockStreamChat.mock.calls[0][4]).toMatchObject({
      reasoning: { mode: "off" },
    })
  })

  it("forwards the abort signal through to streamChat", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())
    const controller = new AbortController()

    await buildDedupLlmCall(cfg, 8192)("s", "u", controller.signal)

    expect(mockStreamChat.mock.calls[0][3]).toBe(controller.signal)
  })

  it("rethrows when streamChat reports an error (no silent empty result)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onError(new Error("HTTP 500: model unavailable"))
    })

    await expect(buildDedupLlmCall(cfg, 8192)("s", "u", undefined)).rejects.toThrow(
      /HTTP 500: model unavailable/,
    )
  })
})

describe("runDuplicateDetection embedding prefilter", () => {
  it("sends only embedding candidate summaries to the LLM detector", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([[FOO_REL, BAR_REL]])
    mockClusterByPairs.mockReturnValue([[FOO_REL, BAR_REL]])
    mockDetectorGroup()

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual([
      { slugs: ["foo", "bar"], reason: "same topic", confidence: "high" },
    ])
    expect(mockCandidatePairs).toHaveBeenCalledOnce()
    const detectorUserMessage = mockStreamChat.mock.calls[0][1][1].content
    expect(detectorUserMessage).toContain("slug=foo")
    expect(detectorUserMessage).toContain("slug=bar")
    expect(detectorUserMessage).not.toContain("slug=baz")
  })

  it("falls back to the full LLM scan when the embedding prefilter fails", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockRejectedValue(new Error("embedding endpoint unavailable"))
    mockDetectorGroup()

    await runDuplicateDetection("/project", cfg)

    const detectorUserMessage = mockStreamChat.mock.calls[0][1][1].content
    expect(detectorUserMessage).toContain("slug=foo")
    expect(detectorUserMessage).toContain("slug=bar")
    expect(detectorUserMessage).toContain("slug=baz")
  })

  it("falls back to the full LLM scan when persisted embedding config is malformed", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    mockLoadEmbeddingConfig.mockResolvedValue({
      enabled: true,
      apiKey: "",
      model: "mock",
    })
    mockDetectorGroup()

    await runDuplicateDetection("/project", cfg)

    expect(mockCandidatePairs).not.toHaveBeenCalled()
    const detectorUserMessage = mockStreamChat.mock.calls[0][1][1].content
    expect(detectorUserMessage).toContain("slug=baz")
  })

  it("falls back to the full LLM scan for small wikis when the prefilter returns no candidates", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([])
    mockDetectorGroup()

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual([
      { slugs: ["foo", "bar"], reason: "same topic", confidence: "high" },
    ])
    const detectorUserMessage = mockStreamChat.mock.calls[0][1][1].content
    expect(detectorUserMessage).toContain("slug=foo")
    expect(detectorUserMessage).toContain("slug=bar")
    expect(detectorUserMessage).toContain("slug=baz")
    expect(mockClusterByPairs).not.toHaveBeenCalled()
  })

  it("short-circuits large wiki scans when the prefilter returns no candidates", async () => {
    setupLargeProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([])

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual([])
    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(mockClusterByPairs).not.toHaveBeenCalled()
  })

  it("does not fall back to the full LLM scan for large wikis when embedding coverage is too low", async () => {
    setupLargeProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockRejectedValue(new Error("Duplicate prefilter embedded only 2/251 pages"))

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual([])
    expect(mockStreamChat).not.toHaveBeenCalled()
  })

  it("keeps the not-duplicates whitelist active on the prefiltered path", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([["foo", "bar"]])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([[FOO_REL, BAR_REL]])
    mockClusterByPairs.mockReturnValue([[FOO_REL, BAR_REL]])

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual([])
    expect(mockStreamChat).not.toHaveBeenCalled()
  })

  it("propagates cancellation instead of falling back to a full scan", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    const controller = new AbortController()
    controller.abort()
    mockCandidatePairs.mockRejectedValue(new Error("Duplicate scan cancelled"))

    await expect(runDuplicateDetection("/project", cfg, { signal: controller.signal }))
      .rejects.toThrow(/cancelled/i)
    expect(mockStreamChat).not.toHaveBeenCalled()
  })
})
