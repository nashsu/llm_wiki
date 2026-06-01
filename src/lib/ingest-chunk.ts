/**
 * Chunking and long-source analysis for the ingest pipeline.
 *
 * Extracted from ingest.ts (Phase 3.7, PR 2). No logic changes.
 * Re-exported by ingest.ts so external callers are unaffected.
 */

import { readFile, writeFile, createDirectory, deleteFile, fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { computeContextBudget } from "@/lib/context-budget"
import { languageRule, trimLongText } from "./ingest-prompts"

const LONG_SOURCE_MIN_BUDGET = 8_000
const LONG_SOURCE_MAX_SINGLE_PASS_BUDGET = 300_000
const LONG_SOURCE_CHUNK_MIN = 12_000
const LONG_SOURCE_CHUNK_MAX = 60_000
const LONG_SOURCE_DIGEST_MAX = 15_000
const LONG_SOURCE_CHUNK_ANALYSIS_MAX = 40_000
const INGEST_GENERATION_TOKENS_DEFAULT = 8_192
const INGEST_GENERATION_TOKENS_128K = 16_384
const INGEST_GENERATION_TOKENS_256K = 24_576
const INGEST_GENERATION_TOKENS_512K = 32_768

export interface SourceChunk {
  id: string
  index: number
  total: number
  headingPath: string
  overlapBefore: string
  main: string
}

export interface LongSourcePlan {
  chunked: boolean
  analysis: string
  sourceContext: string
  checkpointPath?: string
}

export interface LongSourceCheckpoint {
  version: 1
  sourceIdentity: string
  sourceHash: string
  sourceLength: number
  sourceBudget: number
  targetChars: number
  overlapChars: number
  chunkTotal: number
  completedThrough: number
  globalDigest: string
  analyses: string[]
  updatedAt: number
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function computeIngestSourceBudget(
  maxContextSize: number | undefined,
  stableContextLength: number,
): number {
  const { maxCtx, responseReserve } = computeContextBudget(maxContextSize)
  const stableReserve = Math.min(Math.floor(maxCtx * 0.25), Math.max(12_000, stableContextLength))
  const instructionReserve = Math.max(12_000, Math.floor(maxCtx * 0.08))
  const available = maxCtx - responseReserve - stableReserve - instructionReserve
  const upper = Math.min(LONG_SOURCE_MAX_SINGLE_PASS_BUDGET, Math.max(LONG_SOURCE_MIN_BUDGET, Math.floor(maxCtx * 0.6)))
  return clampNumber(Math.floor(available), LONG_SOURCE_MIN_BUDGET, upper)
}

export function computeIngestGenerationMaxTokens(maxContextSize: number | undefined): number {
  const { maxCtx } = computeContextBudget(maxContextSize)
  if (maxCtx >= 512_000) return INGEST_GENERATION_TOKENS_512K
  if (maxCtx >= 256_000) return INGEST_GENERATION_TOKENS_256K
  if (maxCtx >= 128_000) return INGEST_GENERATION_TOKENS_128K
  return INGEST_GENERATION_TOKENS_DEFAULT
}

export function computeIngestReviewMaxTokens(maxContextSize: number | undefined): number {
  return Math.min(8_192, Math.max(4_096, Math.floor(computeIngestGenerationMaxTokens(maxContextSize) / 2)))
}

export function splitOversizedBlock(block: string, targetChars: number): string[] {
  if (block.length <= targetChars * 1.25) return [block]

  const pieces = block.match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g) ?? [block]
  const out: string[] = []
  let current = ""
  for (const piece of pieces) {
    if (current && current.length + piece.length > targetChars) {
      out.push(current.trim())
      current = ""
    }
    if (piece.length > targetChars) {
      for (let i = 0; i < piece.length; i += targetChars) {
        const slice = piece.slice(i, i + targetChars).trim()
        if (slice) out.push(slice)
      }
    } else {
      current += piece
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export function semanticBlocks(content: string, targetChars: number): Array<{ text: string; headingPath: string }> {
  const blocks: Array<{ text: string; headingPath: string }> = []
  const headingStack: string[] = []
  let paragraph: string[] = []
  let paragraphHeading = ""

  const currentHeadingPath = () => headingStack.filter(Boolean).join(" > ")
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    if (text) {
      for (const piece of splitOversizedBlock(text, targetChars)) {
        blocks.push({ text: piece, headingPath: paragraphHeading })
      }
    }
    paragraph = []
  }

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      const depth = heading[1].length
      headingStack.length = depth - 1
      headingStack[depth - 1] = heading[2].trim()
      blocks.push({ text: line.trim(), headingPath: currentHeadingPath() })
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (line.trim() === "") {
      flushParagraph()
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (paragraph.length === 0) paragraphHeading = currentHeadingPath()
    paragraph.push(line)
  }
  flushParagraph()

  return blocks
}

export function overlapSuffix(text: string, maxChars: number): string {
  if (!text || maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const raw = text.slice(-maxChars)
  const paragraphBreak = raw.search(/\n\s*\n/)
  if (paragraphBreak > 0 && raw.length - paragraphBreak > maxChars * 0.4) {
    return raw.slice(paragraphBreak).trim()
  }
  const sentenceBreak = raw.search(/[.!?。！？]\s+/)
  if (sentenceBreak > 0 && raw.length - sentenceBreak > maxChars * 0.4) {
    return raw.slice(sentenceBreak + 1).trim()
  }
  return raw.trim()
}

export function splitSourceIntoSemanticChunks(
  content: string,
  targetChars: number,
  overlapChars: number,
): SourceChunk[] {
  const target = Math.max(1_000, targetChars)
  const blocks = semanticBlocks(content, target)
  if (blocks.length === 0) return []

  const rawChunks: Array<{ main: string; headingPath: string }> = []
  let current: string[] = []
  let currentLength = 0
  let currentHeading = blocks[0]?.headingPath ?? ""

  const flush = () => {
    const main = current.join("\n\n").trim()
    if (main) rawChunks.push({ main, headingPath: currentHeading })
    current = []
    currentLength = 0
  }

  for (const block of blocks) {
    const nextLength = currentLength + block.text.length + (current.length > 0 ? 2 : 0)
    if (current.length > 0 && nextLength > target) {
      flush()
    }
    if (current.length === 0) currentHeading = block.headingPath
    current.push(block.text)
    currentLength += block.text.length + (current.length > 1 ? 2 : 0)
  }
  flush()

  return rawChunks.map((chunk, idx) => ({
    id: `chunk-${idx + 1}`,
    index: idx + 1,
    total: rawChunks.length,
    headingPath: chunk.headingPath,
    overlapBefore: idx > 0 ? overlapSuffix(rawChunks[idx - 1].main, overlapChars) : "",
    main: chunk.main,
  }))
}

export function hashTextHex(text: string): string {
  // 64-bit FNV-1a over UTF-16 code units. This is a stability key, not
  // a security primitive; validation also checks source length/chunk
  // shape before resuming a checkpoint.
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * prime)
  }
  return hash.toString(16).padStart(16, "0")
}

export function longSourceCheckpointPath(
  projectPath: string,
  sourceSummarySlug: string,
  sourceHash: string,
): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-progress/${sourceSummarySlug}-${sourceHash}.json`
}

export function isCompatibleLongSourceCheckpoint(
  checkpoint: LongSourceCheckpoint,
  params: {
    sourceIdentity: string
    sourceHash: string
    sourceLength: number
    sourceBudget: number
    targetChars: number
    overlapChars: number
    chunkTotal: number
  },
): boolean {
  return checkpoint.version === 1
    && checkpoint.sourceIdentity === params.sourceIdentity
    && checkpoint.sourceHash === params.sourceHash
    && checkpoint.sourceLength === params.sourceLength
    && checkpoint.sourceBudget === params.sourceBudget
    && checkpoint.targetChars === params.targetChars
    && checkpoint.overlapChars === params.overlapChars
    && checkpoint.chunkTotal === params.chunkTotal
    && checkpoint.completedThrough >= 0
    && checkpoint.completedThrough <= params.chunkTotal
    && Array.isArray(checkpoint.analyses)
    && checkpoint.analyses.length === checkpoint.completedThrough
}

export async function loadLongSourceCheckpoint(
  checkpointPath: string,
  params: Parameters<typeof isCompatibleLongSourceCheckpoint>[1],
): Promise<LongSourceCheckpoint | null> {
  try {
    const raw = await readFile(checkpointPath)
    const parsed = JSON.parse(raw) as LongSourceCheckpoint
    if (!isCompatibleLongSourceCheckpoint(parsed, params)) return null
    return parsed
  } catch {
    return null
  }
}

export async function saveLongSourceCheckpoint(
  checkpointPath: string,
  checkpoint: LongSourceCheckpoint,
): Promise<void> {
  const dir = checkpointPath.split("/").slice(0, -1).join("/")
  await createDirectory(dir)
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2))
}

export async function clearLongSourceCheckpoint(checkpointPath: string): Promise<void> {
  try {
    if (await fileExists(checkpointPath)) {
      await deleteFile(checkpointPath)
    }
  } catch {
    // Best-effort cleanup. A stale checkpoint is ignored if source
    // hash / chunk shape no longer matches.
  }
}

export function extractMarkedSection(raw: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
  return re.exec(raw)?.[1]?.trim() ?? ""
}

export function buildChunkAnalysisSystemPrompt(
  purpose: string,
  schema: string,
  index: string,
  sourceContent: string,
): string {
  return [
    "You are analyzing a long source document for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript.",
    "Analyze only the current MAIN CHUNK. Use overlap and digest for context only.",
    "Keep stable names consistent with the existing wiki and prior digest.",
    "",
    languageRule(sourceContent),
    "",
    "Output exactly two markdown sections:",
    "",
    "## Chunk Analysis",
    "- Concise summary of the main chunk",
    "- New or updated entities",
    "- New or updated concepts",
    "- Claims, findings, evidence, contradictions",
    "- Open questions or research gaps",
    "",
    "## Updated Global Digest",
    "A compact document-level digest that incorporates this chunk and preserves prior cross-chunk context.",
    "Keep this digest structured under: Summary, Entities, Concepts, Claims, Evidence, Contradictions, Open Questions, Cross-Chunk Relations.",
    "",
    "Stable project context follows. It changes rarely and should be treated as background:",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, 40_000)}` : "",
  ].filter(Boolean).join("\n")
}

export function buildChunkAnalysisUserPrompt(
  sourceIdentity: string,
  folderContext: string | undefined,
  chunk: SourceChunk,
  globalDigest: string,
): string {
  return [
    `Source file: ${sourceIdentity}`,
    folderContext ? `Folder context: ${folderContext}` : "",
    `Chunk: ${chunk.index}/${chunk.total}`,
    chunk.headingPath ? `Heading path: ${chunk.headingPath}` : "",
    "",
    "## Current Global Digest",
    globalDigest || "(No prior digest yet.)",
    "",
    chunk.overlapBefore ? "## Previous Overlap Context\n" + chunk.overlapBefore : "",
    "",
    "## MAIN CHUNK TO ANALYZE",
    chunk.main,
    "",
    "Return only the two requested sections. Do not repeat overlap-only facts unless the main chunk supports them.",
  ].filter(Boolean).join("\n")
}

export async function analyzeLongSourceInChunks(
  projectPath: string,
  llmConfig: LlmConfig,
  purpose: string,
  schema: string,
  index: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
  folderContext: string | undefined,
  sourceContent: string,
  sourceBudget: number,
  activityId: string,
  signal?: AbortSignal,
): Promise<LongSourcePlan> {
  const targetChars = clampNumber(Math.floor(sourceBudget * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX)
  const overlapChars = clampNumber(Math.floor(targetChars * 0.08), 800, 3_000)
  const chunks = splitSourceIntoSemanticChunks(sourceContent, targetChars, overlapChars)
  if (chunks.length <= 1) {
    return { chunked: false, analysis: "", sourceContext: sourceContent }
  }

  const activity = useActivityStore.getState()
  const systemPrompt = buildChunkAnalysisSystemPrompt(purpose, schema, index, sourceContent)
  const sourceHash = hashTextHex(sourceContent)
  const checkpointPath = longSourceCheckpointPath(projectPath, sourceSummarySlug, sourceHash)
  const checkpointParams = {
    sourceIdentity,
    sourceHash,
    sourceLength: sourceContent.length,
    sourceBudget,
    targetChars,
    overlapChars,
    chunkTotal: chunks.length,
  }
  const checkpoint = await loadLongSourceCheckpoint(checkpointPath, checkpointParams)
  let globalDigest = checkpoint?.globalDigest ?? ""
  const analyses: string[] = checkpoint?.analyses ? [...checkpoint.analyses] : []
  let completedThrough = checkpoint?.completedThrough ?? 0

  if (completedThrough > 0) {
    activity.updateItem(activityId, {
      detail: `Resuming long source analysis from chunk ${completedThrough + 1}/${chunks.length}...`,
    })
  }

  for (const chunk of chunks) {
    if (chunk.index <= completedThrough) continue
    if (signal?.aborted) throw new Error("Ingest cancelled")
    activity.updateItem(activityId, {
      detail: `Analyzing long source chunk ${chunk.index}/${chunk.total}...`,
    })

    let raw = ""
    let hadError = false
    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: buildChunkAnalysisUserPrompt(
            sourceIdentity,
            folderContext,
            chunk,
            trimLongText(globalDigest, LONG_SOURCE_DIGEST_MAX),
          ),
        },
      ],
      {
        onToken: (token) => { raw += token },
        onDone: () => {},
        onError: (err) => {
          hadError = true
          activity.updateItem(activityId, { status: "error", detail: `Chunk analysis failed: ${err.message}` })
        },
      },
      signal,
      { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: 4096 },
    )

    if (signal?.aborted) throw new Error("Ingest cancelled")
    if (hadError) throw new Error("Chunk analysis stream failed")

    const chunkAnalysis = extractMarkedSection(raw, "Chunk Analysis") || raw.trim()
    const nextDigest = extractMarkedSection(raw, "Updated Global Digest")
    analyses.push([
      `## Chunk ${chunk.index}/${chunk.total}${chunk.headingPath ? ` — ${chunk.headingPath}` : ""}`,
      trimLongText(chunkAnalysis, LONG_SOURCE_CHUNK_ANALYSIS_MAX),
    ].join("\n"))

    globalDigest = trimLongText(
      nextDigest || [globalDigest, chunkAnalysis].filter(Boolean).join("\n\n"),
      LONG_SOURCE_DIGEST_MAX,
    )
    completedThrough = chunk.index
    await saveLongSourceCheckpoint(checkpointPath, {
      version: 1,
      ...checkpointParams,
      completedThrough,
      globalDigest,
      analyses,
      updatedAt: Date.now(),
    })
  }

  const analysis = [
    "# Consolidated Long-Document Analysis",
    "",
    "## Final Global Digest",
    globalDigest || "(No digest produced.)",
    "",
    "## Per-Chunk Analyses",
    analyses.join("\n\n"),
  ].join("\n")

  const sourceContext = [
    `# Long Source Context: ${sourceIdentity}`,
    "",
    `The original source was analyzed in ${chunks.length} semantic chunks with paragraph/section boundaries and overlap. Use this consolidated context instead of assuming the raw document ended early.`,
    "",
    "## Final Global Digest",
    globalDigest || "(No digest produced.)",
    "",
    "## Chunk Analysis Notes",
    trimLongText(analyses.join("\n\n"), Math.max(sourceBudget, LONG_SOURCE_CHUNK_ANALYSIS_MAX)),
  ].join("\n")

  return { chunked: true, analysis, sourceContext, checkpointPath }
}

/**
 * Build a MergeFn for a given LLM config. The returned function asks
 * the model to merge two versions of the same wiki page into one.
 * Page-merge.ts handles all the sanity-checking and fallback paths;
 * this is just the "stream the LLM" wrapper.
 */
