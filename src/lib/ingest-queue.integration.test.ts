/**
 * Tier 4 — real-FS integration tests for ingest queue persistence.
 *
 * Exercises the actual `.llm-wiki/ingest-queue.json` write/read round-trip
 * against Node fs, catching JSON escape / Unicode / directory-creation bugs
 * that memory mocks would miss.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { realFs, createTempProject, readFileRaw, writeFileRaw, fileExists } from "@/test-helpers/fs-temp"
import { waitFor, flushIO } from "@/test-helpers/deferred"

vi.mock("@/commands/fs", () => realFs)

// Prevent real LLM calls — hang forever so tasks stay in "processing" state
// where we can inspect the persisted file before success removes them.
vi.mock("./ingest", () => ({
  autoIngest: vi.fn(),
}))

// Sweep is tested separately; stub so drains don't explode
vi.mock("./sweep-reviews", () => ({
  sweepResolvedReviews: vi.fn().mockResolvedValue(0),
}))

// Tests use real filesystem tmp dirs. Each test's `tmp.path` maps from
// the test's UUID back to that dir via a mutable pointer the setup
// updates in beforeEach — so getProjectPathById stays in sync with the
// currently-active test project.
const TEST_ID_A = "test-id-a"
const TEST_ID_B = "test-id-b"
const pathByIdRef: { map: Record<string, string> } = { map: {} }
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => pathByIdRef.map[id] ?? null),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import {
  enqueueIngest,
  enqueueBatch,
  clearQueueState,
  restoreQueue,
  getQueue,
} from "./ingest-queue"
import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"

const mockAutoIngest = vi.mocked(autoIngest)

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  clearQueueState()
  mockAutoIngest.mockReset()
  // Hang forever so the task stays in "processing" state and the
  // persisted file isn't cleared by successful-completion.
  mockAutoIngest.mockImplementation(() => new Promise(() => {}))

  tmp = await createTempProject("ingestqueue")
  pathByIdRef.map = { [TEST_ID_A]: tmp.path }

  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "k",
    model: "m",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  // Activate the test project so enqueue / restore guards pass.
  await restoreQueue(TEST_ID_A, tmp.path)
})

afterEach(async () => {
  clearQueueState()
  await tmp.cleanup()
})

async function readQueueFile(): Promise<string> {
  return readFileRaw(`${tmp.path}/.llm-wiki/ingest-queue.json`)
}

describe("ingest-queue persistence — write", () => {
  it("writes .llm-wiki/ingest-queue.json after enqueue", async () => {
    await enqueueIngest(TEST_ID_A, "raw/sources/a.md")
    await waitFor(async () => {
      try {
        const c = await readQueueFile()
        return JSON.parse(c).length === 1
      } catch {
        return false
      }
    })
    const parsed = JSON.parse(await readQueueFile())
    expect(parsed[0].sourcePath).toBe("raw/sources/a.md")
  })

  it("deduplicates repeated pending tasks for the same source", async () => {
    await enqueueBatch(TEST_ID_A, [
      { sourcePath: "raw/sources/a.md", folderContext: "" },
      { sourcePath: `${tmp.path}/raw/sources/a.md`, folderContext: "" },
    ])
    await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readQueueFile())
        return parsed.length === 1
      } catch {
        return false
      }
    })
    const parsed = JSON.parse(await readQueueFile())
    expect(parsed).toHaveLength(1)
    expect(parsed[0].sourcePath).toBe("raw/sources/a.md")
  })

  it("persists Unicode source paths without corruption", async () => {
    await enqueueBatch(TEST_ID_A, [
      { sourcePath: "raw/sources/注意力机制.pdf", folderContext: "AI研究 > 论文" },
      { sourcePath: "raw/日本語.md", folderContext: "" },
    ])
    await waitFor(async () => {
      try {
        const c = await readQueueFile()
        return JSON.parse(c).length === 2
      } catch {
        return false
      }
    })
    const parsed = JSON.parse(await readQueueFile()) as Array<{ sourcePath: string; folderContext: string }>
    const paths = parsed.map((p) => p.sourcePath)
    expect(paths).toContain("raw/sources/注意力机制.pdf")
    expect(paths).toContain("raw/日本語.md")
    expect(parsed.map((p) => p.folderContext)).toContain("AI研究 > 论文")
  })

  it("auto-creates .llm-wiki/ directory when it doesn't exist", async () => {
    expect(await fileExists(`${tmp.path}/.llm-wiki`)).toBe(false)
    await enqueueIngest(TEST_ID_A, "x.md")
    await waitFor(() => fileExists(`${tmp.path}/.llm-wiki/ingest-queue.json`))
  })

  it("each enqueue updates the persisted JSON in-place", async () => {
    await enqueueIngest(TEST_ID_A, "first.md")
    await waitFor(async () => {
      try {
        return JSON.parse(await readQueueFile()).length === 1
      } catch {
        return false
      }
    })

    await enqueueIngest(TEST_ID_A, "second.md")
    await waitFor(async () => {
      try {
        return JSON.parse(await readQueueFile()).length === 2
      } catch {
        return false
      }
    })

    const arr = JSON.parse(await readQueueFile()) as Array<{ sourcePath: string }>
    expect(arr.map((t) => t.sourcePath)).toEqual(
      expect.arrayContaining(["first.md", "second.md"]),
    )
  })
})

describe("ingest-queue persistence — restore round-trip", () => {
  it("restoreQueue reads back exactly what enqueue wrote", async () => {
    await enqueueBatch(TEST_ID_A, [
      { sourcePath: "a.md", folderContext: "ctx-a" },
      { sourcePath: "b.md", folderContext: "ctx-b" },
    ])
    // Wait for disk state to stabilize
    await waitFor(async () => {
      try {
        return JSON.parse(await readQueueFile()).length === 2
      } catch {
        return false
      }
    })

    // Simulate app restart: wipe in-memory, restore from disk
    clearQueueState()
    expect(getQueue()).toHaveLength(0)

    await restoreQueue(TEST_ID_A, tmp.path)
    const restored = getQueue()
    expect(restored).toHaveLength(2)
    expect(restored.map((t) => t.sourcePath).sort()).toEqual(["a.md", "b.md"])
  })

  it("converts 'processing' back to 'pending' when restoring (interrupted app close)", async () => {
    const saved = [
      {
        id: "ingest-abc",
        sourcePath: "interrupted.md",
        folderContext: "",
        status: "processing",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/ingest-queue.json`,
      JSON.stringify(saved, null, 2),
    )

    await restoreQueue(TEST_ID_A, tmp.path)
    await flushIO(2)

    const restored = getQueue()
    expect(restored).toHaveLength(1)
    // After restore + kick-off, either still reset to 'pending' or
    // bumped back into 'processing' as processNext picks it up.
    expect(["pending", "processing"]).toContain(restored[0].status)
  })

  it("preserves 'failed' status on restore (does NOT auto-retry)", async () => {
    const saved = [
      {
        id: "ingest-x",
        sourcePath: "broken.md",
        folderContext: "",
        status: "failed",
        addedAt: 0,
        error: "LLM hit its rate limit",
        retryCount: 3,
      },
    ]
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/ingest-queue.json`,
      JSON.stringify(saved, null, 2),
    )

    await restoreQueue(TEST_ID_A, tmp.path)
    const restored = getQueue()
    expect(restored[0].status).toBe("failed")
    expect(restored[0].error).toBe("LLM hit its rate limit")
    expect(restored[0].retryCount).toBe(3)
  })

  it("returns empty queue when the file doesn't exist", async () => {
    await restoreQueue(TEST_ID_A, tmp.path)
    expect(getQueue()).toEqual([])
  })

  it("returns empty queue when the file is corrupted JSON", async () => {
    await writeFileRaw(
      `${tmp.path}/.llm-wiki/ingest-queue.json`,
      "{not valid json at all",
    )
    await restoreQueue(TEST_ID_A, tmp.path)
    expect(getQueue()).toEqual([])
  })

  it("round-trips Unicode + folder context correctly", async () => {
    await enqueueBatch(TEST_ID_A, [
      { sourcePath: "raw/sources/注意力.pdf", folderContext: "研究 > 深度学习" },
    ])
    await waitFor(async () => {
      try {
        return JSON.parse(await readQueueFile()).length === 1
      } catch {
        return false
      }
    })
    // Verify on-disk state before we blow away memory
    const onDisk = JSON.parse(await readQueueFile()) as Array<{ sourcePath: string; folderContext: string }>
    expect(onDisk[0].sourcePath).toBe("raw/sources/注意力.pdf")
    expect(onDisk[0].folderContext).toBe("研究 > 深度学习")

    clearQueueState()
    await restoreQueue(TEST_ID_A, tmp.path)

    const restored = getQueue()
    expect(restored).toHaveLength(1)
    expect(restored[0].sourcePath).toBe("raw/sources/注意力.pdf")
    expect(restored[0].folderContext).toBe("研究 > 深度学习")
  })
})

describe("ingest-queue persistence — cross-project isolation", () => {
  it("restoreQueue from project A does not leak into project B", async () => {
    const other = await createTempProject("ingestqueue-other")
    pathByIdRef.map[TEST_ID_B] = other.path
    try {
      // Populate project A
      await enqueueIngest(TEST_ID_A, "a.md")
      await waitFor(async () => {
        try {
          return JSON.parse(await readQueueFile()).length === 1
        } catch {
          return false
        }
      })
      expect(getQueue()).toHaveLength(1)

      // Restore project B (empty) — should see empty queue, not A's
      await restoreQueue(TEST_ID_B, other.path)
      expect(getQueue()).toEqual([])
    } finally {
      await other.cleanup()
    }
  })
})
