/**
 * Truncation detection for single-pass ingest analysis.
 *
 * When Stage 1 finishes with finish_reason=length, the pipeline prints a
 * warning (console + ingest-warnings.log) and continues with the partial
 * analysis — there is no automatic fallback. The test mocks streamChat at
 * the transport boundary so finish_reason flows through the real callback
 * signature.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs, createTempProject, fileExists, readFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

interface ScriptedCall {
  tokens?: string[]
  finishReason?: string
}
let scriptedCalls: ScriptedCall[] = []
let defaultCall: ScriptedCall = { tokens: [""] }
const streamCalls: Array<{
  system: string
  user: string
  overrides: Record<string, unknown>
}> = []
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (
    _cfg: unknown,
    messages: Array<{ role: string; content: string }>,
    cb: {
      onToken: (t: string) => void
      onDone: (info?: { finishReason?: string }) => void
      onError: (e: Error) => void
    },
    _signal?: AbortSignal,
    overrides?: Record<string, unknown>,
  ) => {
    streamCalls.push({
      system: messages[0]?.content ?? "",
      user: messages[1]?.content ?? "",
      overrides: overrides ?? {},
    })
    const call = scriptedCalls.length > 0 ? scriptedCalls.shift()! : defaultCall
    for (const token of call.tokens ?? [""]) cb.onToken(token)
    cb.onDone(call.finishReason ? { finishReason: call.finishReason } : undefined)
  }),
}))

import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import type { LlmConfig } from "@/stores/wiki-store"

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "test-key",
  model: "gpt-4",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 128_000,
}

let tmp: { path: string; cleanup: () => Promise<void> } | undefined

async function setupProject(source: string): Promise<string> {
  const project = await createTempProject("ingest-truncation")
  tmp = project
  const sourcePath = path.join(project.path, "sources", "book.txt")
  await fs.mkdir(path.dirname(sourcePath), { recursive: true })
  await fs.writeFile(sourcePath, source, "utf-8")
  await fs.mkdir(path.join(project.path, "wiki"), { recursive: true })
  await fs.writeFile(path.join(project.path, "wiki", "index.md"), "# Wiki Index\n", "utf-8")

  useWikiStore.setState({
    project: {
      name: "truncation-test",
      path: project.path,
      createdAt: 0,
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
  })
  useWikiStore.getState().setLlmConfig(llmConfig)
  return sourcePath
}

beforeEach(() => {
  scriptedCalls = []
  defaultCall = { tokens: [""] }
  streamCalls.length = 0
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

afterEach(async () => {
  vi.restoreAllMocks()
  if (tmp) {
    await tmp.cleanup()
    tmp = undefined
  }
})

const GENERATION = [
  "---FILE: wiki/entities/truncation-marker.md---",
  "---",
  "type: entity",
  "title: Truncation Marker",
  'sources: ["book.txt"]',
  "---",
  "",
  "# Truncation Marker",
  "",
  "Generated from the partial analysis.",
  "---END FILE---",
  "",
].join("\n")

describe("ingest single-pass truncation warning", () => {
  it("prints and persists a warning, then continues with the partial analysis", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const sourcePath = await setupProject("第一段。这是测试源文内容。".repeat(20))

    scriptedCalls = [
      // Stage 1 single-pass analysis — truncated at max_tokens.
      { tokens: ["## 来源分析\n| 实体 |"], finishReason: "length" },
      // Stage 2 generation.
      { tokens: [GENERATION] },
    ]

    const written = await autoIngest(tmp!.path, sourcePath, llmConfig)

    // No fallback: exactly one analysis call + one generation call.
    expect(streamCalls).toHaveLength(2)
    expect(streamCalls[0].overrides.max_tokens).toBe(4_096)
    // Stage 2 received the truncated partial analysis as-is.
    expect(streamCalls[1].user).toContain("| 实体 |")
    // The truncation was printed and persisted as an ingest warning.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Single-pass analysis output truncated at max_tokens=4096"))
    const warnings = await readFileRaw(path.join(tmp!.path, ".llm-wiki", "ingest-warnings.log"))
    expect(warnings).toContain("Single-pass analysis output truncated at max_tokens=4096")

    expect(written).toContain("wiki/entities/truncation-marker.md")
    expect(await fileExists(path.join(tmp!.path, "wiki", "entities", "truncation-marker.md"))).toBe(true)
  })
})
