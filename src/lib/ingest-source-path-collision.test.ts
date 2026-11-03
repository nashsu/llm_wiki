import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import { migrateSourcePath } from "./source-lifecycle"

vi.mock("@/commands/fs", () => realFs)

let sourceMarkers: string[] = []
let failLongChunksOnce = new Set<number>()
let sectionResponses: Array<string | Error> = []
let sectionTruncatedOnce = false
let extraReviewResponse = ""
let generationPrefix = ""
let generationSuffix = ""
let truncatedRepairResponse = ""
let abortDuringReview: AbortController | null = null
let interactiveGenerationOverride = ""
let mergeRequestCount = 0
let truncateGenerationOnce = false
let emptyGenerationOnce = false
let confirmResumeCompleteOnce = false

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")
    const userPrompt = String(messages?.[1]?.content ?? "")

    if (systemPrompt.startsWith("You are merging source-backed material")) {
      mergeRequestCount++
      // A real merge keeps material from both inputs, so echo them.
      cb.onToken(`---\ntitle: merged\n---\n\n# merged wording\n\n${userPrompt}`)
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a wiki generation assistant")) {
      if (interactiveGenerationOverride) {
        cb.onToken(interactiveGenerationOverride)
        cb.onDone()
        return
      }
      cb.onToken([
        `---FILE: ${String(messages.at(-1)?.content).match(/exact path: \*\*([^*]+)\*\*/)?.[1] ?? "wiki/sources/config.md"}---`,
        "---",
        'type: "source"',
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Source: config.yaml",
        "",
        "Configuration source generated from the chat handoff.",
        "---END FILE---",
      ].join("\n"))
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are analyzing a long source document")) {
      const chunkMatch = userPrompt.match(/Chunk:\s*(\d+)\/(\d+)/)
      const chunkIndex = chunkMatch?.[1] ?? "0"
      const numericChunkIndex = Number(chunkIndex)
      if (failLongChunksOnce.has(numericChunkIndex)) {
        failLongChunksOnce.delete(numericChunkIndex)
        cb.onError(new Error(`chunk ${chunkIndex} failed once`))
        return
      }
      cb.onToken([
        "## Chunk Analysis",
        `Chunk ${chunkIndex} introduced topic ${chunkIndex}.`,
        "",
        "## Updated Global Digest",
        `Digest after chunk ${chunkIndex}: stable context ${chunkIndex}.`,
      ].join("\n"))
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are identifying high-value follow-up research items")) {
      if (abortDuringReview) {
        abortDuringReview.abort()
        throw new Error("AbortError")
      }
      cb.onToken(extraReviewResponse)
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are repairing truncated wiki FILE blocks")) {
      cb.onToken(truncatedRepairResponse)
      cb.onDone()
      return
    }

    if (userPrompt.includes("## Section Text")) {
      const next = sectionResponses.shift() ?? ""
      if (next instanceof Error) {
        cb.onError(next)
        return
      }
      cb.onToken(next)
      const truncated = sectionTruncatedOnce
      sectionTruncatedOnce = false
      cb.onDone({ finishReason: truncated ? "length" : "stop", truncated })
      return
    }

    const targetMatch = systemPrompt.match(
      /source summary page at \*\*(wiki\/sources\/[^*]+)\*\*/,
    )
    if (!targetMatch) {
      cb.onToken("## Analysis\nConfiguration source.")
      cb.onDone()
      return
    }

    if (emptyGenerationOnce) {
      emptyGenerationOnce = false
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }
    if (confirmResumeCompleteOnce) {
      confirmResumeCompleteOnce = false
      cb.onToken("---RESUME COMPLETE---")
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }

    const marker = sourceMarkers.shift() ?? "unknown project"
    const targetPath = targetMatch[1]
    const sourceIdentity =
      systemPrompt.match(/original source file is:\s*\*\*([^*]+)\*\*/i)?.[1] ?? "config.yaml"
    cb.onToken([
      generationPrefix,
      `---FILE: ${targetPath}---`,
      "---",
      `title: "Source: ${sourceIdentity}"`,
      `sources: ["${sourceIdentity}"]`,
      "---",
      "",
      `# ${marker}`,
      "",
      `Configuration details for ${marker}.`,
      "---END FILE---",
      generationSuffix,
    ].join("\n"))
    if (truncateGenerationOnce) {
      truncateGenerationOnce = false
      cb.onDone({ finishReason: "length", truncated: true })
    } else {
      cb.onDone({ finishReason: "stop", truncated: false })
    }
  }),
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import {
  autoIngest,
  buildFallbackSourceSummary,
  executeIngestWrites,
  groupChunksIntoSections,
  hasMineruImageRefs,
  withSourcePageList,
} from "./ingest"
import { streamChat } from "./llm-client"
import { parseWithMineruResult } from "./mineru"

const mockStreamChat = vi.mocked(streamChat)
const mockParseWithMineru = vi.mocked(parseWithMineruResult)

describe("autoIngest source summary paths", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    sourceMarkers = []
    failLongChunksOnce = new Set()
    sectionResponses = []
    sectionTruncatedOnce = false
    extraReviewResponse = ""
    generationPrefix = ""
    generationSuffix = ""
    truncatedRepairResponse = ""
    abortDuringReview = null
    interactiveGenerationOverride = ""
    mergeRequestCount = 0
    truncateGenerationOnce = false
    emptyGenerationOnce = false
    confirmResumeCompleteOnce = false
    mockStreamChat.mockClear()
    mockParseWithMineru.mockReset()
    tmp = await createTempProject("same-basename-sources")

    await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nTrack project config files.\n")
    await writeFileRaw(
      `${tmp.path}/schema.md`,
      "# Schema\n\nEach source needs its own source summary page.\n\n## Page Types\n| goal | wiki/goals/ | Outcomes |\n| habit | wiki/habits/ | Behaviours |",
    )
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.yaml`, "name: alpha\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-b/config.yaml`, "name: beta\n")

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
    useWikiStore.setState({
      project: {
        id: "same-basename-sources",
        name: "same-basename-sources",
        path: tmp.path,
      },
      fileTree: [],
      outputLanguage: "auto",
      multimodalConfig: {
        enabled: false,
        useMainLlm: true,
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "",
        customEndpoint: "",
        concurrency: 1,
      },
      embeddingConfig: {
        enabled: false,
        endpoint: "",
        apiKey: "",
        model: "",
      },
      mineruConfig: {
        enabled: false,
        backend: "cloud",
        token: "",
        modelVersion: "vlm",
      },
    })
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("detects MinerU image refs with URL-encoded source summary slugs", () => {
    expect(hasMineruImageRefs(
      "![chart](media/%E6%B1%A1%E6%B0%B4%20paper/mineru/images/chart%281%29.png)",
      "污水 paper",
    )).toBe(true)
    expect(hasMineruImageRefs(
      "![chart](media/污水 paper/mineru/images/chart.png)",
      "污水 paper",
    )).toBe(true)
    expect(hasMineruImageRefs(
      "![chart](media/other/mineru/images/chart.png)",
      "污水 paper",
    )).toBe(false)
  })

  it("preserves complete analysis in a fallback source summary", () => {
    const analysis = `begin-${"x".repeat(5000)}-end`
    const content = buildFallbackSourceSummary("long.md", analysis, "2026-07-11")
    expect(content).toContain(analysis)
    expect(content).toContain("-end")
  })

  it.each(["before", "after"])("preserves the exact summary when a cited work appears %s it", async (order) => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["correct source summary"]
    const citationPath = "wiki/sources/the-bitter-lesson.md"
    const existingCitation = "# Existing cited work\n\nKeep this page unchanged."
    await writeFileRaw(`${tmp.path}/${citationPath}`, existingCitation)
    const citationBlock = `---FILE: ${citationPath}---\n# Wrong cited-work summary\n---END FILE---`
    if (order === "before") generationPrefix = citationBlock
    else generationSuffix = citationBlock

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, useWikiStore.getState().llmConfig)
    const summaryPath = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const content = await fs.readFile(`${tmp.path}/${summaryPath}`, "utf8")

    expect(content).toContain("correct source summary")
    expect(content).not.toContain("Wrong cited-work summary")
    expect(written.filter((p) => p === summaryPath)).toHaveLength(1)
    expect(await fs.readFile(`${tmp.path}/${citationPath}`, "utf8")).toBe(existingCitation)
    expect(await fs.readFile(`${tmp.path}/.llm-wiki/ingest-warnings.log`, "utf8")).toContain(`Ignored unexpected source summary "${citationPath}"`)
  })

  it("preserves the first successful summary when its exact path is emitted twice", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["first correct summary"]
    const summaryPath = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    generationSuffix = `---FILE: ${summaryPath}---\n# Later incorrect replacement\n---END FILE---`

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, useWikiStore.getState().llmConfig)

    const content = await fs.readFile(`${tmp.path}/${summaryPath}`, "utf8")
    expect(content).toContain("first correct summary")
    expect(content).not.toContain("Later incorrect replacement")
    expect(await fs.readFile(`${tmp.path}/.llm-wiki/ingest-warnings.log`, "utf8")).toContain("Ignored duplicate source summary")
  })

  it("prevents schema routing from overwriting an already-written source summary", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["correct source summary"]
    await writeFileRaw(`${tmp.path}/schema.md`, "## Page Types\n| source | wiki/sources/ | Source summaries |")
    const slug = sourceSummarySlugFromIdentity("project-a/config.yaml")
    generationSuffix = `---FILE: wiki/concepts/${slug}.md---\n---\ntype: source\n---\n# Wrong routed replacement\n---END FILE---`

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, useWikiStore.getState().llmConfig)

    expect(await fs.readFile(`${tmp.path}/wiki/sources/${slug}.md`, "utf8")).toContain("correct source summary")
    expect(await fs.readFile(`${tmp.path}/.llm-wiki/ingest-warnings.log`, "utf8")).toContain("Ignored duplicate source summary")
  })

  it("does not repair an unexpected truncated source summary onto the current source", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["correct source summary"]
    generationSuffix = "---FILE: wiki/sources/cited-work.md---\n# Incomplete cited work"
    truncatedRepairResponse = "---FILE: wiki/sources/cited-work.md---\n# Wrong repair\n---END FILE---"

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, useWikiStore.getState().llmConfig)

    const summaryPath = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    expect(await fs.readFile(`${tmp.path}/${summaryPath}`, "utf8")).toContain("correct source summary")
    await expect(fs.access(`${tmp.path}/wiki/sources/cited-work.md`)).rejects.toThrow()
    expect(mockStreamChat.mock.calls.some(([, messages]) => String(messages[0]?.content).startsWith("You are repairing truncated wiki FILE blocks"))).toBe(false)
  })

  it("protects the source summary while repairing a different truncated page", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["correct source summary"]
    const summaryPath = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    generationSuffix = "---FILE: wiki/concepts/recovered.md---\n# Incomplete concept"
    truncatedRepairResponse = [
      "---FILE: wiki/concepts/recovered.md---\n# Recovered concept\n---END FILE---",
      `---FILE: ${summaryPath}---\n# Wrong replacement\n---END FILE---`,
      "---FILE: wiki/sources/cited-work.md---\n# Wrong cited work\n---END FILE---",
    ].join("\n")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, useWikiStore.getState().llmConfig)

    expect(written).toContain("wiki/concepts/recovered.md")
    expect(await fs.readFile(`${tmp.path}/${summaryPath}`, "utf8")).toContain("correct source summary")
    await expect(fs.access(`${tmp.path}/wiki/sources/cited-work.md`)).rejects.toThrow()
  })

  it("rejects additional and duplicate source summaries during interactive writes", async () => {
    if (!tmp) throw new Error("missing temp project")
    useChatStore.getState().createConversation()
    const summaryPath = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    interactiveGenerationOverride = [
      "---FILE: wiki/sources/cited-work.md---\n# Wrong cited work\n---END FILE---",
      `---FILE: ${summaryPath}---\n# Correct interactive summary\n---END FILE---`,
      `---FILE: ${summaryPath}---\n# Wrong duplicate\n---END FILE---`,
    ].join("\n")
    useChatStore.setState({ ingestSource: `${tmp.path}/raw/sources/project-a/config.yaml` })

    const written = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    expect(written).toEqual([`${tmp.path}/${summaryPath}`])
    expect(await fs.readFile(written[0], "utf8")).toContain("Correct interactive summary")
    await expect(fs.access(`${tmp.path}/wiki/sources/cited-work.md`)).rejects.toThrow()
    const warnings = await fs.readFile(`${tmp.path}/.llm-wiki/ingest-warnings.log`, "utf8")
    expect(warnings).toContain("Ignored unexpected source summary")
    expect(warnings).toContain("Ignored duplicate source summary")
    expect(useChatStore.getState().messages.some((m) => m.role === "system" && m.content.includes("Ingest warnings:"))).toBe(true)
  })

  it.each([
    `${"中文".repeat(35)}.md`,
    `${"资".repeat(30)}/${"文".repeat(70)}.md`,
  ])("ingests a long CJK source into a filesystem-safe summary: %s", async (identity) => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["long source ingested"]
    await writeFileRaw(`${tmp.path}/raw/sources/${identity}`, "Long CJK filename source.\n")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/${identity}`, useWikiStore.getState().llmConfig)
    const summaryPath = `wiki/sources/${sourceSummarySlugFromIdentity(identity)}.md`

    expect(written).toContain(summaryPath)
    expect(await fs.readFile(`${tmp.path}/${summaryPath}`, "utf8")).toContain("long source ingested")
    expect(await fs.readFile(`${tmp.path}/${summaryPath}`, "utf8")).toContain(identity)
    expect(useActivityStore.getState().items.some((item) => item.status === "error")).toBe(false)
  })

  it("keeps an existing portable CJK summary at its original path", async () => {
    if (!tmp) throw new Error("missing temp project")
    const stem = "中文".repeat(35)
    const identity = `${stem}.md`
    const oldSummaryPath = `${tmp.path}/wiki/sources/${stem}.md`
    sourceMarkers = ["regenerated long source"]
    await writeFileRaw(`${tmp.path}/raw/sources/${identity}`, "Updated source.\n")
    await writeFileRaw(oldSummaryPath, `---\nsources: ["${identity}"]\n---\n# Previous summary`)

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${identity}`, useWikiStore.getState().llmConfig)

    const summaryPath = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity(identity)}.md`
    expect(summaryPath).toBe(oldSummaryPath)
    expect(await fs.readFile(summaryPath, "utf8")).toContain("regenerated long source")
  })

  it("keeps distinct source summaries for same-basename files in different source subdirectories", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config", "project-b config"]

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )
    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-b/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-b",
    )

    const sourcesDir = path.join(tmp.path, "wiki", "sources")
    const summaryFiles = (await fs.readdir(sourcesDir))
      .filter((name) => name.endsWith(".md"))
      .sort()
    const summaryContents = await Promise.all(
      summaryFiles.map((name) => fs.readFile(path.join(sourcesDir, name), "utf8")),
    )
    const allSummaries = summaryContents.join("\n\n--- summary boundary ---\n\n")

    expect(summaryFiles).toHaveLength(2)
    expect(allSummaries).toContain("project-a/config.yaml")
    expect(allSummaries).toContain("project-b/config.yaml")
  })

  it("replaces stale content when a corrected source solely owns the page", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    sourceMarkers = ["obsolete wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    await writeFileRaw(sourcePath, "name: corrected\n")
    sourceMarkers = ["corrected wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    const summaryPath = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const content = await fs.readFile(summaryPath, "utf8")
    expect(content).toContain("corrected wording")
    expect(content).not.toContain("obsolete wording")
    expect(mergeRequestCount).toBe(0)
  })

  it("merges instead of replacing when an unchanged source is ingested again", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    sourceMarkers = ["first wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    // A page from the first run is gone, so the same source misses the cache.
    const cachePath = `${tmp.path}/.llm-wiki/ingest-cache.json`
    const cache = JSON.parse(await fs.readFile(cachePath, "utf8"))
    cache.entries["project-a/config.yaml"].filesWritten.push("wiki/concepts/gone.md")
    await fs.writeFile(cachePath, JSON.stringify(cache))

    sourceMarkers = ["second wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)
    const summaryPath = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    expect(await fs.readFile(summaryPath, "utf8")).toContain("merged wording")
    expect(mergeRequestCount).toBe(1)
  })

  it("merges instead of replacing when the source has no recorded ingest", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    sourceMarkers = ["first wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)
    await fs.rm(`${tmp.path}/.llm-wiki/ingest-cache.json`)

    sourceMarkers = ["second wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)
    const summaryPath = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    expect(await fs.readFile(summaryPath, "utf8")).toContain("merged wording")
    expect(mergeRequestCount).toBe(1)
  })

  it("tells the model which pages this source already has", async () => {
    if (!tmp) throw new Error("missing temp project")
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/known.md`,
      '---\ntitle: "Known: Topic"\nsources: ["project-a/config.yaml"]\n---\n# Known\n',
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/unrelated.md`,
      '---\ntitle: Unrelated\nsources: ["project-b/config.yaml"]\n---\n# Unrelated\n',
    )
    sourceMarkers = ["project-a config"]
    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
    )

    const generation = mockStreamChat.mock.calls
      .map(([, messages]) => String(messages[0]?.content))
      .find((prompt) => prompt.includes("source summary page at"))
    expect(generation).toContain("## Pages Already Generated From This Source")
    expect(generation).toContain("- wiki/concepts/known.md — Known: Topic")
    expect(generation).not.toContain("wiki/concepts/unrelated.md")
  })

  it("shows the model pages from other sources that the analysis mentions", async () => {
    if (!tmp) throw new Error("missing temp project")
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/configuration-source.md`,
      '---\ntitle: Configuration Source\nsources: ["other.pdf"]\n---\n# Body\n',
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/unmentioned.md`,
      '---\ntitle: Quantum Gravity\nsources: ["other.pdf"]\n---\n# Body\n',
    )
    sourceMarkers = ["project-a config"]
    await autoIngest(tmp.path, `${tmp.path}/raw/sources/project-a/config.yaml`, useWikiStore.getState().llmConfig)

    const generation = mockStreamChat.mock.calls
      .map(([, messages]) => String(messages[0]?.content))
      .find((prompt) => prompt.includes("source summary page at"))
    expect(generation).toContain("## Existing Pages This Source May Overlap With")
    expect(generation).toContain("- wiki/concepts/configuration-source.md \u2014 Configuration Source")
    expect(generation).not.toContain("wiki/concepts/unmentioned.md")
  })

  it("moves the canonical source summary and its source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["movable summary"]
    const oldSource = `${tmp.path}/raw/sources/project-a/config.yaml`
    await autoIngest(tmp.path, oldSource, useWikiStore.getState().llmConfig)

    const oldIdentity = "project-a/config.yaml"
    const newIdentity = "archive/config.yaml"
    const oldSummary = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity(oldIdentity)}.md`
    const newSummary = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity(newIdentity)}.md`
    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    await expect(fs.access(oldSummary)).rejects.toThrow()
    const content = await fs.readFile(newSummary, "utf8")
    expect(content).toContain('sources: ["archive/config.yaml"]')
  })

  it("migrates source references for a case-only rename", async () => {
    if (!tmp) throw new Error("missing temp project")
    const pagePath = `${tmp.path}/wiki/entities/case.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["project-a/config.yaml"]',
      "---",
      "# Case",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/Project-A/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["Project-A/config.yaml"]',
    )
  })

  it("migrates a unique legacy basename source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    // Remove the second same-basename source so the legacy shorthand is
    // unambiguous after the move.
    await fs.rm(`${tmp.path}/raw/sources/project-b/config.yaml`)
    const pagePath = `${tmp.path}/wiki/entities/legacy.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["config.yaml"]',
      "---",
      "# Legacy",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["archive/config.yaml"]',
    )
  })

  it("does not rewrite an ambiguous legacy basename source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    const pagePath = `${tmp.path}/wiki/entities/ambiguous.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["config.yaml"]',
      "---",
      "# Ambiguous",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["config.yaml"]',
    )
  })

  it("migrates a safe legacy basename source summary to the canonical nested source path", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    await fs.rm(path.join(tmp.path, "raw", "sources", "project-b", "config.yaml"))

    const legacySummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    await writeFileRaw(
      legacySummaryPath,
      [
        "---",
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "---",
        "",
        "# Legacy config",
        "",
        "Legacy source summary body.",
      ].join("\n"),
    )

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    const canonicalSummary = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary)
    const content = await fs.readFile(canonicalSummaryPath, "utf8")

    await expect(fs.access(legacySummaryPath)).rejects.toThrow()
    expect(content).toContain('sources: ["project-a/config.yaml"]')
    expect(content).toContain("project-a config")
  })

  it("does not migrate a legacy basename source summary when the basename is ambiguous", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]

    const legacySummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    const legacyContent = [
      "---",
      'title: "Source: config.yaml"',
      'sources: ["config.yaml"]',
      "---",
      "",
      "# Legacy config",
      "",
      "Ambiguous legacy source summary body.",
    ].join("\n")
    await writeFileRaw(legacySummaryPath, legacyContent)

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    const canonicalSummary = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary)

    expect(await fs.readFile(legacySummaryPath, "utf8")).toBe(legacyContent)
    expect(await fs.readFile(canonicalSummaryPath, "utf8")).toContain("project-a config")
  })

  it("analyzes oversized sources in chunks before final wiki generation", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["long source"]
    const longSourcePath = `${tmp.path}/raw/sources/project-a/long-report.md`
    await writeFileRaw(
      longSourcePath,
      [
        "# Chapter One",
        "",
        "A".repeat(9000),
        "",
        "## Chapter Two",
        "",
        "B".repeat(9000),
        "",
        "## Chapter Three",
        "",
        "C".repeat(9000),
      ].join("\n"),
    )

    await autoIngest(
      tmp.path,
      longSourcePath,
      { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 },
      undefined,
      "project-a",
    )

    const chunkCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith("You are analyzing a long source document"),
    )
    expect(chunkCalls.length).toBeGreaterThan(1)
    const chunkSystemPrompt = String(chunkCalls[0][1]?.[0]?.content ?? "")
    expect(chunkSystemPrompt).toContain("wiki/goals/")
    expect(chunkSystemPrompt).toContain("Schema-Typed Candidates")
    expect(chunkSystemPrompt).toContain("never invent goals")
    expect(String(chunkCalls[0][1]?.[1]?.content ?? "")).toContain("## MAIN CHUNK TO ANALYZE")
    expect(String(chunkCalls[1][1]?.[1]?.content ?? "")).toContain(
      "Digest after chunk 1: stable context 1.",
    )
    expect(String(chunkCalls[1][1]?.[1]?.content ?? "")).not.toContain(
      "introduced topic 1",
    )

    const generationCall = mockStreamChat.mock.calls.find(([, messages]) =>
      String(messages?.[1]?.content ?? "").includes("Long Source Context"),
    )
    expect(generationCall).toBeTruthy()
    const generationPrompt = String(generationCall?.[1]?.[1]?.content ?? "")
    expect(generationPrompt).toContain(
      `Digest after chunk ${chunkCalls.length}: stable context ${chunkCalls.length}.`,
    )
    const finalDigestSection = generationPrompt
      .split("## Source Context")[1]
      ?.split("## Chunk Analysis Notes")[0] ?? ""
    expect(finalDigestSection).toContain(
      `Digest after chunk ${chunkCalls.length}: stable context ${chunkCalls.length}.`,
    )
    expect(finalDigestSection).not.toContain(
      `Chunk ${chunkCalls.length} introduced topic ${chunkCalls.length}.`,
    )
  })

  describe("long source section passes", () => {
    const sectionPage = (name: string, extra = "") => [
      `---FILE: wiki/concepts/${name}.md---`,
      "---",
      "type: concept",
      `title: ${name}`,
      'sources: ["project-a/sections.md"]',
      "---",
      "",
      `# ${name}`,
      "",
      `Body of ${name}.`,
      "---END FILE---",
      extra,
    ].join("\n")
    const llmConfig = () => ({ ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 })
    const sectionCalls = () => mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages?.[1]?.content ?? "").includes("## Section Text"),
    )
    const finalCall = () => mockStreamChat.mock.calls.find(([, messages]) =>
      String(messages?.[1]?.content ?? "").includes("Long Source Context"),
    )
    const writeSource = () => writeFileRaw(
      `${tmp!.path}/raw/sources/project-a/sections.md`,
      ["# One", "", "A".repeat(9000), "", "## Two", "", "B".repeat(9000), "", "## Three", "", "C".repeat(9000)].join("\n"),
    )
    const ingest = () => autoIngest(tmp!.path, `${tmp!.path}/raw/sources/project-a/sections.md`, llmConfig(), undefined, "project-a")

    it("writes each section's pages, then a final pass that sees them all", async () => {
      await writeSource()
      sourceMarkers = ["final summary"]
      sectionResponses = [
        sectionPage("first-topic", "---FILE: wiki/log.md---\n## section log\n---END FILE---"),
        sectionPage("second-topic"),
        "",
      ]

      const written = await ingest()

      const calls = sectionCalls()
      expect(calls).toHaveLength(3)
      expect(String(calls[0][1]?.[1]?.content)).toContain("AAAA")
      expect(String(calls[0][1]?.[1]?.content)).not.toContain("BBBB")
      expect(String(calls[1][1]?.[1]?.content)).toContain("BBBB")
      // The second pass is told what the first one wrote, so it can extend it.
      expect(String(calls[1][1]?.[0]?.content)).toContain("wiki/concepts/first-topic.md")

      const final = String(finalCall()?.[1]?.[1]?.content)
      expect(final).toContain("- wiki/concepts/first-topic.md")
      expect(final).toContain("- wiki/concepts/second-topic.md")
      expect(written).toEqual(expect.arrayContaining(["wiki/concepts/first-topic.md", "wiki/concepts/second-topic.md"]))
      const log = await fs.readFile(`${tmp!.path}/wiki/log.md`, "utf8").catch(() => "")
      expect(log).not.toContain("section log")
      const summaryPath = `${tmp!.path}/wiki/sources/${sourceSummarySlugFromIdentity("project-a/sections.md")}.md`
      const summary = await fs.readFile(summaryPath, "utf8")
      expect(summary).toContain("final summary")
      expect(summary).toContain("## Pages From This Source\n\n### concepts\n\n- [[first-topic]]\n- [[second-topic]]")
    })

    it("continues a section after its output limit without repeating finished pages", async () => {
      await writeSource()
      sectionTruncatedOnce = true
      sectionResponses = [sectionPage("first-topic"), sectionPage("first-more"), "", ""]

      await ingest()

      const calls = sectionCalls()
      expect(calls).toHaveLength(4)
      expect(String(calls[1][1]?.[1]?.content)).toContain("AAAA")
      expect(String(calls[1][1]?.[1]?.content)).toContain("Already emitted for this section")
      expect(String(calls[1][1]?.[1]?.content)).toContain("- wiki/concepts/first-topic.md")
      expect(String(calls[2][1]?.[1]?.content)).toContain("BBBB")
      expect(String(calls[2][1]?.[1]?.content)).not.toContain("Already emitted")
    })

    it("resumes after a failed section and keeps the finished ones", async () => {
      await writeSource()
      sectionResponses = [sectionPage("first-topic"), new Error("boom")]
      await expect(ingest()).rejects.toThrow("Generation failed for section 2/3: boom")
      await expect(fs.access(`${tmp!.path}/wiki/concepts/first-topic.md`)).resolves.toBeUndefined()

      mockStreamChat.mockClear()
      sectionResponses = [sectionPage("second-topic"), ""]
      const written = await ingest()

      const calls = sectionCalls()
      expect(calls).toHaveLength(2)
      expect(String(calls[0][1]?.[1]?.content)).toContain("BBBB")
      expect(written).toEqual(expect.arrayContaining(["wiki/concepts/first-topic.md", "wiki/concepts/second-topic.md"]))
    })

    it("does not let a changed source's final pass replace a section's page", async () => {
      await writeSource()
      sectionResponses = [sectionPage("first-topic"), "", ""]
      await ingest()
      generationSuffix = sectionPage("first-topic").replace("Body of first-topic.", "Text from the final pass.")
      await fs.appendFile(`${tmp!.path}/raw/sources/project-a/sections.md`, "\n\nchanged")

      mockStreamChat.mockClear()
      sectionResponses = [sectionPage("first-topic"), "", ""]
      await ingest()

      const page = await fs.readFile(`${tmp!.path}/wiki/concepts/first-topic.md`, "utf8")
      expect(page).toContain("Body of first-topic")
      expect(page).toContain("Text from the final pass")
    })

    it("lists unlinked pages on the summary by folder and rebuilds an earlier list", () => {
      const summary = "# Book\n\nSee [[already-linked]].\n"
      const paths = [
        "wiki/concepts/b-topic.md",
        "wiki/methods/a-method.md",
        "wiki/concepts/already-linked.md",
        "wiki/sources/book.md",
        "wiki/log.md",
      ]
      const once = withSourcePageList(summary, paths)
      expect(once).toBe(
        "# Book\n\nSee [[already-linked]].\n\n## Pages From This Source\n\n### concepts\n\n- [[b-topic]]\n\n### methods\n\n- [[a-method]]\n",
      )
      expect(withSourcePageList(once, paths)).toBe(once)
      // A merge may have moved the list up; it goes back to the end and keeps its entries.
      const moved = once + "\n## Notes\n\nLater text.\n"
      const rebuilt = withSourcePageList(moved, ["wiki/concepts/c-topic.md"])
      expect(rebuilt).toContain("## Notes\n\nLater text.\n\n## Pages From This Source")
      expect(rebuilt).toContain("- [[b-topic]]\n- [[c-topic]]")
      expect(rebuilt).toContain("### methods\n\n- [[a-method]]")
      expect(withSourcePageList(summary, ["wiki/concepts/already-linked.md"])).toBe(summary)
    })

    it("merges a page into an existing page with the same name in another folder", async () => {
      await writeSource()
      sectionResponses = [
        sectionPage("first-topic"),
        [
          "---FILE: wiki/entities/first-topic.md---",
          "---",
          "type: entity",
          "title: first-topic",
          'sources: ["project-a/sections.md"]',
          "---",
          "",
          "# first-topic",
          "",
          "Second section's view.",
          "---END FILE---",
        ].join("\n"),
        "",
      ]

      await ingest()

      await expect(fs.access(`${tmp!.path}/wiki/entities/first-topic.md`)).rejects.toThrow()
      const page = await fs.readFile(`${tmp!.path}/wiki/concepts/first-topic.md`, "utf8")
      expect(page).toContain("Body of first-topic.")
      expect(page).toContain("Second section's view.")
    })

    it("groups chunks up to the limit and keeps an oversized chunk alone", () => {
      const sections = groupChunksIntoSections(
        [{ main: "a".repeat(40) }, { main: "b".repeat(40) }, { main: "c".repeat(200) }, { main: "d".repeat(10) }],
        ["na", "nb", "nc", "nd"],
        100,
      )
      expect(sections.map((s) => s.notes)).toEqual(["na\n\nnb", "nc", "nd"])
      expect(sections[0].text).toBe(`${"a".repeat(40)}\n\n${"b".repeat(40)}`)
    })
  })

  it("resumes oversized source analysis from the persisted chunk checkpoint", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["long source"]
    failLongChunksOnce = new Set([2])
    const longSourcePath = `${tmp.path}/raw/sources/project-a/resume-report.md`
    const llmConfig = { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 }
    await writeFileRaw(
      longSourcePath,
      [
        "# Chapter One",
        "",
        "A".repeat(9000),
        "",
        "## Chapter Two",
        "",
        "B".repeat(9000),
        "",
        "## Chapter Three",
        "",
        "C".repeat(9000),
      ].join("\n"),
    )

    await expect(
      autoIngest(tmp.path, longSourcePath, llmConfig, undefined, "project-a"),
    ).rejects.toThrow("Chunk analysis stream failed")

    const progressDir = path.join(tmp.path, ".llm-wiki", "ingest-progress")
    expect((await fs.readdir(progressDir)).filter((name) => name.endsWith(".json"))).toHaveLength(1)

    mockStreamChat.mockClear()
    await autoIngest(tmp.path, longSourcePath, llmConfig, undefined, "project-a")

    const resumedChunkCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith("You are analyzing a long source document"),
    )
    expect(resumedChunkCalls.length).toBeGreaterThan(0)
    expect(String(resumedChunkCalls[0][1]?.[1]?.content ?? "")).toContain("Chunk: 2/3")
    expect(String(resumedChunkCalls[0][1]?.[1]?.content ?? "")).toContain(
      "Digest after chunk 1: stable context 1.",
    )
    expect(String(resumedChunkCalls[0][1]?.[1]?.content ?? "")).not.toContain(
      "introduced topic 1",
    )
    await expect(fs.readdir(progressDir)).resolves.toEqual([])
  })

  it("adds follow-up research reviews from the dedicated review stage", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/nitrification-inhibition.md---",
      "---",
      'title: "Nitrification inhibition"',
      "---",
      "",
      "# Nitrification inhibition",
      "",
      "X".repeat(10_500),
      "---END FILE---",
    ].join("\n")
    extraReviewResponse = [
      "---REVIEW: suggestion | Research nitrification inhibition signals---",
      "Add follow-up research on early-warning indicators for nitrification inhibition.",
      "OPTIONS: Create Page | Skip",
      "SEARCH: nitrification inhibition early warning wastewater | ammonia oxidation inhibition signals | wastewater nitrification process upset indicators",
      "---END REVIEW---",
    ].join("\n")

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    const reviews = useReviewStore.getState().items
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      type: "suggestion",
      title: "Research nitrification inhibition signals",
    })
    expect(reviews[0].searchQueries).toEqual([
      "nitrification inhibition early warning wastewater",
      "ammonia oxidation inhibition signals",
      "wastewater nitrification process upset indicators",
    ])
  })

  it("parses generation and dedicated review-stage blocks separately", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---REVIEW: missing-page | Truncated Orphan---",
      "Partial description that got cut off",
    ].join("\n")
    extraReviewResponse = [
      "---REVIEW: suggestion | Real Follow-up---",
      "Real description that should not be swallowed by the generation orphan.",
      "OPTIONS: Create Page | Skip",
      "SEARCH: real follow up query | second query",
      "---END REVIEW---",
    ].join("\n")

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 },
      undefined,
      "project-a",
    )

    const reviews = useReviewStore.getState().items
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      type: "suggestion",
      title: "Real Follow-up",
    })
    expect(reviews[0].description).not.toContain("Truncated Orphan")
  })

  it("retries a truncated FILE block with a targeted generation request", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/recovered.md---",
      "---",
      'title: "Recovered concept"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "",
      "# Recovered concept",
      "",
      "This response was cut off",
    ].join("\n")
    truncatedRepairResponse = [
      "---FILE: wiki/concepts/recovered.md---",
      "---",
      'title: "Recovered concept"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "",
      "# Recovered concept",
      "",
      "This block was regenerated completely.",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/stray.md---",
      "# Stray concept",
      "---END FILE---",
    ].join("\n")

    const written = await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(written).toContain("wiki/concepts/recovered.md")
    await expect(
      fs.readFile(`${tmp.path}/wiki/concepts/recovered.md`, "utf8"),
    ).resolves.toContain("This block was regenerated completely.")
    expect(written).not.toContain("wiki/concepts/stray.md")
    await expect(
      fs.readFile(`${tmp.path}/wiki/concepts/stray.md`, "utf8"),
    ).rejects.toThrow()
    expect(
      mockStreamChat.mock.calls.some(([, messages]) =>
        String(messages[0]?.content ?? "").startsWith(
          "You are repairing truncated wiki FILE blocks",
        ),
      ),
    ).toBe(true)
  })

  it("auto-routes a generated typed page into its schema directory", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/outcome.md---",
      "---",
      "type: goal",
      'title: "Outcome"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "# Outcome",
      "---END FILE---",
    ].join("\n")

    const written = await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
    )

    expect(written).toContain("wiki/goals/outcome.md")
    expect(written).not.toContain("wiki/concepts/outcome.md")
    await expect(fs.readFile(`${tmp.path}/wiki/goals/outcome.md`, "utf8"))
      .resolves.toContain("# Outcome")
  })

  it("persists completed files and resumes after a truncated generation", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    sourceMarkers = ["first attempt", "resumed attempt"]
    generationSuffix = [
      "",
      "---FILE: wiki/goals/preserved.md---",
      "---",
      "type: goal",
      'title: "Preserved"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "# Preserved",
      "---END FILE---",
    ].join("\n")
    truncateGenerationOnce = true

    await expect(autoIngest(
      tmp.path,
      sourcePath,
      useWikiStore.getState().llmConfig,
    )).rejects.toThrow("generation reached its output limit")
    await expect(fs.readFile(`${tmp.path}/wiki/goals/preserved.md`, "utf8"))
      .resolves.toContain("# Preserved")

    emptyGenerationOnce = true
    await expect(autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig))
      .rejects.toThrow("resume returned no complete wiki file")
    await expect(fs.readdir(`${tmp.path}/.llm-wiki/ingest-generation`))
      .resolves.toHaveLength(1)

    confirmResumeCompleteOnce = true
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    const generationCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages[0]?.content ?? "").includes("## What to generate"),
    )
    const resumedPrompt = String(generationCalls[generationCalls.length - 1]?.[1]?.[1]?.content ?? "")
    expect(resumedPrompt)
      .toContain("## Resume checkpoint")
    expect(resumedPrompt).toContain("wiki/goals/preserved.md")
    const checkpointFiles = await fs.readdir(`${tmp.path}/.llm-wiki/ingest-generation`)
    expect(checkpointFiles).toHaveLength(0)
  })

  it("preserves a completed source summary when a resumed generation emits it again", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["first complete summary", "wrong resumed replacement"]
    truncateGenerationOnce = true
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    await expect(autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)).rejects.toThrow("generation reached its output limit")

    generationSuffix = "---FILE: wiki/concepts/remaining.md---\n# Remaining concept\n---END FILE---"
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    const summaryPath = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const content = await fs.readFile(`${tmp.path}/${summaryPath}`, "utf8")
    expect(content).toContain("first complete summary")
    expect(content).not.toContain("wrong resumed replacement")
  })

  it("rejects an ingest when a truncated FILE block cannot be repaired", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/incomplete.md---",
      "---",
      'title: "Incomplete concept"',
      'sources: ["project-a/config.yaml"]',
      "---",
      "",
      "# Incomplete concept",
      "",
      "This response was cut off",
    ].join("\n")
    truncatedRepairResponse = ""

    await expect(autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )).rejects.toThrow("Ingest incomplete")

    const activity = useActivityStore.getState().items[0]
    expect(activity.status).toBe("error")
    expect(activity.detail).toContain("could not be repaired")
    expect(activity.detail).toContain("wiki/concepts/incomplete.md")
  })

  it("propagates cancellation that happens during the dedicated review stage", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = `${"\n"}${"X".repeat(10_500)}`
    const controller = new AbortController()
    abortDuringReview = controller

    await expect(
      autoIngest(
        tmp.path,
        `${tmp.path}/raw/sources/project-a/config.yaml`,
        { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 },
        controller.signal,
        "project-a",
      ),
    ).rejects.toThrow("Ingest cancelled")
  })

  it("falls back to built-in PDF extraction when MinerU fails for a non-cancelled ingest", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["mineru fallback source"]
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/report.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        token: "mineru-token",
        modelVersion: "vlm",
      },
    })
    mockParseWithMineru.mockRejectedValueOnce(new Error("network failure from MinerU"))
    const updateSpy = vi.spyOn(useActivityStore.getState(), "updateItem")

    const written = await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/report.pdf`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(written.length).toBeGreaterThan(0)
    expect(mockParseWithMineru).toHaveBeenCalled()
    expect(
      updateSpy.mock.calls.some(([, updates]) =>
        updates.detail?.includes("falling back to built-in PDF extraction"),
      ),
    ).toBe(true)
    updateSpy.mockRestore()
  })

  it("uses a configured local MinerU backend without a cloud token", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["local mineru source"]
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/local.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        backend: "local",
        token: "",
        modelVersion: "vlm",
      },
    })
    mockParseWithMineru.mockResolvedValueOnce({
      markdown: "local MinerU markdown",
      savedImages: [],
    })

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/local.pdf`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(mockParseWithMineru).toHaveBeenCalled()
  })

  it("does not fall back to built-in PDF extraction when MinerU is cancelled", async () => {
    if (!tmp) throw new Error("missing temp project")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/cancelled.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        token: "mineru-token",
        modelVersion: "vlm",
      },
    })
    const controller = new AbortController()
    controller.abort()
    mockParseWithMineru.mockRejectedValueOnce(new Error("MinerU parsing cancelled"))

    await expect(
      autoIngest(
        tmp.path,
        `${tmp.path}/raw/sources/project-a/cancelled.pdf`,
        useWikiStore.getState().llmConfig,
        controller.signal,
        "project-a",
      ),
    ).rejects.toThrow("Ingest cancelled")

    expect(
      useActivityStore.getState().items.some((item) =>
        item.detail?.includes("falling back to built-in PDF extraction"),
      ),
    ).toBe(false)
  })

  it("canonicalizes interactive source frontmatter at the requested summary path", async () => {
    if (!tmp) throw new Error("missing temp project")

    const conversationId = "conv-interactive-source"
    useChatStore.setState({
      activeConversationId: conversationId,
      conversations: [
        {
          id: conversationId,
          title: "Interactive source summary",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      ingestSource: `${tmp.path}/raw/sources/project-a/config.yaml`,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Please save the source summary.",
          timestamp: Date.now(),
          conversationId,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Ready to create the source summary.",
          timestamp: Date.now(),
          conversationId,
        },
      ],
    })

    const writtenPaths = await executeIngestWrites(
      tmp.path,
      useWikiStore.getState().llmConfig,
    )

    const canonicalSummary = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary).replace(/\\/g, "/")
    const staleSummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    const content = await fs.readFile(canonicalSummaryPath, "utf8")

    expect(writtenPaths.map((p) => p.replace(/\\/g, "/"))).toEqual([canonicalSummaryPath])
    await expect(fs.access(staleSummaryPath)).rejects.toThrow()
    expect(content).toContain('sources: ["project-a/config.yaml"]')
  })

  it("rejects unsafe and application-managed paths from interactive writes", async () => {
    if (!tmp) throw new Error("missing temp project")
    interactiveGenerationOverride = [
      "---FILE: wiki/INDEX.md---\n# hostile index\n---END FILE---",
      "---FILE: wiki\\overview.MD---\n# hostile overview\n---END FILE---",
      "---FILE: ../escape.md---\n# escape\n---END FILE---",
    ].join("\n")
    useChatStore.setState({ ingestSource: `${tmp.path}/raw/sources/project-a/config.yaml` })

    const written = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    expect(written).toEqual([])
    await expect(fs.access(path.join(tmp.path, "escape.md"))).rejects.toThrow()
  })

  it("sanitizes malformed citation links in interactive writes", async () => {
    if (!tmp) throw new Error("missing temp project")
    interactiveGenerationOverride = [
      "---FILE: wiki/entities/citations.md---",
      "---",
      "type: entity",
      "title: Citations",
      "---",
      "Evidence [[1]] and [[target|label].",
      "---END FILE---",
    ].join("\n")
    useChatStore.setState({ ingestSource: null })

    const written = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    expect(written).toHaveLength(1)
    const content = await fs.readFile(written[0], "utf8")
    expect(content).toContain("Evidence [1] and [[target|label]].")
  })
})
