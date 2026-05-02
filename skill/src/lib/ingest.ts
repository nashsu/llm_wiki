/**
 * ingest.ts — Node.js port of nashsu/llm_wiki's two-stage ingest pipeline.
 *
 * Compared to the upstream Tauri/React version (~1600 lines), this port
 * intentionally drops:
 *   - Image extraction (PDF/PPTX/DOCX) — needs Rust pdfium
 *   - Vision-LLM caption pipeline      — needs a multimodal endpoint
 *   - Embedding generation             — optional, has its own shim
 *   - Review-store mutations           — UI-side queue (we still PARSE
 *                                        REVIEW blocks and surface them
 *                                        in the return value)
 *   - Activity-store streaming         — UI side; we use SKILL_VERBOSE
 *
 * The two-stage prompt structure, the FILE-block parser, the path-traversal
 * guard, the language-mismatch guard, the SHA256 incremental cache, and
 * the per-page LLM merge are all preserved verbatim from upstream.
 */
import { readFile, writeFile, fileExists } from "../shims/fs-node"
import { streamChat } from "./llm-client"
import type { LlmConfig } from "../shims/stores-node"
import { useWikiStore, useActivityStore } from "../shims/stores-node"
import { getFileName, normalizePath } from "./path-utils"
import { checkIngestCache, saveIngestCache } from "./ingest-cache"
import { sanitizeIngestedFileContent } from "./ingest-sanitize"
import { mergePageContent, type MergeFn } from "./page-merge"
import { withProjectLock } from "./project-mutex"
import { buildLanguageDirective } from "./output-language"
import { detectLanguage } from "./detect-language"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParsedFileBlock {
  path: string
  content: string
}

export interface ParseFileBlocksResult {
  blocks: ParsedFileBlock[]
  warnings: string[]
}

export interface ReviewItem {
  type: "contradiction" | "duplicate" | "missing-page" | "suggestion" | "confirm"
  title: string
  description: string
  sourcePath: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: { label: string; action: string }[]
}

export interface IngestResult {
  writtenPaths: string[]
  warnings: string[]
  hardFailures: string[]
  reviewItems: ReviewItem[]
  cached: boolean
}

// ── FILE-block parser (preserved from upstream) ──────────────────────────────

const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/

/**
 * Reject FILE block paths that try to escape the project's wiki/ directory.
 * Identical to upstream isSafeIngestPath — see upstream comment for the
 * threat model (LLM prompt-injection via ../../../ in source documents).
 */
export function isSafeIngestPath(p: string): boolean {
  if (typeof p !== "string" || p.trim().length === 0) return false
  if (/[\x00-\x1f]/.test(p)) return false
  if (p.startsWith("/") || p.startsWith("\\")) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  const normalized = p.replace(/\\/g, "/")
  if (normalized.split("/").some((seg) => seg === "..")) return false
  if (!normalized.startsWith("wiki/")) return false
  return true
}

export function parseFileBlocks(text: string): ParseFileBlocksResult {
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  const blocks: ParsedFileBlock[] = []
  const warnings: string[] = []

  let i = 0
  while (i < lines.length) {
    const openerMatch = OPENER_LINE.exec(lines[i])
    if (!openerMatch) { i++; continue }
    const path = openerMatch[1].trim()
    i++

    const contentLines: string[] = []
    let fenceMarker: string | null = null
    let fenceLen = 0
    let closed = false

    while (i < lines.length) {
      const line = lines[i]
      const fenceMatch = FENCE_LINE.exec(line)
      if (fenceMatch) {
        const run = fenceMatch[1]
        const ch = run[0]
        const len = run.length
        if (fenceMarker === null) { fenceMarker = ch; fenceLen = len }
        else if (ch === fenceMarker && len >= fenceLen) { fenceMarker = null; fenceLen = 0 }
        contentLines.push(line); i++; continue
      }
      if (fenceMarker === null && CLOSER_LINE.test(line)) { closed = true; i++; break }
      contentLines.push(line); i++
    }

    if (!closed) {
      const msg = `FILE block "${path || "(unnamed)"}" was not closed before end of stream — likely truncation. Block dropped.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }
    if (!path) {
      const msg = "FILE block with empty path skipped."
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }
    if (!isSafeIngestPath(path)) {
      const msg = `FILE block with unsafe path "${path}" rejected (must be under wiki/, no .., no absolute paths).`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }
    blocks.push({ path, content: contentLines.join("\n") })
  }

  return { blocks, warnings }
}

// ── REVIEW-block parser (preserved from upstream, returned as data) ──────────

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

export function parseReviewBlocks(text: string, sourcePath: string): ReviewItem[] {
  const items: ReviewItem[] = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)
  for (const m of matches) {
    const rawType = m[1].trim().toLowerCase()
    const title = m[2].trim()
    const body = m[3].trim()
    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ReviewItem["type"]

    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => { const label = o.trim(); return { label, action: label } })
      : [{ label: "Approve", action: "Approve" }, { label: "Skip", action: "Skip" }]

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch ? pagesMatch[1].split(",").map((p) => p.trim()) : undefined

    const searchMatch = body.match(/^SEARCH:\s*(.+)$/m)
    const searchQueries = searchMatch
      ? searchMatch[1].split("|").map((q) => q.trim()).filter((q) => q.length > 0)
      : undefined

    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .replace(/^SEARCH:.*$/m, "")
      .trim()

    items.push({ type, title, description, sourcePath, affectedPages, searchQueries, options })
  }
  return items
}

// ── Prompts (preserved from upstream) ────────────────────────────────────────

export function languageRule(sourceContent: string = ""): string {
  return buildLanguageDirective(sourceContent)
}

export function buildAnalysisPrompt(purpose: string, index: string, sourceContent: string = ""): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "",
    languageRule(sourceContent),
    "",
    "## Key Entities",
    "List people, organizations, products, datasets, tools mentioned. For each:",
    "- Name and type",
    "- Role in the source (central vs. peripheral)",
    "- Whether it likely already exists in the wiki (check the index)",
    "",
    "## Key Concepts",
    "List theories, methods, techniques, phenomena. For each:",
    "- Name and brief definition",
    "- Why it matters in this source",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "",
    "## Recommendations",
    "- What wiki pages should be created or updated?",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
  ].filter(Boolean).join("\n")
}

export function buildGenerationPrompt(
  schema: string,
  purpose: string,
  index: string,
  sourceFileName: string,
  overview?: string,
  sourceContent: string = "",
): string {
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, "")
  return [
    "You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
    "",
    languageRule(sourceContent),
    "",
    `## IMPORTANT: Source File`,
    `The original source file is: **${sourceFileName}**`,
    `All wiki pages generated from this source MUST include this filename in their frontmatter \`sources\` field.`,
    "",
    "## What to generate",
    `1. A source summary page at **wiki/sources/${sourceBaseName}.md** (MUST use this exact path)`,
    "2. Entity pages in wiki/entities/ for key entities identified in the analysis",
    "3. Concept pages in wiki/concepts/ for key concepts identified in the analysis",
    "4. An updated wiki/index.md — add new entries to existing categories",
    "5. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)",
    "6. An updated wiki/overview.md — high-level summary of ALL topics",
    "",
    "## Frontmatter Rules (CRITICAL — parser is strict)",
    "1. The VERY FIRST line MUST be exactly `---`. Do NOT wrap in ```yaml fences.",
    "2. Each line is `key: value`.",
    "3. Frontmatter ends with another `---`.",
    "4. Arrays use inline form: `tags: [a, b, c]`. Wikilinks belong in the BODY only.",
    "",
    "Required fields:",
    "  • type    — source | entity | concept | comparison | query | synthesis",
    "  • title   — string (quote if it contains a colon)",
    "  • created — YYYY-MM-DD",
    "  • updated — YYYY-MM-DD",
    "  • tags    — array of bare strings",
    "  • related — array of bare wiki page slugs (no `wiki/`, no `.md`, no `[[…]]`)",
    `  • sources — array of source filenames; MUST include "${sourceFileName}".`,
    "",
    "Use [[wikilink]] syntax in the BODY for cross-references. Use kebab-case filenames.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    overview ? `## Current Overview (update this)\n${overview}` : "",
    "",
    "## Output Format (MUST FOLLOW EXACTLY)",
    "Your ENTIRE response is FILE blocks followed by optional REVIEW blocks. Nothing else.",
    "",
    "FILE block template:",
    "---FILE: wiki/path/to/page.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "",
    "REVIEW block template (optional):",
    "---REVIEW: type | Title---",
    "Description.",
    "OPTIONS: Create Page | Skip",
    "---END REVIEW---",
    "",
    "## Output Requirements (STRICT)",
    "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
    "2. NO preamble, NO trailing prose, NO restating the analysis.",
    "3. Between blocks, only blank lines.",
    "",
    "---",
    "",
    languageRule(sourceContent),
  ].filter(Boolean).join("\n")
}

// ── Language guard (preserved) ───────────────────────────────────────────────

function contentMatchesTargetLanguage(content: string, target: string): boolean {
  const fmEnd = content.indexOf("\n---\n", 3)
  let body = fmEnd > 0 ? content.slice(fmEnd + 5) : content
  body = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$\n]*\$/g, "")
  const sample = body.slice(0, 1500)
  if (sample.trim().length < 20) return true
  const detected = detectLanguage(sample)
  const cjk = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean"])
  const targetIsCjk = cjk.has(target)
  const detectedIsCjk = cjk.has(detected)
  if (targetIsCjk) return detectedIsCjk
  return !detectedIsCjk && !["Arabic", "Hindi", "Thai", "Hebrew"].includes(detected)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function tryReadFile(path: string): Promise<string> {
  try { return await readFile(path) } catch { return "" }
}

async function backupExistingPage(projectPath: string, relativePath: string, existingContent: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sanitized = relativePath.replace(/[/\\]/g, "_")
  await writeFile(`${projectPath}/.llm-wiki/page-history/${sanitized}-${stamp}`, existingContent)
}

function buildPageMerger(llmConfig: LlmConfig): MergeFn {
  return async (existingContent, incomingContent, sourceFileName, signal) => {
    const systemPrompt = [
      "You are merging two versions of the same wiki page into one coherent document.",
      "Output ONE merged version that:",
      "- Preserves every factual claim from both versions",
      "- Eliminates redundancy",
      "- Uses consistent markdown structure",
      "- Keeps `[[wikilink]]` references intact",
      "Output requirements:",
      "- The FIRST character MUST be `-` (the opening of `---`)",
      "- Output the COMPLETE file: YAML frontmatter + body",
      "- No preamble, no analysis prose",
    ].join("\n")
    const userMessage = [
      "## Existing version on disk", "", existingContent, "",
      "---", "",
      `## Newly generated version (from ${sourceFileName})`, "", incomingContent, "",
      "---", "",
      "Now output the merged file. Start with `---` on the first line.",
    ].join("\n")
    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChat(llmConfig, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ], {
        onToken: (t) => { result += t },
        onDone: () => resolve(),
        onError: (err) => { streamError = err; resolve() },
      }, signal, { temperature: 0.1 }).catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

// ── Write FILE blocks (preserved) ────────────────────────────────────────────

async function writeFileBlocks(
  projectPath: string,
  text: string,
  llmConfig: LlmConfig,
  sourceFileName: string,
  signal?: AbortSignal,
): Promise<{ writtenPaths: string[]; warnings: string[]; hardFailures: string[] }> {
  const { blocks, warnings: parseWarnings } = parseFileBlocks(text)
  const warnings = [...parseWarnings]
  const writtenPaths: string[] = []
  const hardFailures: string[] = []

  const targetLang = process.env.WIKI_OUTPUT_LANGUAGE && process.env.WIKI_OUTPUT_LANGUAGE !== "auto"
    ? process.env.WIKI_OUTPUT_LANGUAGE
    : ""

  for (const { path: relativePath, content: rawContent } of blocks) {
    const content = sanitizeIngestedFileContent(rawContent)

    const isLog = relativePath.endsWith("/log.md") || relativePath === "wiki/log.md"
    const isEntityOrSource =
      relativePath.startsWith("wiki/entities/") ||
      relativePath.includes("/entities/") ||
      relativePath.startsWith("wiki/sources/") ||
      relativePath.includes("/sources/")
    if (targetLang && !isLog && !isEntityOrSource && !contentMatchesTargetLanguage(content, targetLang)) {
      const msg = `Dropped "${relativePath}" — body language doesn't match target ${targetLang}.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    const fullPath = `${projectPath}/${relativePath}`
    try {
      if (isLog) {
        const existing = await tryReadFile(fullPath)
        const appended = existing ? `${existing}\n\n${content.trim()}` : content.trim()
        await writeFile(fullPath, appended)
      } else if (
        relativePath === "wiki/index.md" || relativePath.endsWith("/index.md") ||
        relativePath === "wiki/overview.md" || relativePath.endsWith("/overview.md")
      ) {
        await writeFile(fullPath, content)
      } else {
        const existing = await tryReadFile(fullPath)
        const toWrite = await mergePageContent(
          content,
          existing || null,
          buildPageMerger(llmConfig),
          {
            sourceFileName,
            pagePath: relativePath,
            signal,
            backup: (oldContent) => backupExistingPage(projectPath, relativePath, oldContent),
          },
        )
        await writeFile(fullPath, toWrite)
      }
      writtenPaths.push(relativePath)
    } catch (err) {
      const msg = `Failed to write "${relativePath}": ${err instanceof Error ? err.message : String(err)}`
      console.error(`[ingest] ${msg}`)
      warnings.push(msg)
      hardFailures.push(relativePath)
    }
  }

  return { writtenPaths, warnings, hardFailures }
}

// ── Main entry: autoIngest ───────────────────────────────────────────────────

export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig?: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
): Promise<IngestResult> {
  const cfg = llmConfig ?? useWikiStore.getState().llmConfig
  return withProjectLock(normalizePath(projectPath), () =>
    autoIngestImpl(projectPath, sourcePath, cfg, signal, folderContext),
  )
}

async function autoIngestImpl(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
): Promise<IngestResult> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const fileName = getFileName(sp)
  const activity = useActivityStore
  const activityId = activity.addItem({
    type: "ingest", title: fileName, status: "running", detail: "Reading source...", filesWritten: [],
  })

  if (!llmConfig.apiKey && !llmConfig.baseUrl) {
    const msg = "No LLM configured: set OPENAI_API_KEY (or LLM_API_KEY) and optionally LLM_BASE_URL / LLM_MODEL."
    activity.updateItem(activityId, { status: "error", detail: msg })
    throw new Error(msg)
  }

  const [sourceContent, schema, purpose, index, overview] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])

  if (!sourceContent.trim()) {
    const msg = `Source file "${fileName}" is empty or unreadable.`
    activity.updateItem(activityId, { status: "error", detail: msg })
    throw new Error(msg)
  }

  // Cache check
  const cachedFiles = await checkIngestCache(pp, fileName, sourceContent)
  if (cachedFiles !== null) {
    activity.updateItem(activityId, {
      status: "done",
      detail: `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`,
      filesWritten: cachedFiles,
    })
    return { writtenPaths: cachedFiles, warnings: [], hardFailures: [], reviewItems: [], cached: true }
  }

  const truncatedContent = sourceContent.length > 50000
    ? sourceContent.slice(0, 50000) + "\n\n[...truncated...]"
    : sourceContent

  // Stage 1: analysis
  activity.updateItem(activityId, { detail: "Step 1/2: Analyzing source..." })
  let analysis = ""
  let stage1Error: Error | null = null
  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildAnalysisPrompt(purpose, index, truncatedContent) },
      { role: "user", content: `Analyze this source document:\n\n**File:** ${fileName}${folderContext ? `\n**Folder context:** ${folderContext}` : ""}\n\n---\n\n${truncatedContent}` },
    ],
    {
      onToken: (t) => { analysis += t },
      onDone: () => {},
      onError: (err) => { stage1Error = err },
    },
    signal,
    { temperature: 0.1 },
  )
  if (stage1Error) {
    activity.updateItem(activityId, { status: "error", detail: `Analysis failed: ${(stage1Error as Error).message}` })
    throw stage1Error
  }

  // Stage 2: generation
  activity.updateItem(activityId, { detail: "Step 2/2: Generating wiki pages..." })
  let generation = ""
  let stage2Error: Error | null = null
  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildGenerationPrompt(schema, purpose, index, fileName, overview, truncatedContent) },
      {
        role: "user",
        content: [
          `Source document to process: **${fileName}**`,
          "",
          "The Stage 1 analysis below is CONTEXT. Do NOT echo it. Output FILE/REVIEW blocks only.",
          "",
          "## Stage 1 Analysis (context only)",
          "", analysis, "",
          "## Original Source Content",
          "", truncatedContent, "",
          "---",
          "",
          `Now emit the FILE blocks for the wiki files derived from **${fileName}**.`,
          "Your response MUST begin with `---FILE:` as the very first characters.",
        ].join("\n"),
      },
    ],
    {
      onToken: (t) => { generation += t },
      onDone: () => {},
      onError: (err) => { stage2Error = err },
    },
    signal,
    { temperature: 0.1 },
  )
  if (stage2Error) {
    activity.updateItem(activityId, { status: "error", detail: `Generation failed: ${(stage2Error as Error).message}` })
    throw stage2Error
  }

  // Stage 3: write
  activity.updateItem(activityId, { detail: "Writing files..." })
  const { writtenPaths, warnings, hardFailures } = await writeFileBlocks(pp, generation, llmConfig, fileName, signal)

  // Fallback: ensure at least a source-summary page exists
  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const sourceSummaryPath = `wiki/sources/${sourceBaseName}.md`
  const hasSourceSummary = writtenPaths.some((p) => p.startsWith("wiki/sources/"))
  if (!hasSourceSummary && !signal?.aborted) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = [
      "---",
      "type: source",
      `title: "Source: ${fileName}"`,
      `created: ${date}`,
      `updated: ${date}`,
      `sources: ["${fileName}"]`,
      "tags: []",
      "related: []",
      "---",
      "",
      `# Source: ${fileName}`,
      "",
      analysis ? analysis.slice(0, 3000) : "(Analysis not available)",
      "",
    ].join("\n")
    try {
      await writeFile(`${pp}/${sourceSummaryPath}`, fallbackContent)
      writtenPaths.push(sourceSummaryPath)
    } catch { /* non-critical */ }
  }

  const reviewItems = parseReviewBlocks(generation, sp)

  // Cache only on full success
  if (writtenPaths.length > 0 && hardFailures.length === 0) {
    await saveIngestCache(pp, fileName, sourceContent, writtenPaths)
  }

  // Best-effort: bump dataVersion so callers can invalidate caches
  try { useWikiStore.setState((s) => ({ dataVersion: s.dataVersion + 1 })) } catch { /* ignore */ }

  const detail = writtenPaths.length > 0
    ? `${writtenPaths.length} files written${reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""}`
    : "No files generated"
  activity.updateItem(activityId, {
    status: writtenPaths.length > 0 ? "done" : "error",
    detail,
    filesWritten: writtenPaths,
  })

  // fileExists is imported but only used by the cache; keep referenced for tree-shake clarity
  void fileExists
  return { writtenPaths, warnings, hardFailures, reviewItems, cached: false }
}
