/**
 * Prompt-building functions for the ingest pipeline.
 *
 * Pure functions — zero side effects. Extracted from ingest.ts for
 * maintainability (Phase 3.7, PR 1).
 *
 * Re-exported by ingest.ts so external callers' import paths are unchanged.
 */

import type { ReviewItem } from "@/stores/review-store"
import { GENERATION_WIKI_TYPES } from "@/lib/wiki-page-types"
import { computeContextBudget } from "@/lib/context-budget"
import { buildLanguageDirective } from "@/lib/output-language"

// ── Constants ────────────────────────────────────────────────────

export const REVIEW_STAGE_MIN_SIGNAL_CHARS = 10_000
export const REVIEW_STAGE_MIN_FILE_BLOCKS = 4

// ── Internal helpers ─────────────────────────────────────────────

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

export function parseReviewBlocks(
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

export function countFileBlocks(text: string): number {
  return (text.match(/---FILE:\s*[^-]+---/g) ?? []).length
}

export function shouldRunDedicatedReviewStage(generation: string): boolean {
  return generation.length >= REVIEW_STAGE_MIN_SIGNAL_CHARS
    || countFileBlocks(generation) >= REVIEW_STAGE_MIN_FILE_BLOCKS
    || /---REVIEW:\s*[\w-]+\s*\|[\s\S]*$/i.test(generation)
}

/**
 * Truncate text to `maxChars`, appending a trim notice.
 * Shared by prompt builders and chunk analysis.
 */
export function trimLongText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n\n[...trimmed for prompt budget...]`
}

/**
 * Build the language rule for ingest prompts.
 * Uses the user's configured output language, falling back to source content detection.
 */
export function languageRule(sourceContent: string = ""): string {
  return buildLanguageDirective(sourceContent)
}

// ── Exported prompt builders ─────────────────────────────────────

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 * This is the "discussion" step — the AI reasons about the source before writing wiki pages.
 */
export function buildAnalysisPrompt(purpose: string, index: string, sourceContent: string = ""): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.",
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
export function buildGenerationPrompt(
  schema: string,
  purpose: string,
  index: string,
  sourceFileName: string,
  overview?: string,
  sourceContent: string = "",
  sourceSummaryPath?: string,
): string {
  // Use original filename (without extension) as the source summary page name
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, "")
  const summaryPath = sourceSummaryPath ?? `wiki/sources/${sourceBaseName}.md`

  return [
    "You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE/REVIEW blocks.",
    "",
    languageRule(sourceContent),
    "",
    `## IMPORTANT: Source File`,
    `The original source file is: **${sourceFileName}**`,
    `All wiki pages generated from this source MUST include this filename in their frontmatter \`sources\` field.`,
    "",
    "## What to generate",
    "",
    `1. A source summary page at **${summaryPath}** (MUST use this exact path)`,
    "2. Entity pages in wiki/entities/ for key entities identified in the analysis",
    "3. Concept pages in wiki/concepts/ for key concepts identified in the analysis",
    "4. An updated wiki/index.md — add new entries to existing categories, preserve all existing entries",
    "5. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)",
    "6. An updated wiki/overview.md — a high-level summary of what the entire wiki covers, updated to reflect the newly ingested source. This should be a comprehensive 2-5 paragraph overview of ALL topics in the wiki, not just the new source.",
    "",
    "## Frontmatter Rules (CRITICAL — parser is strict)",
    "",
    "Every page begins with a YAML frontmatter block. Format rules, in order of importance:",
    "",
    "1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).",
    "   Do NOT wrap the file in a ```yaml ... ``` code fence.",
    "   Do NOT prefix it with a `frontmatter:` key or any other line.",
    "2. Each frontmatter line is a `key: value` pair on its own line.",
    "3. The frontmatter ends with another `---` line on its own.",
    "4. The next line after the closing `---` is the start of the page body.",
    "5. Arrays use the standard YAML inline form `[a, b, c]` (no outer brackets around each item).",
    "   Wikilinks belong in the BODY only — never write `related: [[a]], [[b]]` (invalid YAML);",
    "   write `related: [a, b]` with bare slugs.",
    "",
    "Required fields and types:",
    `  \u2022 type     — one of: ${GENERATION_WIKI_TYPES.join(" | ")}`,
    "  \u2022 title    — string (quote it if it contains a colon, e.g. `title: \"Foo: Bar\"`)",
    "  \u2022 created  — date in YYYY-MM-DD form (no quotes)",
    "  \u2022 updated  — same as created",
    "  \u2022 tags     — array of bare strings: `tags: [microbiology, ai]`",
    "  \u2022 related  — array of bare wiki page slugs: `related: [foo, bar-baz]`. Do NOT include",
    "               `wiki/`, `.md`, or `[[\u2026]]` here — slugs only.",
    `  \u2022 sources  — array of source filenames; MUST include "${sourceFileName}".`,
    "",
    "Concrete example of a complete, parseable page (everything between the two `---` lines",
    "is the frontmatter; the heading and prose below are the body):",
    "",
    "    ---",
    "    type: entity",
    "    title: Example Entity",
    "    created: 2026-04-29",
    "    updated: 2026-04-29",
    "    tags: [example, demo]",
    "    related: [related-slug-1, related-slug-2]",
    `    sources: ["${sourceFileName}"]`,
    "    ---",
    "",
    "    # Example Entity",
    "",
    "    Body content goes here. Use [[wikilink]] syntax in the body for cross-references.",
    "",
    "Other rules:",
    "- Use [[wikilink]] syntax in the BODY for cross-references between pages",
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

/**
 * Generate REVIEW suggestion blocks for unresolved knowledge gaps.
 */
export function buildReviewSuggestionPrompt(
  purpose: string,
  index: string,
  sourceIdentity: string,
  analysis: string,
  sourceContext: string,
  generation: string,
  maxContextSize: number | undefined,
): string {
  const { maxCtx } = computeContextBudget(maxContextSize)
  const sectionCap = Math.max(4_000, Math.floor(maxCtx * 0.15))
  const indexCap = Math.max(3_000, Math.floor(sectionCap * 0.8))
  return [
    "You are identifying high-value follow-up research items for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
    "",
    languageRule(sourceContext),
    "",
    "Your job is NOT to generate wiki pages. The wiki page generation already happened.",
    "Output only REVIEW blocks for unresolved knowledge gaps that deserve human attention or Deep Research.",
    "",
    "Create REVIEW blocks only for genuinely useful follow-up work:",
    "- missing-page: an important entity/concept is referenced but still lacks a dedicated page",
    "- suggestion: a research question, source type, or comparison that would materially improve the wiki",
    "- contradiction: a conflict or tension that requires user judgment",
    "- duplicate: likely duplicate pages/names that need user review",
    "",
    "Prefer 1-5 high-signal reviews. If there is nothing worth reviewing, output nothing.",
    "For suggestion and missing-page reviews, include a SEARCH line with 2-3 keyword-rich web search queries separated by ` | `.",
    "Use only these options: OPTIONS: Create Page | Skip",
    "",
    "REVIEW block template:",
    "```",
    "---REVIEW: suggestion | Precise title---",
    "Concise description of the gap and why it matters.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "Return REVIEW blocks only. Do not output FILE blocks. Do not wrap the response in markdown fences.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, indexCap)}` : "",
    "",
    `## Source\n${sourceIdentity}`,
    "",
    "## Stage 1 Analysis",
    trimLongText(analysis, sectionCap),
    "",
    "## Source Context",
    trimLongText(sourceContext, sectionCap),
    "",
    "## Generated Wiki Output",
    trimLongText(generation, sectionCap),
  ].filter(Boolean).join("\n")
}
