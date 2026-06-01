/**
 * Write-layer functions for the ingest pipeline.
 *
 * Page merging, backup, image injection, and re-embedding.
 * Extracted from ingest.ts (Phase 3.7, PR 2). No logic changes.
 * Re-exported by ingest.ts so external callers are unaffected.
 */

import { readFile, writeFile } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import { loadCaptionCache } from "@/lib/image-caption-pipeline"
import { buildImageMarkdownSection } from "@/lib/extract-source-images"
import type { MergeFn } from "@/lib/page-merge"

export async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

export function buildPageMerger(llmConfig: LlmConfig): MergeFn {
  return async (existingContent, incomingContent, sourceFileName, signal) => {
    const systemPrompt = [
      "You are merging two versions of the same wiki page into one coherent document.",
      "Both versions describe the same entity / concept; one is already on disk,",
      "the other was just generated from a different source document.",
      "",
      "Output ONE merged version that:",
      "- Preserves every factual claim from both versions (do not drop content)",
      "- Eliminates redundancy when both versions state the same fact",
      "- Reorganizes sections so the structure is logical for the merged topic,",
      "  not just a concatenation of the two inputs",
      "- Uses consistent markdown structure (headings, tables, lists, callouts)",
      "- Keeps `[[wikilink]]` references intact",
      "",
      "Output requirements:",
      "- The FIRST character of your response MUST be `-` (the opening of `---`)",
      "- Output the COMPLETE file: YAML frontmatter + body",
      "- No preamble (no \"Here is the merged version:\"), no analysis prose",
      "- The caller will overwrite `sources`/`tags`/`related`/`updated` with",
      "  deterministic values — your job is the body and any other fields",
    ].join("\n")

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

    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (token) => {
            result += token
          },
          onDone: () => resolve(),
          onError: (err) => {
            streamError = err
            resolve()
          },
        },
        signal,
        { temperature: 0.1 },
      ).catch((err) => {
        // Defensive: streamChat returns a Promise<void>; if it rejects
        // (instead of going through onError), surface that too.
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

/**
 * Best-effort snapshot of a page before a fallback merge overwrites
 * it. Saved to `.llm-wiki/page-history/<sanitized-path>-<timestamp>.md`
 * so a user who later notices content lost in a merge can recover it.
 * Errors are swallowed by the caller (page-merge's tryBackup).
 */
export async function backupExistingPage(
  projectPath: string,
  relativePath: string,
  existingContent: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sanitized = relativePath.replace(/[/\\]/g, "_")
  const backupPath = `${projectPath}/.llm-wiki/page-history/${sanitized}-${stamp}`
  await writeFile(backupPath, existingContent)
}

/**
 * Append (or replace) the embedded-images section on the source-
 * summary page. Idempotent — paired marker comments bracket our
 * injection, so re-running this for the same source either:
 *   - replaces an existing injection in-place (image set changed), or
 *   - leaves an existing injection untouched (image set unchanged).
 *
 * Falls back to creating a minimal source-summary stub if the
 * page doesn't exist yet (covers the cache-hit path where the
 * original LLM-written page may have been deleted by the user but
 * extracted images are still salvageable, and the rare case where
 * the LLM wrote the source page under a slightly-different slug
 * that didn't match `${sourceBaseName}.md`).
 */
export async function injectImagesIntoSourceSummary(
  pp: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
  savedImages: { relPath: string; page: number | null; sha256?: string }[],
): Promise<boolean> {
  if (savedImages.length === 0) return false
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  console.log(`[ingest:diag] injectImagesIntoSourceSummary: target=${sourceSummaryFullPath}, images=${savedImages.length}`)
  try {
    const existing = await tryReadFile(sourceSummaryFullPath)
    console.log(`[ingest:diag] injectImagesIntoSourceSummary: existing file ${existing ? `read OK (${existing.length} chars)` : "MISSING (will write stub)"}`)
    // Load captions from the on-disk cache so the safety-net
    // section embeds caption text as alt — the embedding pipeline
    // indexes whatever's in the wiki page, so without this, search
    // by image content (e.g. "find the chart with revenue data")
    // never matches because alt text was empty.
    const captionsBySha = await loadCaptionCache(pp)
    const newSection = buildImageMarkdownSection(savedImages as never, captionsBySha)
    const marker = "<!-- llm-wiki:embedded-images -->"
    const wrapped = `\n\n${marker}\n${newSection.trim()}\n${marker}\n`
    if (existing) {
      // Strip any prior injection (paired markers) so re-ingest
      // doesn't accumulate stale references when images change.
      const stripped = existing.replace(
        new RegExp(`\\n*${marker}[\\s\\S]*?${marker}\\n*`, "g"),
        "",
      )
      await writeFile(sourceSummaryFullPath, stripped.trimEnd() + wrapped)
    } else {
      // Page is missing — write a minimal stub so the user actually
      // sees the images in the file tree. Without this fallback, the
      // images sit in wiki/media/<slug>/ with no .md page referencing
      // them, which means the lint view's orphan-page sweep eventually
      // reaps the media directory (cascadeDeleteWikiPage triggered by
      // a missing source page) — silent loss of extracted images.
      const date = new Date().toISOString().slice(0, 10)
      const stubFrontmatter = [
        "---",
        "type: source",
        `title: "Source: ${sourceIdentity}"`,
        `created: ${date}`,
        `updated: ${date}`,
        `sources: ["${sourceIdentity}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${sourceIdentity}`,
        "",
      ].join("\n")
      await writeFile(sourceSummaryFullPath, stubFrontmatter + wrapped)
    }
    console.log(
      `[ingest:images] injected ${savedImages.length} image reference(s) into ${sourceSummaryPath}`,
    )
    return true
  } catch (err) {
    console.warn(
      `[ingest:images] failed to append images to ${sourceSummaryPath}:`,
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

/**
 * Re-embed the source-summary page after we've rewritten its
 * `## Embedded Images` safety-net section with captions. The full
 * autoIngest pipeline calls `embedPage` at step 6 unconditionally;
 * this is the cache-hit equivalent (where step 6 is skipped) and
 * exists specifically to keep the search index in sync after a
 * caption refresh.
 *
 * Why not just call `embedPage` inline at the call site: the
 * embedding store + config lookup, the readFile-then-parse-title
 * dance, and the no-op behavior when embedding is disabled all
 * already exist in the step-6 logic. Wrapping them once here
 * avoids drift between the two paths if either side changes.
 */
export async function reembedSourceSummary(
  pp: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
): Promise<void> {
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model) return
  const sourceSummaryFullPath = `${pp}/wiki/sources/${sourceSummarySlug}.md`
  try {
    const content = await readFile(sourceSummaryFullPath)
    const titleMatch = content.match(
      /^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m,
    )
    const title = titleMatch ? titleMatch[1].trim() : sourceIdentity
    const { embedPage } = await import("@/lib/embedding")
    await embedPage(pp, sourceSummarySlug, title, content, embCfg)
    console.log(`[ingest:caption] re-embedded ${sourceSummarySlug} with captioned alt text`)
  } catch (err) {
    console.warn(
      `[ingest:caption] re-embed failed for ${sourceSummarySlug}:`,
      err instanceof Error ? err.message : err,
    )
  }
}
