import { describe, it, expect, beforeEach, vi } from "vitest"
import { createDeferred, flushMicrotasks } from "@/test-helpers/deferred"
import { createStreamChatHarness } from "@/test-helpers/mock-stream-chat"

// Mock streamChat via the harness (installed via vi.mock below)
const harness = createStreamChatHarness()
vi.mock("./llm-client", () => ({
  streamChat: (...args: unknown[]) => harness.mock(...args),
}))

// Mock fs: listDirectory for buildWikiIndex, readFile for page content
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))

import { sweepResolvedReviews } from "./sweep-reviews"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { listDirectory, readFile } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"

const mockListDirectory = vi.mocked(listDirectory)
const mockReadFile = vi.mocked(readFile)

function fileNode(name: string): FileNode {
  return {
    name,
    path: `/project/wiki/${name}`,
    is_dir: false,
    children: [],
  } as FileNode
}

function addPending(items: Array<Partial<ReviewItem>>) {
  const input = items.map((p) => ({
    type: "missing-page" as ReviewItem["type"],
    title: "X",
    description: "",
    options: [],
    ...p,
  }))
  useReviewStore.getState().addItems(input)
}

function setProject(path: string) {
  useWikiStore.setState({
    project: {
      name: "p",
      path,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "k",
    model: "m",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })
}

/** Clear the API key so the LLM stage short-circuits without a call. */
function disableLlm() {
  useWikiStore.setState({
    llmConfig: {
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 0,
    },
  })
}

/** Wait until a condition is true, or throw after `maxTicks` microtask flushes. */
async function waitUntil(
  predicate: () => boolean,
  maxTicks: number = 50,
  perTick: number = 3,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return
    await flushMicrotasks(perTick)
  }
  throw new Error(`waitUntil: predicate never became true after ${maxTicks} ticks`)
}

beforeEach(() => {
  harness.reset()
  mockListDirectory.mockReset()
  mockReadFile.mockReset()
  useReviewStore.setState({ items: [] })

  // Default: empty wiki dir, no files
  mockListDirectory.mockResolvedValue([])
  mockReadFile.mockResolvedValue("")
})

describe("sweep race — project-identity guard", () => {
  it("bails immediately if projectPath does not match current project", async () => {
    setProject("/project-A")
    addPending([{ title: "Missing page: Foo" }])

    const resolved = await sweepResolvedReviews("/project-B")
    expect(resolved).toBe(0)
    // Store untouched
    expect(useReviewStore.getState().items.filter((i) => i.resolved)).toHaveLength(0)
  })

  it("does not apply resolveItem if user switches projects mid-sweep (after buildWikiIndex)", async () => {
    setProject("/project-A")
    addPending([{ title: "Missing page: Foo" }])

    // Set up the wiki dir to contain foo.md so the rule stage WOULD have
    // resolved the review. The project switch should prevent that write.
    mockListDirectory.mockResolvedValue([fileNode("foo.md")])
    mockReadFile.mockResolvedValue("---\ntitle: Foo\n---\n")

    const sweepPromise = sweepResolvedReviews("/project-A")
    // Switch projects before sweep has a chance to finish
    setProject("/project-B")

    const resolved = await sweepPromise
    // After project switch, the identity guard aborts before any resolveItem
    expect(resolved).toBe(0)
    expect(useReviewStore.getState().items.every((i) => !i.resolved)).toBe(true)
  })

  it("bails before LLM stage if project path mismatches when entering stage 2", async () => {
    setProject("/project-A")
    addPending([{ title: "Ambiguous concept", type: "suggestion" }])

    // Pause buildWikiIndex so we can switch projects at a deterministic point.
    const listDirDeferred = createDeferred<FileNode[]>()
    mockListDirectory.mockReturnValue(listDirDeferred.promise)

    const sweepPromise = sweepResolvedReviews("/project-A")
    await flushMicrotasks(3)

    // Switch project BEFORE buildWikiIndex resolves
    useWikiStore.setState({ project: null })

    // Now let buildWikiIndex finish; the post-await identity guard should bail
    listDirDeferred.resolve([])

    const resolved = await sweepPromise
    expect(resolved).toBe(0)
    expect(harness.pending).toHaveLength(0)
  })
})

describe("sweep race — abort signal", () => {
  it("honors an abort signal that fires before the sweep starts", async () => {
    setProject("/project-A")
    addPending([{ title: "Something" }])

    const ac = new AbortController()
    ac.abort()
    const resolved = await sweepResolvedReviews("/project-A", ac.signal)
    expect(resolved).toBe(0)
  })

  it("does not invoke streamChat if aborted before stage 2", async () => {
    setProject("/project-A")
    addPending([{ title: "Cannot be rule-resolved" }])

    const ac = new AbortController()
    ac.abort()

    await sweepResolvedReviews("/project-A", ac.signal)
    expect(harness.pending).toHaveLength(0)
  })

  it("signal aborted during streamChat — harness sees abort, sweep returns 0 LLM resolutions", async () => {
    setProject("/project-A")
    addPending([{ title: "Concept needing LLM" }])

    const ac = new AbortController()
    const sweepPromise = sweepResolvedReviews("/project-A", ac.signal)

    // Wait until the harness has received the LLM call
    await flushMicrotasks(5)
    expect(harness.pending).toHaveLength(1)

    ac.abort()
    const result = await sweepPromise
    expect(result).toBe(0)
    expect(harness.anyAborted()).toBe(true)
  })
})

describe("sweep — rule-based auto-resolution", () => {
  it("auto-resolves a missing-page review when the page now exists by filename", async () => {
    setProject("/project")
    addPending([{ title: "Missing page: attention", type: "missing-page" }])

    mockListDirectory.mockResolvedValue([fileNode("attention.md")])
    mockReadFile.mockResolvedValue("no frontmatter")

    const resolved = await sweepResolvedReviews("/project")
    expect(resolved).toBe(1)

    const items = useReviewStore.getState().items
    expect(items[0].resolved).toBe(true)
    expect(items[0].resolvedAction).toBe("auto-resolved")
  })

  it("does not resolve when the page doesn't exist", async () => {
    setProject("/project")
    disableLlm() // prevent stage-2 LLM stage from running
    addPending([{ title: "Missing page: neverwritten", type: "missing-page" }])

    mockListDirectory.mockResolvedValue([fileNode("other.md")])
    mockReadFile.mockResolvedValue("")

    const resolved = await sweepResolvedReviews("/project")
    expect(resolved).toBe(0)
    expect(useReviewStore.getState().items[0].resolved).toBe(false)
  })
})

describe("sweep — LLM batch loop", () => {
  it("processes pending items in batches of JUDGE_BATCH_SIZE=40 and breaks when a batch resolves nothing", async () => {
    setProject("/project")
    // 80 pending items, none rule-resolvable (suggestion bypasses rule stage)
    const items = Array.from({ length: 80 }, (_, i) => ({
      type: "suggestion" as ReviewItem["type"],
      title: `Suggestion ${i}`,
    }))
    addPending(items)
    // Snapshot the original insertion order — this is what sweep's stillPending
    // will contain, and the batches splice from the FRONT of that array.
    const orderedIds = useReviewStore.getState().items.map((i) => i.id)

    const sweepPromise = sweepResolvedReviews("/project")
    await waitUntil(() => harness.pending.length === 1)

    // Batch 1 = items 0..39. Resolve the first 3.
    await harness.complete(JSON.stringify({ resolved: orderedIds.slice(0, 3) }))
    await waitUntil(() => harness.pending.length === 2)

    // Batch 2 = items 40..79. Resolve nothing → loop should break.
    await harness.complete(JSON.stringify({ resolved: [] }))

    const total = await sweepPromise
    expect(total).toBe(3)
    // Early-break: no third batch was fired
    expect(harness.pending).toHaveLength(2)
  })

  it("continues across batches when each resolves something", async () => {
    setProject("/project")
    const items = Array.from({ length: 120 }, (_, i) => ({
      type: "suggestion" as ReviewItem["type"],
      title: `S${i}`,
    }))
    addPending(items)
    const orderedIds = useReviewStore.getState().items.map((i) => i.id)

    const sweepPromise = sweepResolvedReviews("/project")

    // 120 items / 40 per batch = 3 batches. For each, resolve the first 5
    // ids of THAT batch's slice from the original insertion order.
    for (let batch = 0; batch < 3; batch++) {
      await waitUntil(() => harness.pending.length === batch + 1)
      const start = batch * 40
      const batchIds = orderedIds.slice(start, start + 40).slice(0, 5)
      await harness.complete(JSON.stringify({ resolved: batchIds }))
    }

    const total = await sweepPromise
    expect(total).toBe(15) // 5 per batch × 3 batches
    expect(harness.pending).toHaveLength(3)
  })

  it("caps at MAX_JUDGE_BATCHES=5 even if more batches would have content", async () => {
    setProject("/project")
    // 300 items — would be 8 batches at 40/each, but capped at 5
    const items = Array.from({ length: 300 }, (_, i) => ({
      type: "suggestion" as ReviewItem["type"],
      title: `S${i}`,
    }))
    addPending(items)
    const orderedIds = useReviewStore.getState().items.map((i) => i.id)

    const sweepPromise = sweepResolvedReviews("/project")

    for (let b = 0; b < 5; b++) {
      await waitUntil(() => harness.pending.length === b + 1)
      const batchIds = orderedIds.slice(b * 40, b * 40 + 40).slice(0, 2)
      await harness.complete(JSON.stringify({ resolved: batchIds }))
    }
    await sweepPromise

    // Exactly 5 LLM calls fired, not 8 (the cap)
    expect(harness.pending).toHaveLength(5)
  })
})

describe("sweep — resolveItem safety after project switch", () => {
  it("does not apply LLM results if project switched while LLM was running", async () => {
    setProject("/project-A")
    const items = Array.from({ length: 3 }, (_, i) => ({
      type: "suggestion" as ReviewItem["type"],
      title: `S${i}`,
    }))
    addPending(items)
    const aIds = useReviewStore.getState().items.map((i) => i.id)

    const ac = new AbortController()
    const sweepPromise = sweepResolvedReviews("/project-A", ac.signal)

    await flushMicrotasks(5)
    expect(harness.pending).toHaveLength(1)

    // Switch project mid-LLM: reset review store to B's state
    setProject("/project-B")
    useReviewStore.setState({ items: [] })
    // Also abort, as the real clearQueueState would
    ac.abort()

    // Complete the LLM call (ignored because aborted + project changed)
    await harness.complete(JSON.stringify({ resolved: aIds }))
    await sweepPromise

    // Nothing in the (now-B) store should be resolved
    expect(useReviewStore.getState().items).toHaveLength(0)
  })
})

describe("sweep — empty / no-op cases", () => {
  it("returns 0 and does not touch the LLM when there are no pending items", async () => {
    setProject("/project")
    const resolved = await sweepResolvedReviews("/project")
    expect(resolved).toBe(0)
    expect(harness.pending).toHaveLength(0)
  })

  it("returns 0 when LLM is not configured", async () => {
    setProject("/project")
    useWikiStore.setState({
      llmConfig: {
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 0,
      },
    })
    addPending([{ title: "X", type: "suggestion" }])

    const resolved = await sweepResolvedReviews("/project")
    expect(resolved).toBe(0)
    expect(harness.pending).toHaveLength(0)
  })
})

// Keep unused import silent
void createDeferred
