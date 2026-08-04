// Server-driven ingest pipeline (issue #14 P0).
//
// Port of src/lib/ingest.ts autoIngestImpl (~640-1379): the heart of the
// ingest flow. Stage ORDER and every conditional branch mirror the client
// exactly; all logic, regexes, constants, prompt text, and message strings
// are byte-identical. Only types were stripped and the browser/Tauri
// boundary swapped:
//
//   • useActivityStore.addItem/updateItem → env.onProgress(stage, detail)
//     calls (the orchestrator wraps reportIngestProgress from progress.js;
//     the client's detail strings are preserved verbatim as `detail`).
//   • Tauri readFile/writeFile/createDirectory (@/commands/fs) →
//     node:fs/promises with explicit 'utf8'; writes use the
//     writeFileEnsuringDirs pattern (the Rust write_file command creates
//     parent dirs, so this port must too).
//   • client streamChat(config, messages, {onToken,onDone,onError}, signal,
//     overrides) → server streamChat(config, messages, {signal, overrides})
//     from ./llm.js which RESOLVES with the accumulated text or THROWS.
//     IngestLlmError is NEVER wrapped or swallowed on the fatal stages
//     (analysis, generation) — the orchestrator needs .usageLimit for
//     usage-limit backoff. Abort-before-error ordering is preserved via a
//     streamError variable + throwIfIngestAborted before the rethrow (same
//     pattern as long-source.js).
//   • The `reasoning: { mode: "off" }` override is dropped at every call
//     site (the server wire layer has no reasoning knob); the
//     temperature/max_tokens overrides are kept exactly.
//   • useReviewStore.addItems → saveIngestReviewItems (reads the on-disk
//     .llm-wiki/review.json, folds via foldReviewItems, persists atomically).
//   • useWikiStore config reads (mineruConfig/multimodalConfig/
//     embeddingConfig/outputLanguage) → explicit env parameters.
//   • Prompt builders take the finished language directive as their first
//     parameter (prompts.js porting contract): the pipeline resolves it via
//     languageRule(outputLanguage, sourceContext), replacing the builders'
//     internal languageRule(sourceContent) calls.
//   • embedPage is imported statically (the client used a dynamic import()
//     with an "embedding module not available" catch — not possible here).
//
// Client-only bits deliberately DROPPED:
//   • activity store bookkeeping (status done/error, filesWritten list,
//     terminal detail composition) — the orchestrator owns terminal frames
//     (emitIngestComplete / emitIngestError)
//   • refreshProjectFileTree (server has no in-memory file tree)
//   • useReviewStore (replaced by saveIngestReviewItems)
//
// New server behavior:
//   • The zero-output safety net (desktop: ingest-queue.ts processNext
//     `if (writtenFiles.length === 0) throw new Error("Ingest produced no
//     output files")`) lives at the END of this pipeline: an empty
//     writtenPaths throws that exact error so the orchestrator's
//     retry/fail path engages instead of recording a silent success.
//   • Returns { writtenPaths, reviewCount, warnings, cached, durationMs }
//     (durationMs measured across the whole run).

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { runInWorker as runInWorkerDefault } from "../workers/pool.js"
import { streamChat } from "./llm.js"
import {
  normalizePath,
  getFileName,
  uniqueNormalizedPaths,
  filterTruncatedFileRepairOutput,
  buildDeterministicIngestLog,
} from "./parse.js"
import {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildReviewSuggestionPrompt,
  buildTruncatedFileRepairPrompt,
  computeIngestSourceBudget,
  computeIngestGenerationMaxTokens,
  computeIngestReviewMaxTokens,
  languageRule,
} from "./prompts.js"
import { clearLongSourceCheckpoint } from "./chunking.js"
import { throwIfIngestAborted, tryReadFile, writeFileBlocks } from "./write.js"
import { parseReviewBlocks, saveIngestReviewItems } from "./reviews.js"
import { checkIngestCache, saveIngestCache } from "./cache.js"
import { sourceIdentityForPath, sourceSummarySlugFromIdentity } from "./identity.js"
import { parseFrontmatter } from "./frontmatter.js"
import { embedPage } from "./embed.js"
import { parseWithMineruResult } from "./mineru.js"
import {
  extractAndSaveSourceImages,
  extractAndSaveMarkdownImages,
  injectImagesIntoSourceSummary,
  appendSavedImageRefsForCaption,
  imageExtractionKey,
  rememberImageExtractionByKey,
  isSavedImagePromptUrl,
  promptImageUrlToAbs,
  savedImagesFromMineruMarkdown,
  hasMineruImageRefs,
  resolveCaptionConfig,
  applyCaptionGatingToSourceContent,
} from "./images.js"
import { captionMarkdownImages } from "./image-caption.js"
import { analyzeLongSourceInChunks } from "./long-source.js"
import {
  tryReadSourceTextFile,
  appendIngestWarningLog,
  updateWikiIndexDeterministically,
  buildFallbackSourceSummary,
  shouldRunDedicatedReviewStage,
  migrateLegacySourceSummaryIfSafe,
  reembedSourceSummary,
} from "./wiki-upkeep.js"

/** Local byte-identical copy of the client's private helper (ingest.ts ~2621). */
function trimInlineStatus(text, maxChars = 240) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}...`
}

/**
 * node:fs/promises replacement for the Tauri writeFile command (same
 * pattern as write.js / wiki-upkeep.js): the Rust command creates parent
 * directories before writing, so this helper must too.
 */
async function writeFileEnsuringDirs(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, "utf8")
}

/**
 * Resolve the queued file_path to an absolute, normalized source path.
 * The desktop queue runner resolves the path before calling autoIngest;
 * the server queue stores either project-relative paths ("raw/sources/…"
 * — desktop enqueue parity) or absolute paths (the v2 upload route), so
 * both shapes are accepted here.
 */
function resolveSourcePath(projectPath, filePath) {
  const normalized = normalizePath(String(filePath ?? ""))
  const isAbsolute = /^\//.test(normalized) || /^[a-zA-Z]:\//.test(normalized)
  return isAbsolute ? normalized : `${projectPath}/${normalized}`
}

/**
 * Run the full ingest pipeline for one ingest_queue row.
 *
 * @param {object} task  ingest_queue row ({ id, project_id, file_path,
 *   folder_context, attempt_count, … })
 * @param {object} env
 * @param {string} env.projectPath
 * @param {object} env.llmConfig
 * @param {object} [env.mineruConfig]      defaults to { enabled: false }
 * @param {object} [env.multimodalConfig]  defaults to { enabled: false }
 * @param {object} [env.embeddingConfig]   defaults to { enabled: false }
 * @param {string} [env.outputLanguage]    defaults to "auto"
 * @param {AbortSignal} [env.signal]
 * @param {(stage: string, detail: string) => void} [env.onProgress]
 *   orchestrator-provided; wraps reportIngestProgress. Stage names come
 *   from progress.js INGEST_STAGES and are reported in that order.
 * @param {(relativePath: string) => void} [env.onFileWritten] optional
 *   pass-through kept for parity with the desktop callback (not used by
 *   the orchestrator today).
 * @param {object} [deps]  test injection points
 * @param {Function} [deps.runInWorker]    defaults to workers/pool.js
 * @param {Function} [deps.readSourceText] defaults to
 *   wiki-upkeep.js tryReadSourceTextFile (wired to deps.runInWorker)
 * @returns {Promise<{writtenPaths: string[], reviewCount: number,
 *   warnings: string[], cached: boolean, durationMs: number}>}
 * @throws on fatal errors; throws `Error("Ingest produced no output files")`
 *   when the run finishes with zero written paths (zero-output safety net).
 */
export async function runIngestPipeline(task, env, deps = {}) {
  const startedAt = Date.now()
  const runInWorkerImpl = deps.runInWorker ?? runInWorkerDefault
  const readSourceTextImpl = deps.readSourceText
    ?? ((sourcePath) => tryReadSourceTextFile(sourcePath, { runInWorker: runInWorkerImpl }))

  const pp = normalizePath(env.projectPath)
  const sp = resolveSourcePath(pp, task.file_path)
  const folderContext = task.folder_context || undefined
  const llmConfig = env.llmConfig
  const mineruCfg = env.mineruConfig ?? { enabled: false }
  const mmCfg = env.multimodalConfig ?? { enabled: false }
  const embCfg = env.embeddingConfig ?? { enabled: false }
  const outputLanguage = env.outputLanguage ?? "auto"
  const signal = env.signal
  const onProgress = env.onProgress ?? (() => {})
  const onFileWritten = env.onFileWritten

  const fileName = getFileName(sp)
  const sourceIdentity = sourceIdentityForPath(pp, sp)
  const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
  console.log(`[ingest:diag] autoIngestImpl ENTRY for "${fileName}" (project="${pp}", source="${sp}")`)

  onProgress("preprocess", "Reading source...")

  // ── MinerU preprocessing for PDF files ──
  const lowerExt = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : ""
  const isPdf = lowerExt === "pdf"
  let mineruSucceeded = false
  let mineruSavedImages = []
  const mineruConfigured = mineruCfg.backend === "local" || Boolean(mineruCfg.token)
  if (isPdf && mineruCfg.enabled && mineruConfigured) {
    try {
      const cacheDir = sp.substring(0, sp.lastIndexOf("/"))
      const cachePath = `${cacheDir}/.cache/${fileName}.txt`
      onProgress("mineru", "MinerU: parsing PDF...")
      console.log(`[ingest:mineru] submitting "${fileName}" to MinerU API`)
      const mineruResult = await parseWithMineruResult(mineruCfg, sp, undefined, (msg) => {
        onProgress("mineru", `MinerU: ${msg}`)
      }, signal, {
        projectPath: pp,
        sourceSummarySlug,
      })
      await mkdir(`${cacheDir}/.cache`, { recursive: true })
      await writeFile(cachePath, mineruResult.markdown, "utf8")
      mineruSavedImages = mineruResult.savedImages
      if (mineruSavedImages.length > 0) {
        const extractionKey = await imageExtractionKey(pp, sp, sourceSummarySlug)
        rememberImageExtractionByKey(extractionKey, Promise.resolve(mineruSavedImages))
      }
      mineruSucceeded = true
      console.log(
        `[ingest:mineru] cached MinerU output for "${fileName}" (${mineruResult.markdown.length} chars, images=${mineruSavedImages.length})`,
      )
    } catch (err) {
      throwIfIngestAborted(signal)
      const msg = trimInlineStatus(err instanceof Error ? err.message : String(err))
      console.warn(`[ingest:mineru] MinerU parsing failed, falling back to pdfium: ${msg}`)
      onProgress("mineru", `MinerU failed, falling back to built-in PDF extraction: ${msg}`)
    }
    if (mineruSucceeded && !signal?.aborted) {
      onProgress("context", "Reading source...")
    }
  }

  onProgress("context", "Reading source...")
  const [sourceContent, schema, purpose, index, overview] = await Promise.all([
    readSourceTextImpl(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])
  if (isPdf && mineruSavedImages.length === 0 && hasMineruImageRefs(sourceContent, sourceSummarySlug)) {
    mineruSavedImages = await savedImagesFromMineruMarkdown(pp, sourceSummarySlug, sourceContent)
    if (mineruSavedImages.length > 0) {
      const extractionKey = await imageExtractionKey(pp, sp, sourceSummarySlug)
      rememberImageExtractionByKey(extractionKey, Promise.resolve(mineruSavedImages))
    }
  }

  // ── Cache check: skip re-ingest if source content hasn't changed ──
  //
  // Image cascade still runs on cache hits. Reason: a user may have
  // ingested this source on a previous app version that didn't extract
  // images yet, or the media dir may have been deleted out from under
  // us. `extractAndSaveSourceImages` + injection are both idempotent
  // (deterministic output paths, marker-bracketed replacement), so
  // re-running them costs only the extraction time and converges the
  // source-summary page on the current pipeline's contract regardless
  // of when the file was first ingested.
  onProgress("cache-check", "")
  const cachedFiles = await checkIngestCache(pp, sourceIdentity, sourceContent)
  console.log(`[ingest:diag] cache check for "${sourceIdentity}":`, cachedFiles === null ? "MISS (full pipeline)" : `HIT (${cachedFiles.length} cached files)`)
  if (cachedFiles !== null) {
    // Client terminal detail for the cache-hit path (activity status
    // "done"); reported up front so the stage sequence stays monotonic
    // while the non-fatal image cascade below runs.
    onProgress("cache-check", `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`)
    try {
      console.log(`[ingest:diag] cache-hit branch: starting image extraction for ${sp}`)
      onProgress("images", "")
      const skipNativePdfImageExtraction = isPdf && hasMineruImageRefs(sourceContent, sourceSummarySlug)
      let savedImages = skipNativePdfImageExtraction
        ? mineruSavedImages
        : await extractAndSaveSourceImages(pp, sp, sourceSummarySlug)
      const markdownImages = await extractAndSaveMarkdownImages(pp, sp, sourceContent, sourceSummarySlug)
      savedImages = [...savedImages, ...markdownImages]
      console.log(`[ingest:diag] cache-hit branch: got ${savedImages.length} image(s)`)
      if (savedImages.length > 0) {
        // Caption first (populates the cache), THEN inject — the
        // safety-net section uses the cache to populate alt text.
        // Doing them in this order means cache-hit re-runs (e.g.
        // user re-imports an old PDF after captioning was added)
        // converge: first run grows the cache, second run uses it.
        //
        // Master-toggle gate: when multimodal is OFF the entire
        // image-cascade is skipped here. This matches the
        // full-pipeline branch's strip-and-skip behavior for the
        // cache-hit path, so a user re-importing an old file
        // after disabling captioning sees images disappear from
        // the wiki side. (If a previous ingest had already written
        // a `## Embedded Images` block, it stays — re-import
        // doesn't proactively scrub old wiki content. The user
        // would need to delete the wiki/sources/<slug>.md page
        // to start clean.)
        if (!mmCfg.enabled) {
          console.log(
            `[ingest:caption] cache-hit + disabled — skipping caption + safety-net inject (${savedImages.length} image(s) untouched on disk)`,
          )
        } else {
          onProgress("caption", "")
          const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
          if (captionLlm) {
            try {
              await captionMarkdownImages(pp, appendSavedImageRefsForCaption(sourceContent, savedImages), captionLlm, {
                signal,
                shouldCaption: (url) =>
                  isSavedImagePromptUrl(pp, sourceSummarySlug, url),
                urlToAbsPath: (url) => promptImageUrlToAbs(pp, url),
                concurrency: mmCfg.concurrency,
                onProgress: (done, total) =>
                  onProgress("caption", `Captioning images... ${done}/${total}`),
              })
            } catch (err) {
              console.warn(
                `[ingest:caption] cache-hit caption pass failed:`,
                err instanceof Error ? err.message : err,
              )
            }
          }
          await injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages)
          // Re-embed the source-summary page so caption text lands
          // in the search index. Without this step, search by image
          // content stays empty for files ingested before captioning
          // was added — the safety-net section was just rewritten
          // with captions, but the embeddings still reflect the old
          // empty-alt content.
          await reembedSourceSummary(pp, sourceIdentity, sourceSummarySlug, embCfg)
        }
      } else {
        console.log(`[ingest:diag] cache-hit branch: skipping injection (no images returned from extraction)`)
      }
    } catch (err) {
      console.warn(
        `[ingest:images] cache-hit injection failed for "${fileName}":`,
        err instanceof Error ? err.message : err,
      )
    }
    return {
      writtenPaths: cachedFiles,
      reviewCount: 0,
      warnings: [],
      cached: true,
      durationMs: Date.now() - startedAt,
    }
  }

  // ── Step 0.5: Extract embedded images ─────────────────────────
  // Pulls every embedded image out of PDF / PPTX / DOCX into
  // `wiki/media/<source-slug>/`. We DON'T inject the markdown
  // references into sourceContent here — without VLM captions
  // (Phase 3a) the alt text is empty, which gives the LLM no
  // semantic signal to preserve them. The LLM tends to silently
  // strip empty-alt images when summarizing.
  //
  // Instead, the markdown section is appended to the source-summary
  // page on disk AFTER writeFileBlocks (see Step 5b below). That
  // guarantees images appear in `wiki/sources/<slug>.md` regardless
  // of LLM behavior. Once Phase 3a lands, we'll re-introduce the
  // sourceContent injection because the captioned alt-text gives
  // the LLM something meaningful to work with.
  //
  // Failure here is never fatal — extractAndSaveSourceImages logs
  // and returns [] on any error.
  onProgress("images", "Extracting embedded images...")
  console.log(`[ingest:diag] full-pipeline branch: starting image extraction for ${sp}`)
  const skipNativePdfImageExtraction = isPdf && (
    hasMineruImageRefs(sourceContent, sourceSummarySlug)
  )
  let savedImages = skipNativePdfImageExtraction
    ? mineruSavedImages
    : await extractAndSaveSourceImages(pp, sp, sourceSummarySlug)
  const markdownImages = await extractAndSaveMarkdownImages(pp, sp, sourceContent, sourceSummarySlug)
  savedImages = [...savedImages, ...markdownImages]
  console.log(`[ingest:diag] full-pipeline branch: got ${savedImages.length} image(s)`)
  if (savedImages.length > 0) {
    console.log(
      `[ingest:images] saved ${savedImages.length} image(s) for "${sourceIdentity}" → wiki/media/${sourceSummarySlug}/`,
    )
  }

  // ── Step 0.6: Caption embedded images ─────────────────────────
  // Now that read_file's combined extraction has put `![](abs_path)`
  // markers inline in `sourceContent`, walk them and replace the
  // empty alt text with a vision-model-generated factual caption.
  // SHA-256-keyed cache (`<project>/.llm-wiki/image-caption-cache.json`)
  // dedupes across runs and across documents (shared logos / chart
  // templates caption once, not once per document).
  //
  // Why this matters: an empty-alt image gets paraphrased away by
  // text summarization. With a caption, the alt text carries enough
  // semantic load that the generation LLM tends to preserve the
  // image reference inline at the right paragraph.
  //
  // Scope: we only caption images whose absolute path lives under
  // <project>/wiki/media/<source-slug>/ — i.e. images the current
  // ingest produced. User-typed external URLs in markdown source
  // documents are passed through untouched.
  //
  // Master-toggle behavior: when `multimodalConfig.enabled` is
  // false, we don't just skip the caption LLM call — we ALSO
  // strip `![](url)` references from sourceContent before the LLM
  // sees it, AND skip the post-write safety-net injection further
  // down. Net effect: the wiki-side pipeline never references
  // images at all. Without the strip + skip, image references
  // would leak via two paths:
  //   1. The LLM-generation prompt sees them in sourceContent and
  //      can preserve them in the generated wiki pages
  //   2. injectImagesIntoSourceSummary unconditionally appends a
  //      `## Embedded Images` section to wiki/sources/<slug>.md
  // Both paths land image refs into wiki pages, which then get
  // embedded → searchable → visible in the search image grid even
  // though the user disabled captioning. This was the user-
  // surprising behavior that prompted the fix.
  //
  // Rust extraction itself is untouched: images still land on disk
  // under wiki/media/<slug>/ (cheap), and the raw-source preview
  // (which renders read_file output directly) still shows them —
  // that surface is "the source document as-is", separate from
  // "the curated wiki knowledge".
  onProgress("caption", "")
  const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
  const enrichedSourceContent = await applyCaptionGatingToSourceContent(
    pp,
    sourceContent,
    savedImages,
    sourceSummarySlug,
    mmCfg,
    captionLlm,
    {
      signal,
      fileName,
      onStatus: (detail) => onProgress("caption", detail),
      onProgress: (done, total) => onProgress("caption", `Captioning images... ${done}/${total}`),
    },
  )

  const stableContextLength = schema.length + purpose.length + index.length + overview.length
  const sourceBudget = computeIngestSourceBudget(llmConfig.maxContextSize, stableContextLength)
  let sourceContext = enrichedSourceContent
  let precomputedAnalysis = ""
  let longSourceCheckpointPath

  if (enrichedSourceContent.length > sourceBudget) {
    onProgress("analysis", "Analyzing source...")
    const longSourcePlan = await analyzeLongSourceInChunks(
      pp,
      llmConfig,
      purpose,
      schema,
      index,
      sourceIdentity,
      sourceSummarySlug,
      folderContext,
      enrichedSourceContent,
      sourceBudget,
      signal,
      ({ detail }) => onProgress("analysis", detail),
    )
    if (longSourcePlan.chunked) {
      sourceContext = longSourcePlan.sourceContext
      precomputedAnalysis = longSourcePlan.analysis
      longSourceCheckpointPath = longSourcePlan.checkpointPath
    }
  }

  // Prompt builders' internal languageRule(sourceContent) calls resolve
  // against the FINAL sourceContext (post long-source adoption); every
  // builder below sees the same directive.
  const languageDirective = languageRule(outputLanguage, sourceContext)

  // ── Step 1: Analysis ──────────────────────────────────────────
  // LLM reads the source and produces a structured analysis:
  // key entities, concepts, main arguments, connections to existing wiki, contradictions
  onProgress(
    "analysis",
    precomputedAnalysis
      ? "Step 1/2: Consolidating long-source analysis..."
      : "Step 1/2: Analyzing source...",
  )

  let analysis = precomputedAnalysis

  if (!analysis) {
    let streamError = null
    try {
      analysis = await streamChat(
        llmConfig,
        [
          { role: "system", content: buildAnalysisPrompt(languageDirective, purpose, index, schema) },
          { role: "user", content: `Analyze this source document:\n\n**File:** ${sourceIdentity}${folderContext ? `\n**Folder context:** ${folderContext}` : ""}\n\n---\n\n${sourceContext}` },
        ],
        { signal, overrides: { temperature: 0.1, max_tokens: 4096 } },
      )
    } catch (err) {
      streamError = err
    }
    // Client ordering preserved: abort check runs before the stream-error
    // rethrow (a caller-cancel surfaces as "Ingest cancelled").
    throwIfIngestAborted(signal)
    // IngestLlmError (usage-limit / timeout) propagates untouched so the
    // orchestrator can apply USAGE_LIMIT_BACKOFF_MS via .usageLimit.
    if (streamError) throw streamError
  }

  // ── Step 2: Generation ────────────────────────────────────────
  // LLM takes the analysis as context and produces wiki files + review items
  onProgress("generation", "Step 2/2: Generating wiki pages...")

  let generation = ""

  let generationError = null
  try {
    generation = await streamChat(
      llmConfig,
      [
        { role: "system", content: buildGenerationPrompt(languageDirective, schema, purpose, index, sourceIdentity, overview, sourceSummaryPath) },
        {
          role: "user",
          content: [
            `Source document to process: **${sourceIdentity}**`,
            "",
            "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
            "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
            "blocks as specified in the system prompt — nothing else.",
            "",
            "## Stage 1 Analysis (context only — do not repeat)",
            "",
            analysis,
            "",
            "## Source Context",
            "",
            sourceContext,
            "",
            "---",
            "",
            `Now emit the FILE blocks for the wiki files derived from **${sourceIdentity}**.`,
            "Your response MUST begin with `---FILE:` as the very first characters.",
            "No preamble. No analysis prose. Start immediately.",
          ].join("\n"),
        },
      ],
      {
        signal,
        overrides: {
          temperature: 0.1,
          max_tokens: computeIngestGenerationMaxTokens(llmConfig.maxContextSize),
        },
      },
    )
  } catch (err) {
    generationError = err
  }
  throwIfIngestAborted(signal)
  if (generationError) throw generationError
  throwIfIngestAborted(signal)

  let reviewSuggestionOutput = ""
  if (!signal?.aborted && shouldRunDedicatedReviewStage(generation)) {
    onProgress("review-stage", "")
    let reviewStageHadError = false
    try {
      reviewSuggestionOutput = await streamChat(
        llmConfig,
        [
          {
            role: "system",
            content: buildReviewSuggestionPrompt(
              languageDirective,
              purpose,
              index,
              sourceIdentity,
              analysis,
              sourceContext,
              generation,
              llmConfig.maxContextSize,
            ),
          },
          {
            role: "user",
            content: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none.",
          },
        ],
        {
          signal,
          overrides: {
            temperature: 0.1,
            max_tokens: computeIngestReviewMaxTokens(llmConfig.maxContextSize),
          },
        },
      )
    } catch (err) {
      throwIfIngestAborted(signal)
      // Never fatal (client parity: onError/catch both only warned) —
      // the generation output is already in hand.
      reviewStageHadError = true
      console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}":`, err)
    }
    throwIfIngestAborted(signal)
    if (reviewStageHadError) reviewSuggestionOutput = ""
  }

  // ── Step 3: Write files ───────────────────────────────────────
  throwIfIngestAborted(signal)
  onProgress("write", "Writing files...")
  await migrateLegacySourceSummaryIfSafe(pp, sourceIdentity, sourceSummaryPath)
  const writeResult = await writeFileBlocks(
    pp,
    generation,
    llmConfig,
    outputLanguage,
    sourceIdentity,
    sourceSummaryPath,
    signal,
    onFileWritten,
  )
  throwIfIngestAborted(signal)
  const writtenPaths = writeResult.writtenPaths
  const writeWarnings = writeResult.warnings
  const hardFailures = writeResult.hardFailures
  let unrecoveredTruncatedPaths = uniqueNormalizedPaths(
    writeResult.truncatedPaths.filter((path) =>
      !writtenPaths.some((writtenPath) => normalizePath(writtenPath) === normalizePath(path))
    ),
  )

  if (unrecoveredTruncatedPaths.length > 0 && !signal?.aborted) {
    onProgress("write", `Retrying truncated wiki files: ${unrecoveredTruncatedPaths.join(", ")}`)
    let repairOutput = ""
    try {
      let repairStreamError = null
      try {
        repairOutput = await streamChat(
          llmConfig,
          [
            {
              role: "system",
              content: buildTruncatedFileRepairPrompt(
                languageDirective,
                unrecoveredTruncatedPaths,
                sourceIdentity,
                {
                  schema,
                  purpose,
                  analysis,
                  sourceContext,
                  maxContextSize: llmConfig.maxContextSize,
                },
              ),
            },
            {
              role: "user",
              content: "Regenerate the requested FILE blocks now. Start immediately with `---FILE:`.",
            },
          ],
          {
            signal,
            overrides: {
              temperature: 0.1,
              // A repair must regenerate the complete FILE body. Reusing the
              // smaller review budget can immediately truncate the same long page
              // that exhausted the original response.
              max_tokens: computeIngestGenerationMaxTokens(llmConfig.maxContextSize),
            },
          },
        )
      } catch (err) {
        repairStreamError = err
      }
      throwIfIngestAborted(signal)
      // Non-fatal stage (client parity): a stream failure becomes a
      // warning via the outer catch below.
      if (repairStreamError) throw repairStreamError

      if (repairOutput.trim()) {
        const filteredRepair = filterTruncatedFileRepairOutput(
          repairOutput,
          unrecoveredTruncatedPaths,
        )
        writeWarnings.push(...filteredRepair.warnings)
        const repairResult = await writeFileBlocks(
          pp,
          filteredRepair.text,
          llmConfig,
          outputLanguage,
          sourceIdentity,
          sourceSummaryPath,
          signal,
          onFileWritten,
        )
        // Match successful writes against the paths requested from the model,
        // not the final on-disk paths. writeFileBlocks may legitimately rewrite
        // a title-derived filename for the selected output language.
        const completedInputPathKeys = new Set(
          repairResult.completedInputPaths.map(normalizePath),
        )
        const recoveredPaths = filteredRepair.paths.filter((path) =>
          completedInputPathKeys.has(normalizePath(path)),
        )
        for (const path of repairResult.writtenPaths) {
          if (!writtenPaths.some((writtenPath) => normalizePath(writtenPath) === normalizePath(path))) {
            writtenPaths.push(path)
          }
        }
        for (const path of recoveredPaths) {
          const warningPrefix = `FILE block "${path}" was not closed before end of stream`
          for (let i = writeWarnings.length - 1; i >= 0; i--) {
            if (writeWarnings[i].startsWith(warningPrefix)) writeWarnings.splice(i, 1)
          }
        }
        writeWarnings.push(...repairResult.warnings)
        hardFailures.push(...repairResult.hardFailures)
        const recoveredPathKeys = new Set(recoveredPaths.map(normalizePath))
        unrecoveredTruncatedPaths = unrecoveredTruncatedPaths.filter((path) =>
          !recoveredPathKeys.has(normalizePath(path))
        )
      }
    } catch (err) {
      throwIfIngestAborted(signal)
      writeWarnings.push(
        `Truncated FILE repair failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  onProgress("index-log", "")
  try {
    if (await updateWikiIndexDeterministically(pp, writtenPaths)) {
      writtenPaths.push("wiki/index.md")
      onFileWritten?.("wiki/index.md")
    }
  } catch (err) {
    writeWarnings.push(
      `Deterministic index update failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // log.md is append-only structural metadata. If the model omitted its FILE
  // block, write a deterministic entry instead of starting another LLM turn.
  // This keeps multi-file imports at two generation stages per source and
  // prevents a slow provider from making the queue appear stuck in "repair".
  if (!writtenPaths.some((path) => normalizePath(path).toLowerCase() === "wiki/log.md") && !signal?.aborted) {
    try {
      const logPath = `${pp}/wiki/log.md`
      const existingLog = await tryReadFile(logPath)
      await writeFileEnsuringDirs(logPath, buildDeterministicIngestLog(existingLog, sourceIdentity))
      writtenPaths.push("wiki/log.md")
      onFileWritten?.("wiki/log.md")
    } catch (err) {
      writeWarnings.push(
        `Deterministic log update failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Surface parser / writer warnings so users don't have to open devtools
  // to find out a block was dropped; full list is also persisted to
  // .llm-wiki.
  let warningSummary = ""
  if (writeWarnings.length > 0) {
    await appendIngestWarningLog(pp, sourceIdentity, writeWarnings)
    warningSummary = writeWarnings.length === 1
      ? writeWarnings[0]
      : `${writeWarnings.length} ingest warnings: ${writeWarnings.slice(0, 2).join(" · ")}${writeWarnings.length > 2 ? ` … (+${writeWarnings.length - 2} more in .llm-wiki/ingest-warnings.log)` : ""}`
    onProgress("index-log", `${warningSummary} — saved to .llm-wiki/ingest-warnings.log`)
  }

  // Ensure source summary page exists (LLM may not have generated it correctly)
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  const hasSourceSummary = writtenPaths.some((p) => normalizePath(p) === sourceSummaryPath)

  // If the signal was aborted (e.g. user switched projects / cancelled),
  // skip the fallback summary write — the LLM streams returned empty
  // via the abort fast-path (onDone), and writing a stub file into the
  // old project's wiki would both be noise and mask the error.
  // Returning no files lets the queue runner's length-0 safety net mark
  // the task for retry rather than "success".
  if (!hasSourceSummary && !signal?.aborted) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = buildFallbackSourceSummary(sourceIdentity, analysis, date)
    try {
      await writeFileEnsuringDirs(sourceSummaryFullPath, fallbackContent)
      writtenPaths.push(sourceSummaryPath)
      onFileWritten?.(sourceSummaryPath)
    } catch {
      // non-critical
    }
  }

  // ── Step 3.5: Append extracted images to the source-summary page ─
  // Skipped when the master toggle is off — see Step 0.6 above for
  // the full rationale. With captioning disabled we also don't
  // want the safety-net section to slip image refs into the wiki
  // through the back door.
  if (mmCfg.enabled && savedImages.length > 0 && !signal?.aborted) {
    await injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages)
  }

  // ── Step 4: Parse review items ────────────────────────────────
  onProgress("reviews", "")
  throwIfIngestAborted(signal)
  const reviewItems = [
    ...parseReviewBlocks(generation, sp),
    ...parseReviewBlocks(reviewSuggestionOutput, sp),
  ]
  if (reviewItems.length > 0) {
    // Server replacement for useReviewStore.getState().addItems: fold with
    // the on-disk .llm-wiki/review.json items and persist atomically.
    await saveIngestReviewItems(pp, reviewItems)
  }

  // ── Step 5: Save to cache ───────────────────────────────────
  // Skip cache when a write fails or a truncated path remains unrecovered;
  // otherwise the partial result would be replayed without another LLM turn.
  onProgress("cache-save", "")
  if (
    writtenPaths.length > 0 &&
    hardFailures.length === 0 &&
    unrecoveredTruncatedPaths.length === 0
  ) {
    await saveIngestCache(pp, sourceIdentity, sourceContent, writtenPaths)
    if (longSourceCheckpointPath) {
      await clearLongSourceCheckpoint(longSourceCheckpointPath)
    }
  } else if (hardFailures.length > 0 || unrecoveredTruncatedPaths.length > 0) {
    console.warn(
      `[ingest] Skipping cache save for "${sourceIdentity}" — ${hardFailures.length} write failure(s), ${unrecoveredTruncatedPaths.length} truncated FILE block(s) still missing.`,
    )
  }

  // ── Step 6: Generate embeddings (if enabled) ───────────────
  onProgress("embed", "")
  if (embCfg.enabled && embCfg.model && writtenPaths.length > 0) {
    for (const wpath of writtenPaths) {
      const pageId = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
      if (!pageId || ["index", "log", "overview"].includes(pageId)) continue
      try {
        const content = await readFile(`${pp}/${wpath}`, "utf8")
        const fmTitle = parseFrontmatter(content).frontmatter?.title
        const title = typeof fmTitle === "string" && fmTitle.trim() ? fmTitle.trim() : pageId
        await embedPage(pp, pageId, title, content, embCfg)
      } catch {
        // non-critical
      }
    }
  }

  // Zero-output safety net (desktop: ingest-queue.ts processNext). A silent
  // empty result would look like success to the queue runner; throwing makes
  // the orchestrator's retry / mark-failed path engage.
  if (writtenPaths.length === 0) {
    throw new Error("Ingest produced no output files")
  }

  return {
    writtenPaths,
    reviewCount: reviewItems.length,
    warnings: writeWarnings,
    cached: false,
    durationMs: Date.now() - startedAt,
  }
}
