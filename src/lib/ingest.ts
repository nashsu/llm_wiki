import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { checkIngestCache, saveIngestCache } from "@/lib/ingest-cache"
import { buildLanguageDirective } from "@/lib/output-language"
import { detectLanguage } from "@/lib/detect-language"

// Path capture group allows any non-newline char so hyphenated paths like
// "wiki/concepts/multi-head-attention.md" are accepted. The lazy `+?` plus
// the following `\s*---\n` anchor still stops at the closing ---.
const FILE_BLOCK_REGEX = /---FILE:\s*([^\n]+?)\s*---\n([\s\S]*?)---END FILE---/g

/**
 * Build the language rule for ingest prompts.
 * Uses the user's configured output language, falling back to source content detection.
 */
export function languageRule(sourceContent: string = ""): string {
  return buildLanguageDirective(sourceContent)
}

/**
 * Auto-ingest: reads source → LLM analyzes → LLM writes wiki pages, all in one go.
 * Used when importing new files.
 */
export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const activity = useActivityStore.getState()
  const fileName = getFileName(sp)
  const activityId = activity.addItem({
    type: "ingest",
    title: fileName,
    status: "running",
    detail: "Reading source...",
    filesWritten: [],
  })

  const [sourceContent, schema, purpose, index, overview] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])

  // ── Cache check: skip re-ingest if source content hasn't changed ──
  const cachedFiles = await checkIngestCache(pp, fileName, sourceContent)
  if (cachedFiles !== null) {
    activity.updateItem(activityId, {
      status: "done",
      detail: `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`,
      filesWritten: cachedFiles,
    })
    return cachedFiles
  }

  const truncatedContent = sourceContent.length > 50000
    ? sourceContent.slice(0, 50000) + "\n\n[...truncated...]"
    : sourceContent

  // ── Step 1: Analysis ──────────────────────────────────────────
  // LLM reads the source and produces a structured analysis:
  // key entities, concepts, main arguments, connections to existing wiki, contradictions
  activity.updateItem(activityId, { detail: "Step 1/2: Analyzing source..." })

  let analysis = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildAnalysisPrompt(purpose, index, truncatedContent) },
      { role: "user", content: `Analyze this source document:\n\n**File:** ${fileName}${folderContext ? `\n**Folder context:** ${folderContext}` : ""}\n\n---\n\n${truncatedContent}` },
    ],
    {
      onToken: (token) => { analysis += token },
      onDone: () => {},
      onError: (err) => {
        activity.updateItem(activityId, { status: "error", detail: `Analysis failed: ${err.message}` })
      },
    },
    signal,
  )

  if (useActivityStore.getState().items.find((i) => i.id === activityId)?.status === "error") {
    return []
  }

  // ── Step 2: Generation ────────────────────────────────────────
  // LLM takes the analysis as context and produces wiki files + review items
  activity.updateItem(activityId, { detail: "Step 2/2: Generating wiki pages..." })

  let generation = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildGenerationPrompt(schema, purpose, index, fileName, overview, truncatedContent) },
      {
        role: "user",
        content: [
          `Source document to process: **${fileName}**`,
          "",
          "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
          "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
          "blocks as specified in the system prompt — nothing else.",
          "",
          "## Stage 1 Analysis (context only — do not repeat)",
          "",
          analysis,
          "",
          "## Original Source Content",
          "",
          truncatedContent,
          "",
          "---",
          "",
          `Now emit the FILE blocks for the wiki files derived from **${fileName}**.`,
          "Your response MUST begin with `---FILE:` as the very first characters.",
          "No preamble. No analysis prose. Start immediately.",
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => { generation += token },
      onDone: () => {},
      onError: (err) => {
        activity.updateItem(activityId, { status: "error", detail: `Generation failed: ${err.message}` })
      },
    },
    signal,
  )

  if (useActivityStore.getState().items.find((i) => i.id === activityId)?.status === "error") {
    return []
  }

  // ── Step 3: Write files ───────────────────────────────────────
  activity.updateItem(activityId, { detail: "Writing files..." })
  const writtenPaths = await writeFileBlocks(pp, generation)

  // Ensure source summary page exists (LLM may not have generated it correctly)
  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const sourceSummaryPath = `wiki/sources/${sourceBaseName}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  const hasSourceSummary = writtenPaths.some((p) => p.startsWith("wiki/sources/"))

  if (!hasSourceSummary) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = [
      "---",
      `type: source`,
      `title: "Source: ${fileName}"`,
      `created: ${date}`,
      `updated: ${date}`,
      `sources: ["${fileName}"]`,
      `tags: []`,
      `related: []`,
      "---",
      "",
      `# Source: ${fileName}`,
      "",
      analysis ? analysis.slice(0, 3000) : "(Analysis not available)",
      "",
    ].join("\n")
    try {
      await writeFile(sourceSummaryFullPath, fallbackContent)
      writtenPaths.push(sourceSummaryPath)
    } catch {
      // non-critical
    }
  }

  if (writtenPaths.length > 0) {
    try {
      const tree = await listDirectory(pp)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }
  }

  // ── Step 4: Parse review items ────────────────────────────────
  const reviewItems = parseReviewBlocks(generation, sp)
  if (reviewItems.length > 0) {
    useReviewStore.getState().addItems(reviewItems)
  }

  // ── Step 5: Save to cache ───────────────────────────────────
  if (writtenPaths.length > 0) {
    await saveIngestCache(pp, fileName, sourceContent, writtenPaths)
  }

  // ── Step 6: Generate embeddings (if enabled) ───────────────
  const embCfg = useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model && writtenPaths.length > 0) {
    try {
      const { embedPage } = await import("@/lib/embedding")
      for (const wpath of writtenPaths) {
        const pageId = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
        if (!pageId || ["index", "log", "overview"].includes(pageId)) continue
        try {
          const content = await readFile(`${pp}/${wpath}`)
          const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
          const title = titleMatch ? titleMatch[1].trim() : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        } catch {
          // non-critical
        }
      }
    } catch {
      // embedding module not available
    }
  }

  const detail = writtenPaths.length > 0
    ? `${writtenPaths.length} files written${reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""}`
    : "No files generated"

  activity.updateItem(activityId, {
    status: writtenPaths.length > 0 ? "done" : "error",
    detail,
    filesWritten: writtenPaths,
  })

  return writtenPaths
}

/**
 * Per-file language guard. Strips frontmatter + code/math blocks, runs
 * detectLanguage on the remainder, and returns whether the content is in
 * a language family compatible with the target. This catches cases where
 * the LLM follows the format spec but writes a single page in a wrong
 * language (observed ~once in 5 real-LLM runs on MiniMax-M2.7-highspeed).
 */
function contentMatchesTargetLanguage(content: string, target: string): boolean {
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
  const targetIsCjk = cjk.has(target)
  const detectedIsCjk = cjk.has(detected)
  if (targetIsCjk) return detectedIsCjk
  return !detectedIsCjk && !["Arabic", "Hindi", "Thai", "Hebrew"].includes(detected)
}

async function writeFileBlocks(projectPath: string, text: string): Promise<string[]> {
  const writtenPaths: string[] = []
  const matches = text.matchAll(FILE_BLOCK_REGEX)

  const targetLang = useWikiStore.getState().outputLanguage

  for (const match of matches) {
    const relativePath = match[1].trim()
    const content = match[2]
    if (!relativePath) continue

    // Language guard: reject individual FILE blocks whose body contradicts
    // the user-set target language. Log entries are short / structural so
    // skip the check for them.
    if (
      targetLang &&
      targetLang !== "auto" &&
      !relativePath.endsWith("/log.md") &&
      relativePath !== "wiki/log.md" &&
      !contentMatchesTargetLanguage(content, targetLang)
    ) {
      console.warn(
        `[ingest] dropping ${relativePath}: content not in target language ${targetLang}`,
      )
      continue
    }

    const fullPath = `${projectPath}/${relativePath}`
    try {
      if (relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")) {
        const existing = await tryReadFile(fullPath)
        const appended = existing ? `${existing}\n\n${content.trim()}` : content.trim()
        await writeFile(fullPath, appended)
      } else {
        await writeFile(fullPath, content)
      }
      writtenPaths.push(relativePath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  return writtenPaths
}

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

function parseReviewBlocks(
  text: string,
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const title = match[2].trim()
    const body = match[3].trim()

    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ReviewItem["type"]

    // Parse OPTIONS line
    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => {
          const label = o.trim()
          return { label, action: label }
        })
      : [
          { label: "Approve", action: "Approve" },
          { label: "Skip", action: "Skip" },
        ]

    // Parse PAGES line
    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    // Parse SEARCH line (optimized search queries for Deep Research)
    const searchMatch = body.match(/^SEARCH:\s*(.+)$/m)
    const searchQueries = searchMatch
      ? searchMatch[1].split("|").map((q) => q.trim()).filter((q) => q.length > 0)
      : undefined

    // Description is the body minus OPTIONS, PAGES, and SEARCH lines
    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .replace(/^SEARCH:.*$/m, "")
      .trim()

    items.push({
      type,
      title,
      description,
      sourcePath,
      affectedPages,
      searchQueries,
      options,
    })
  }

  return items
}

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 * This is the "discussion" step — the AI reasons about the source before writing wiki pages.
 */
export function buildAnalysisPrompt(purpose: string, index: string, sourceContent: string = ""): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "",
    languageRule(sourceContent),
    "",
    "Your analysis should cover:",
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
    "- Whether it likely already exists in the wiki",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "- How strong is the evidence?",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "- Does it strengthen, challenge, or extend existing knowledge?",
    "",
    "## Contradictions & Tensions",
    "- Does anything in this source conflict with existing wiki content?",
    "- Are there internal tensions or caveats?",
    "",
    "## Recommendations",
    "- What wiki pages should be created or updated?",
    "- What should be emphasized vs. de-emphasized?",
    "- Any open questions worth flagging for the user?",
    "",
    "Be thorough but concise. Focus on what's genuinely important.",
    "",
    "If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
    "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    index ? `## Current Wiki Index (for checking existing content)\n${index}` : "",
  ].filter(Boolean).join("\n")
}

/**
 * Step 2 prompt: AI takes its own analysis and generates wiki files + review items.
 */
export function buildGenerationPrompt(schema: string, purpose: string, index: string, sourceFileName: string, overview?: string, sourceContent: string = ""): string {
  // Use original filename (without extension) as the source summary page name
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
    "",
    `1. A source summary page at **wiki/sources/${sourceBaseName}.md** (MUST use this exact path)`,
    "2. Entity pages in wiki/entities/ for key entities identified in the analysis",
    "3. Concept pages in wiki/concepts/ for key concepts identified in the analysis",
    "4. An updated wiki/index.md — add new entries to existing categories, preserve all existing entries",
    "5. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)",
    "6. An updated wiki/overview.md — a high-level summary of what the entire wiki covers, updated to reflect the newly ingested source. This should be a comprehensive 2-5 paragraph overview of ALL topics in the wiki, not just the new source.",
    "",
    "## Frontmatter Rules (CRITICAL)",
    "",
    "Every page MUST have YAML frontmatter with these fields:",
    "```yaml",
    "---",
    "type: source | entity | concept | comparison | query | synthesis",
    "title: Human-readable title",
    "created: YYYY-MM-DD",
    "updated: YYYY-MM-DD",
    "tags: []",
    "related: []",
    `sources: [\"${sourceFileName}\"]  # MUST contain the original source filename`,
    "---",
    "```",
    "",
    `The \`sources\` field MUST always contain "${sourceFileName}" — this links the wiki page back to the original uploaded document.`,
    "",
    "Other rules:",
    "- Use [[wikilink]] syntax for cross-references between pages",
    "- Use kebab-case filenames",
    "- Follow the analysis recommendations on what to emphasize",
    "- If the analysis found connections to existing pages, add cross-references",
    "",
    "## Review block types",
    "",
    "After all FILE blocks, optionally emit REVIEW blocks for anything that needs human judgment:",
    "",
    "- contradiction: the analysis found conflicts with existing wiki content",
    "- duplicate: an entity/concept might already exist under a different name in the index",
    "- missing-page: an important concept is referenced but has no dedicated page",
    "- suggestion: ideas for further research, related sources to look for, or connections worth exploring",
    "",
    "Only create reviews for things that genuinely need human input. Don't create trivial reviews.",
    "",
    "## OPTIONS allowed values (only these predefined labels):",
    "",
    "- contradiction: OPTIONS: Create Page | Skip",
    "- duplicate: OPTIONS: Create Page | Skip",
    "- missing-page: OPTIONS: Create Page | Skip",
    "- suggestion: OPTIONS: Create Page | Skip",
    "",
    "The user also has a 'Deep Research' button (auto-added by the system) that triggers web search.",
    "Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.",
    "",
    "For suggestion and missing-page reviews, the SEARCH field must contain 2-3 web search queries",
    "(keyword-rich, specific, suitable for a search engine — NOT titles or sentences). Example:",
    "  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index (preserve all existing entries, add new ones)\n${index}` : "",
    overview ? `## Current Overview (update this to reflect the new source)\n${overview}` : "",
    "",
    // ── OUTPUT FORMAT MUST BE THE LAST SECTION — models weight recent instructions highest ──
    "## Output Format (MUST FOLLOW EXACTLY — this is how the parser reads your response)",
    "",
    "Your ENTIRE response consists of FILE blocks followed by optional REVIEW blocks. Nothing else.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/path/to/page.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "```",
    "",
    "REVIEW block template (optional, after all FILE blocks):",
    "```",
    "---REVIEW: type | Title---",
    "Description of what needs the user's attention.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "## Output Requirements (STRICT — deviations will cause parse failure)",
    "",
    "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
    "2. DO NOT output any preamble such as \"Here are the files:\", \"Based on the analysis...\", or any introductory prose.",
    "3. DO NOT echo or restate the analysis — that was stage 1's job. Your job is to emit FILE blocks.",
    "4. DO NOT output markdown tables, bullet lists, or headings outside of FILE/REVIEW blocks.",
    "5. DO NOT output any trailing commentary after the last `---END FILE---` or `---END REVIEW---`.",
    "6. Between blocks, use only blank lines — no prose.",
    "7. EVERY FILE block's content (titles, body, descriptions) MUST be in the mandatory output language specified below. No exceptions — not even for page names or section headings.",
    "",
    "If you start with anything other than `---FILE:`, the entire response will be discarded.",
    "",
    // Repeat the language directive at the very end so it wins the "most
    // recent instruction" tie-breaker. Small-to-medium models otherwise
    // drift back to their training-data language for individual pages.
    "---",
    "",
    languageRule(sourceContent),
  ].filter(Boolean).join("\n")
}

function getStore() {
  return useChatStore.getState()
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

export async function startIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sp)
  store.clearMessages()
  store.setStreaming(false)

  const [sourceContent, schema, purpose, index] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const fileName = getFileName(sp)

  const systemPrompt = [
    "You are a knowledgeable assistant helping to build a wiki from source documents.",
    "",
    languageRule(sourceContent),
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const userMessage = [
    `I'm ingesting the following source file into my wiki: **${fileName}**`,
    "",
    "Please read it carefully and present the key takeaways, important concepts, and information that would be valuable to capture in the wiki. Highlight anything that relates to the wiki's purpose and schema.",
    "",
    "---",
    `**File: ${fileName}**`,
    "```",
    sourceContent || "(empty file)",
    "```",
  ].join("\n")

  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error during ingest: ${err.message}`)
      },
    },
    signal,
  )
}

export async function executeIngestWrites(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const store = getStore()

  const [schema, index] = await Promise.all([
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const conversationHistory = store.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  const writePrompt = [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    userGuidance ? `Additional guidance: ${userGuidance}` : "",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    "",
    "Output ONLY the file contents in this exact format for each file:",
    "```",
    "---FILE: wiki/path/to/file.md---",
    "(file content here)",
    "---END FILE---",
    "```",
    "",
    "For wiki/log.md, include a log entry to append. For all other files, output the complete file content.",
    "Use relative paths from the project root (e.g., wiki/sources/topic.md).",
    "Do not include any other text outside the FILE blocks.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  conversationHistory.push({ role: "user", content: writePrompt })

  store.addMessage("user", writePrompt)
  store.setStreaming(true)

  let accumulated = ""

  // In auto mode, fall back to detecting language from the chat history
  // (user's discussion messages) rather than the empty string, which would
  // default to English regardless of the source content.
  const historyText = conversationHistory
    .map((m) => m.content)
    .join("\n")
    .slice(0, 2000)

  const systemPrompt = [
    "You are a wiki generation assistant. Your task is to produce structured wiki file contents.",
    "",
    languageRule(historyText),
    schema ? `## Wiki Schema\n${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  await streamChat(
    llmConfig,
    [{ role: "system", content: systemPrompt }, ...conversationHistory],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error generating wiki files: ${err.message}`)
      },
    },
    signal,
  )

  const writtenPaths: string[] = []
  const matches = accumulated.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    const relativePath = match[1].trim()
    const content = match[2]

    if (!relativePath) continue

    const fullPath = `${pp}/${relativePath}`

    try {
      if (relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")) {
        const existing = await tryReadFile(fullPath)
        const appended = existing
          ? `${existing}\n\n${content.trim()}`
          : content.trim()
        await writeFile(fullPath, appended)
      } else {
        await writeFile(fullPath, content)
      }
      writtenPaths.push(fullPath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  if (writtenPaths.length > 0) {
    const fileList = writtenPaths.map((p) => `- ${p}`).join("\n")
    getStore().addMessage("system", `Files written to wiki:\n${fileList}`)
  } else {
    getStore().addMessage("system", "No files were written. The LLM response did not contain valid FILE blocks.")
  }

  return writtenPaths
}
