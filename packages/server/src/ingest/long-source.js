// Long-source chunked analysis for the server-driven ingest pipeline
// (issue #14 P0). Port of src/lib/ingest.ts regions:
//   - extractMarkedSection            (~2706-2710)
//   - analyzeLongSourceInChunks       (~2772-2900)
//
// Port deviations (all mandated by the server-ingest assignment):
//   1. activity.updateItem(activityId, { detail }) → an optional
//      onProgress?.({ detail }) callback parameter.
//   2. Client streamChat(config, messages, {onToken,onDone,onError}, signal,
//      overrides) → server streamChat(config, messages, {signal, overrides})
//      which RESOLVES with the accumulated text or THROWS. The client's
//      generic "Chunk analysis stream failed" error is thrown ONLY for
//      non-IngestLlmError failures; IngestLlmError propagates untouched so
//      the orchestrator can apply USAGE_LIMIT_BACKOFF_MS via .usageLimit.
//      (The client's onError also set the activity status to error; the
//      server has no activity store, so the throw simply propagates.)
//   3. The `reasoning: { mode: "off" }` override is dropped (the server
//      wire layer has no reasoning knob); temperature/max_tokens are kept
//      exactly.
//   4. throwIfIngestAborted drops the client's activityId argument
//      (write.js server port; abort semantics and message identical).
//   5. clampNumber is a local copy of the client's private helper
//      (ingest.ts ~2464): Math.max(min, Math.min(max, value)).
//
// Everything else — regexes, constants, the chunk loop, checkpoint
// resume semantics, and every message string — is byte-identical to the
// client source.

import { streamChat, IngestLlmError } from "./llm.js"
import {
  buildChunkAnalysisSystemPrompt,
  buildChunkAnalysisUserPrompt,
  trimLongText,
  LONG_SOURCE_CHUNK_MIN,
  LONG_SOURCE_CHUNK_MAX,
  LONG_SOURCE_DIGEST_MAX,
  LONG_SOURCE_CHUNK_ANALYSIS_MAX,
} from "./prompts.js"
import {
  splitSourceIntoSemanticChunks,
  hashTextHex,
  longSourceCheckpointPath,
  loadLongSourceCheckpoint,
  saveLongSourceCheckpoint,
} from "./chunking.js"
import { throwIfIngestAborted } from "./write.js"

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

export function extractMarkedSection(raw, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
  return re.exec(raw)?.[1]?.trim() ?? ""
}

export async function analyzeLongSourceInChunks(
  projectPath,
  llmConfig,
  purpose,
  schema,
  index,
  sourceIdentity,
  sourceSummarySlug,
  folderContext,
  sourceContent,
  sourceBudget,
  signal,
  onProgress,
) {
  const targetChars = clampNumber(Math.floor(sourceBudget * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX)
  const overlapChars = clampNumber(Math.floor(targetChars * 0.08), 800, 3_000)
  const chunks = splitSourceIntoSemanticChunks(sourceContent, targetChars, overlapChars)
  if (chunks.length <= 1) {
    return { chunked: false, analysis: "", sourceContext: sourceContent }
  }

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
  const analyses = checkpoint?.analyses ? [...checkpoint.analyses] : []
  let completedThrough = checkpoint?.completedThrough ?? 0

  if (completedThrough > 0) {
    onProgress?.({
      detail: `Resuming long source analysis from chunk ${completedThrough + 1}/${chunks.length}...`,
    })
  }

  for (const chunk of chunks) {
    if (chunk.index <= completedThrough) continue
    throwIfIngestAborted(signal)
    onProgress?.({
      detail: `Analyzing long source chunk ${chunk.index}/${chunk.total}...`,
    })

    let raw = ""
    let streamError = null
    try {
      raw = await streamChat(
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
        { signal, overrides: { temperature: 0.1, max_tokens: 4096 } },
      )
    } catch (err) {
      streamError = err
    }

    // Client ordering preserved: abort check runs before the stream-error
    // check (a caller-cancel surfaces as "Ingest cancelled", not as a
    // chunk failure).
    throwIfIngestAborted(signal)
    if (streamError) {
      // Usage-limit / timeout errors must reach the orchestrator untouched
      // (usage-limit backoff keys off IngestLlmError.usageLimit).
      if (streamError instanceof IngestLlmError) throw streamError
      throw new Error("Chunk analysis stream failed")
    }

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
