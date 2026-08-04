// Server port of the write stage of src/lib/ingest.ts for the
// server-driven ingest pipeline (issue #14 P0).
//
// Ported functions (client line references from src/lib/ingest.ts):
//   - writeFileBlocks                            (~1788-1978)
//   - isOwnedOnlyBySource                        (~1980-1987)
//   - tryReadFile                                (~2448)
//   - throwIfIngestAborted                       (~585)
//   - backupExistingPage                         (~2994)
//   - extractGeneratedPageTitle                  (~1439)
//   - rewriteIngestPathFromTitleForTargetLanguage (~1446)
//   - buildPageMerger                            (~2908)
// plus their helpers (isLogPath, isListingPath,
// contentMatchesTargetLanguage, CJK_OUTPUT_LANGUAGES, containsCjk).
// writeFileEnsuringDirs / isLogPath / isListingPath are exported for the
// chat "Write to Wiki" route (api/chat.js — executeIngestWrites port).
//
// Port deviations (all mandated by the server-ingest assignment):
//   1. useWikiStore.getState().outputLanguage → an explicit
//      `outputLanguage` parameter on writeFileBlocks (placed right
//      after llmConfig; the rest of the client signature order is
//      preserved).
//   2. throwIfIngestAborted drops the activity-store plumbing (there
//      is no Zustand store on the server). The abort semantics and
//      the "Ingest cancelled" error message are byte-identical. The
//      now-unused `activityId` parameter was removed from both
//      throwIfIngestAborted and writeFileBlocks.
//   3. writeFileBlocks accepts an OPTIONAL final options object
//      `{ merger }` that overrides buildPageMerger (test seam).
//   4. Tauri readFile/writeFile (@/commands/fs) → node:fs/promises
//      with explicit 'utf8' encoding. The Rust write_file command
//      creates parent directories (fs::create_dir_all) before
//      writing, so writeFileEnsuringDirs below replicates that.
//   5. buildPageMerger calls the server streamChat from ./llm.js,
//      which is async and resolves with the accumulated text. The
//      messages and overrides ({ temperature: 0.1 }) are identical
//      to the client call.
//
// Everything else — every regex, constant, threshold, log/warning
// message string, and the per-block pipeline order — is byte-identical
// to the client source.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import {
  parseFileBlocks,
  isSafeIngestPath,
  isAppManagedAggregatePath,
  sourceSummaryMediaRefsForExternalMarkdown,
  currentWikiDate,
  stampGeneratedFrontmatterDates,
  stampGeneratedLogDate,
  canonicalizeSourcesField,
} from "./parse.js"
import { sanitizeIngestedFileContent } from "./sanitize.js"
import {
  loadProjectWikiSchemaRouting,
  validateWikiPageRouting,
} from "./wiki-schema.js"
import { makeQuerySlug } from "./wiki-filename.js"
import { detectLanguage, sameScriptFamily } from "./language.js"
import { parseSources } from "./sources-merge.js"
import { sourceReferenceIdentity } from "./identity.js"
import { parseFrontmatter } from "./frontmatter.js"
import { mergePageContent } from "./page-merge.js"
import { buildPageMergeSystemPrompt } from "./prompts.js"
import { streamChat } from "./llm.js"

export function throwIfIngestAborted(signal) {
  if (!signal?.aborted) return
  throw new Error("Ingest cancelled")
}

/**
 * node:fs/promises replacement for the Tauri writeFile command. The
 * Rust command creates parent directories before writing
 * (fs::create_dir_all in src-tauri/src/commands/fs.rs::write_file),
 * so this helper must too.
 *
 * Exported for the chat "Write to Wiki" route (api/chat.js), which does
 * the client's NAIVE per-block writes (executeIngestWrites port) instead
 * of going through writeFileBlocks.
 */
export async function writeFileEnsuringDirs(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, "utf8")
}

export async function tryReadFile(path) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}

/**
 * Per-file language guard. Strips frontmatter + code/math blocks, runs
 * detectLanguage on the remainder, and returns whether the content is in
 * a language family compatible with the target. This catches cases where
 * the LLM follows the format spec but writes a single page in a wrong
 * language (observed ~once in 5 real-LLM runs on MiniMax-M2.7-highspeed).
 */
function contentMatchesTargetLanguage(content, target) {
  // Strip frontmatter
  const fmEnd = content.indexOf("\n---\n", 3)
  let body = fmEnd > 0 ? content.slice(fmEnd + 5) : content
  // Strip code + math
  body = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$\n]*\$/g, "")
  const sample = body.slice(0, 1500)
  if (sample.trim().length < 20) return true // too short to judge

  const detected = detectLanguage(sample)

  // Compatible families: CJK targets accept CJK variants; Latin targets
  // accept any Latin family (English may mis-detect as Italian/French for
  // short idiomatic samples — that's fine). Cross-family is the real bug.
  const cjk = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean"])
  const distinctNonLatin = new Set(["Arabic", "Persian", "Hindi", "Thai", "Hebrew"])
  const targetIsCjk = cjk.has(target)
  const detectedIsCjk = cjk.has(detected)
  if (targetIsCjk) return detectedIsCjk
  if (distinctNonLatin.has(target)) return detected === target
  if (distinctNonLatin.has(detected)) return sameScriptFamily(target, detected)
  return !detectedIsCjk
}

// Exported for the chat "Write to Wiki" route (api/chat.js), which needs
// the log/listing distinctions for the client's naive write semantics.
export function isLogPath(relativePath) {
  return relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")
}

export function isListingPath(relativePath) {
  return (
    relativePath === "wiki/index.md" ||
    relativePath.endsWith("/index.md") ||
    relativePath === "wiki/overview.md" ||
    relativePath.endsWith("/overview.md")
  )
}

const CJK_OUTPUT_LANGUAGES = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean"])

function containsCjk(text) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text)
}

export function extractGeneratedPageTitle(content) {
  const title = parseFrontmatter(content).frontmatter?.title
  if (typeof title === "string" && title.trim()) return title.trim()
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || null
}

export function rewriteIngestPathFromTitleForTargetLanguage(
  relativePath,
  content,
  targetLang,
) {
  if (!targetLang || targetLang === "auto" || !CJK_OUTPUT_LANGUAGES.has(targetLang)) {
    return relativePath
  }
  if (
    isLogPath(relativePath) ||
    isListingPath(relativePath) ||
    relativePath.startsWith("wiki/sources/")
  ) {
    return relativePath
  }
  const title = extractGeneratedPageTitle(content)
  if (!title || !containsCjk(title)) return relativePath

  const slash = relativePath.lastIndexOf("/")
  const dir = slash >= 0 ? relativePath.slice(0, slash + 1) : ""
  const fileName = slash >= 0 ? relativePath.slice(slash + 1) : relativePath
  if (containsCjk(fileName)) return relativePath

  const slug = makeQuerySlug(title)
  if (!containsCjk(slug)) return relativePath
  const nextPath = `${dir}${slug}.md`
  return isSafeIngestPath(nextPath) ? nextPath : relativePath
}

/**
 * Build a MergeFn for a given LLM config. The returned function asks
 * the model to merge two versions of the same wiki page into one.
 * Page-merge.js handles all the sanity-checking and fallback paths;
 * this is just the "stream the LLM" wrapper.
 *
 * PORT NOTE: the server streamChat (./llm.js) is async and resolves
 * with the accumulated text, so the client's
 * onToken/onDone/onError-to-Promise plumbing collapses into a direct
 * await. Messages and overrides are identical to the client call.
 */
export function buildPageMerger(llmConfig) {
  return async (existingContent, incomingContent, sourceFileName, signal) => {
    const systemPrompt = buildPageMergeSystemPrompt()

    const userMessage = [
      `## Existing version on disk`,
      "",
      existingContent,
      "",
      "---",
      "",
      `## Newly generated version (from ${sourceFileName})`,
      "",
      incomingContent,
      "",
      "---",
      "",
      "Now output the merged file. Start with `---` on the first line.",
    ].join("\n")

    return streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { signal, overrides: { temperature: 0.1 } },
    )
  }
}

/**
 * Best-effort snapshot of a page before a fallback merge overwrites
 * it. Saved to `.llm-wiki/page-history/<sanitized-path>-<timestamp>.md`
 * so a user who later notices content lost in a merge can recover it.
 * Errors are swallowed by the caller (page-merge's tryBackup).
 */
export async function backupExistingPage(
  projectPath,
  relativePath,
  existingContent,
) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sanitized = relativePath.replace(/[/\\]/g, "_")
  const backupPath = `${projectPath}/.llm-wiki/page-history/${sanitized}-${stamp}`
  await writeFileEnsuringDirs(backupPath, existingContent)
}

export function isOwnedOnlyBySource(content, sourceIdentity) {
  const sources = parseSources(content)
  if (sources.length === 0) return false
  const expected = sourceReferenceIdentity(sourceIdentity).toLowerCase()
  return sources.every(
    (source) => sourceReferenceIdentity(source).toLowerCase() === expected,
  )
}

/**
 * Parse the LLM's stage-2 output into FILE blocks and write each one to
 * disk under the project's wiki/ tree.
 *
 * PORT signature: `outputLanguage` is an explicit parameter (the client
 * reads useWikiStore.getState().outputLanguage); it sits right after
 * llmConfig, the rest of the client parameter order is preserved, minus
 * the dropped activityId. The optional final `options` object may carry
 * `{ merger }` to override buildPageMerger (test seam).
 *
 * @param {string} projectPath
 * @param {string} text stage-2 LLM output with FILE blocks
 * @param {object} llmConfig
 * @param {string|undefined} outputLanguage
 * @param {string} sourceFileName
 * @param {string} [sourceSummaryPath]
 * @param {AbortSignal} [signal]
 * @param {(relativePath: string) => void} [onFileWritten]
 * @param {{ merger?: Function }} [options]
 * @returns {Promise<{
 *   writtenPaths: string[]
 *   completedInputPaths: string[]
 *   warnings: string[]
 *   hardFailures: string[]
 *   truncatedPaths: string[]
 * }>}
 */
export async function writeFileBlocks(
  projectPath,
  text,
  llmConfig,
  outputLanguage,
  sourceFileName,
  sourceSummaryPath,
  signal,
  onFileWritten,
  options,
) {
  const { blocks, warnings: parseWarnings, truncatedPaths } = parseFileBlocks(text)
  const warnings = [...parseWarnings]
  const writtenPaths = []
  // Keep the model-requested path separate from the final path. Path
  // canonicalization may rename the file after parsing, but callers that
  // repair a specific FILE block still need to know that request succeeded.
  const completedInputPaths = []
  // "Hard failures" = blocks we INTENDED to write but the FS rejected
  // (disk full, permission, OS-level errors). Distinct from soft drops
  // (language mismatch, parse warnings, path-traversal rejections):
  // those represent intentional content-level decisions, while hard
  // failures are unexpected losses. The autoIngest cache layer keys
  // off this list — any hard failure means the cache entry must NOT
  // be written, so the next re-ingest goes through the full pipeline
  // instead of replaying the partial result forever.
  const hardFailures = []
  const projectSchemaRouting = await loadProjectWikiSchemaRouting(projectPath)

  const targetLang = outputLanguage
  const today = currentWikiDate()

  for (const { path: rawRelativePath, content: rawContent } of blocks) {
    throwIfIngestAborted(signal)
    let relativePath = rawRelativePath
    if (sourceSummaryPath && relativePath.startsWith("wiki/sources/")) {
      relativePath = sourceSummaryPath
    }
    if (isAppManagedAggregatePath(relativePath)) {
      warnings.push(
        `Ignored model-generated "${relativePath}"; aggregate navigation is maintained by the application.`,
      )
      continue
    }

    // Sanitize at the boundary — strip stray code-fence wrappers,
    // `frontmatter:` prefixes, and repair invalid wikilink-list
    // YAML lines so the file we write is canonical regardless of
    // what shape the model emitted. See `ingest-sanitize.ts` for
    // the recurring corruption shapes this fixes; without this
    // step ~45% of generated entity pages went to disk with
    // unparseable frontmatter and the read-time fallback had to
    // paper over it forever.
    let content = sanitizeIngestedFileContent(rawContent)
    if (isLogPath(relativePath)) {
      content = stampGeneratedLogDate(content, today)
    } else if (!isListingPath(relativePath)) {
      content = stampGeneratedFrontmatterDates(content, today)
    }
    if (!isLogPath(relativePath) && !isListingPath(relativePath)) {
      content = canonicalizeSourcesField(content, sourceFileName)
    }
    if (sourceSummaryPath && relativePath === sourceSummaryPath) {
      content = sourceSummaryMediaRefsForExternalMarkdown(content)
    }
    relativePath = rewriteIngestPathFromTitleForTargetLanguage(relativePath, content, targetLang)

    if (
      projectSchemaRouting &&
      !isLogPath(relativePath) &&
      !isListingPath(relativePath)
    ) {
      const routingIssue = validateWikiPageRouting(
        relativePath,
        content,
        projectSchemaRouting,
      )
      if (routingIssue) {
        const msg = `Dropped "${relativePath}" — ${routingIssue.message}`
        console.warn(`[ingest] ${msg}`)
        warnings.push(msg)
        continue
      }
    }

    // Language guard: reject individual FILE blocks whose body contradicts
    // the user-set target language. Skip:
    // - log.md (structural, short)
    // - /sources/ and /entities/ pages: these legitimately cite cross-
    //   language proper nouns (a German philosophy source summary naturally
    //   quotes Russian philosophers) which confuses naive script-based
    //   detection. Keep the check for /concepts/ pages, which should be
    //   authoritative content in the target language.
    const isLog = isLogPath(relativePath)
    const isEntityOrSource =
      relativePath.startsWith("wiki/entities/") ||
      relativePath.includes("/entities/") ||
      relativePath.startsWith("wiki/sources/") ||
      relativePath.includes("/sources/")
    if (
      targetLang &&
      targetLang !== "auto" &&
      !isLog &&
      !isEntityOrSource &&
      !contentMatchesTargetLanguage(content, targetLang)
    ) {
      const msg = `Dropped "${relativePath}" — body language doesn't match target ${targetLang}.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    const fullPath = `${projectPath}/${relativePath}`
    try {
      if (isLogPath(relativePath)) {
        const existing = await tryReadFile(fullPath)
        const appended = existing ? `${existing}\n\n${content.trim()}` : content.trim()
        await writeFileEnsuringDirs(fullPath, appended)
      } else if (
        isListingPath(relativePath)
      ) {
        // Listing pages (index / overview) are always overwritten
        // wholesale — their sources field is incidental and merging
        // wouldn't make semantic sense (they aren't source-derived
        // content pages).
        await writeFileEnsuringDirs(fullPath, content)
      } else {
        // Content pages (entities / concepts / queries / synthesis /
        // comparisons / sources summaries): if a page with this
        // path already exists on disk, merge old + new instead of
        // clobbering. The merge has three layers:
        //   1. Frontmatter array fields (sources, tags, related)
        //      are union-merged at the application layer.
        //   2. If body content differs, an LLM call produces a
        //      coherent merged body — preserves contributions from
        //      every source document.
        //   3. Locked frontmatter fields (type, title, created)
        //      are forced back to the existing values; updated is
        //      stamped today.
        // LLM failure / sanity rejection falls back to "incoming
        // body + array-field union" with a best-effort backup.
        // See page-merge.ts.
        const existing = await tryReadFile(fullPath)
        // Re-ingesting a corrected source must replace pages owned solely by
        // that source. Merging the old body back into the new generation kept
        // retracted wording alive indefinitely. Multi-source pages still use
        // the merger because their other sources' contributions must survive.
        const replaceExistingBody = Boolean(
          existing && isOwnedOnlyBySource(existing, sourceFileName),
        )
        const merged = await mergePageContent(
          content,
          existing || null,
          options?.merger ?? buildPageMerger(llmConfig),
          {
            sourceFileName,
            pagePath: relativePath,
            signal,
            backup: (oldContent) => backupExistingPage(projectPath, relativePath, oldContent),
            replaceExistingBody,
          },
        )
        // The merge unions existing frontmatter arrays, so sanitize again to
        // remove legacy/generated paths that may already be stored on disk.
        const toWrite = canonicalizeSourcesField(merged, sourceFileName)
        await writeFileEnsuringDirs(fullPath, toWrite)
      }
      writtenPaths.push(relativePath)
      completedInputPaths.push(rawRelativePath)
      onFileWritten?.(relativePath)
    } catch (err) {
      const msg = `Failed to write "${relativePath}": ${err instanceof Error ? err.message : String(err)}`
      console.error(`[ingest] ${msg}`)
      warnings.push(msg)
      hardFailures.push(relativePath)
    }
  }

  return {
    writtenPaths,
    completedInputPaths,
    warnings,
    hardFailures,
    truncatedPaths,
  }
}
