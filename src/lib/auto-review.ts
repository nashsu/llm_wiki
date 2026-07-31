/**
 * Auto-review: process pending review items through the LLM without
 * manual intervention. Triggered after ingest completes when the
 * autoProcessReviews setting is enabled.
 *
 * For each review item, the LLM decides:
 *   - "skip"     → resolve with no action
 *   - "create"   → generate wiki page content and write it
 *   - "research" → queue Deep Research for the topic
 *   - "hold"     → leave pending for manual review
 *
 * Results are reported via the activity panel.
 */

import { streamChat } from "@/lib/llm-client"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useWikiStore } from "@/stores/wiki-store"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { createReviewPageDrafts } from "@/lib/review-create-page"
import { writeFile, createDirectory, readFile, fileExists } from "@/commands/fs"
import { makeQueryFileName } from "@/lib/wiki-filename"
import { normalizePath } from "@/lib/path-utils"
import { cleanAssistantContentForWikiSave } from "@/lib/chat-save-to-wiki"
import { queueResearch } from "@/lib/deep-research"
import { hasConfiguredDeepResearchSources } from "@/lib/web-search"

// ── Public API ────────────────────────────────────────────────────────────

export interface AutoReviewResult {
  total: number
  resolved: number
  held: number
  created: number
  researched: number
  skipped: number
  errors: number
  details: string[]
}

/**
 * Process all pending review items through the LLM. Called after
 * ingest completes when autoProcessReviews is enabled.
 *
 * Returns a summary of what happened. The caller (ingest.ts) can
 * use this to enrich its activity-panel reporting.
 */
export async function autoProcessReviews(
  projectPath: string,
  signal?: AbortSignal,
): Promise<AutoReviewResult> {
  const store = useReviewStore.getState()
  const pending = store.items.filter((i) => !i.resolved)

  const result: AutoReviewResult = {
    total: pending.length,
    resolved: 0,
    held: 0,
    created: 0,
    researched: 0,
    skipped: 0,
    errors: 0,
    details: [],
  }

  if (pending.length === 0) return result

  const llmConfig = getTaskLlmConfig("ingest")
  if (!hasUsableLlm(llmConfig)) return result

  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "query",
    title: "Auto-review",
    status: "running",
    detail: `Processing ${pending.length} review item(s)…`,
    filesWritten: [],
  })

  // Process each review individually — gives the LLM focused attention
  // per item and keeps prompts short enough for small-context models.
  for (const item of pending) {
    if (signal?.aborted) break

    try {
      await processSingleReview(item, projectPath, result, signal)
    } catch (err) {
      result.errors++
      result.details.push(
        `"${item.title}": error — ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  // Summarise in the activity panel
  const parts: string[] = []
  if (result.created > 0) parts.push(`${result.created} created`)
  if (result.researched > 0) parts.push(`${result.researched} researched`)
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
  if (result.held > 0) parts.push(`${result.held} held`)
  if (result.errors > 0) parts.push(`${result.errors} errors`)

  const summary =
    parts.length > 0
      ? `Auto-processed ${result.resolved}/${result.total} — ${parts.join(", ")}`
      : `All ${result.total} items require manual review — left pending`

  activity.updateItem(activityId, {
    status: signal?.aborted ? "error" : "done",
    detail: summary,
  })

  return result
}

// ── Single item processing ───────────────────────────────────────────────

interface ReviewDecision {
  action: "skip" | "dismiss" | "create" | "research" | "hold"
  /** Human-readable justification (shown in activity panel). */
  reason?: string
  /**
   * Wiki-page content (frontmatter + body) for "create" actions.
   * The LLM is asked to generate this so we avoid a second LLM call.
   */
  content?: string
}

async function processSingleReview(
  item: ReviewItem,
  projectPath: string,
  result: AutoReviewResult,
  signal?: AbortSignal,
): Promise<void> {
  const llmConfig = getTaskLlmConfig("ingest")

  const prompt = buildAutoReviewPrompt(item)

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => {
        raw += token
      },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        console.warn(
          `[AutoReview] LLM error for "${item.title}":`,
          err.message,
        )
      },
    },
    signal,
    {
      temperature: 0.1,
      max_tokens: 2048,
    },
  )

  if (hadError || signal?.aborted || !raw.trim()) {
    result.held++
    result.details.push(`"${item.title}" — LLM error, left pending`)
    return
  }

  const decision = parseAutoReviewDecision(raw)

  if (!decision || !decision.action) {
    result.held++
    result.details.push(
      `"${item.title}" — could not determine action, left pending`,
    )
    return
  }

  const store = useReviewStore.getState()

  switch (decision.action) {
    case "skip":
    case "dismiss":
      store.resolveItem(item.id, "auto-skipped")
      result.skipped++
      result.resolved++
      result.details.push(
        `"${item.title}" — skipped (${decision.reason ?? "no reason"})`,
      )
      break

    case "create": {
      try {
        await createPagesFromReview(item, projectPath, decision.content)
        store.resolveItem(item.id, "auto-created")
        result.created++
        result.resolved++
        result.details.push(
          `"${item.title}" — page created${
            decision.reason ? ` (${decision.reason})` : ""
          }`,
        )
      } catch (err) {
        result.errors++
        result.details.push(
          `"${item.title}" — create failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      break
    }

    case "research": {
      const pp = normalizePath(projectPath)
      const searchConfig = useWikiStore.getState().searchApiConfig
      if (hasConfiguredDeepResearchSources(searchConfig)) {
        const topic = extractResearchTopic(item, decision)
        queueResearch(pp, topic, llmConfig, searchConfig, item.searchQueries)
        store.resolveItem(item.id, "auto-researched")
        result.researched++
        result.resolved++
        result.details.push(
          `"${item.title}" — queued for research${
            decision.reason ? ` (${decision.reason})` : ""
          }`,
        )
      } else {
        result.held++
        result.details.push(
          `"${item.title}" — research needed but Deep Research not configured, left pending`,
        )
      }
      break
    }

    case "hold":
    default:
      result.held++
      result.details.push(
        `"${item.title}" — held (${decision.reason ?? "requires manual review"})`,
      )
      break
  }
}

// ── Prompt building ──────────────────────────────────────────────────────

function buildAutoReviewPrompt(item: ReviewItem): string {
  const optionList =
    item.options.length > 0
      ? item.options
          .map((o) => `  - ${o.label}`)
          .join("\n")
      : "  - Create\n  - Skip\n  - Deep Research"

  const affected =
    item.affectedPages && item.affectedPages.length > 0
      ? `\nAffected pages: ${item.affectedPages.join(", ")}`
      : ""

  const searchHint =
    item.searchQueries && item.searchQueries.length > 0
      ? `\nSuggested search queries for research:\n  ${item.searchQueries.join("\n  ")}`
      : ""

  // Detailed instructions per review type with page-creation guidance
  const typeGuidance = item.type === "missing-page"
    ? 'This review suggests a page is missing and SHOULD be created. Unless the concept is already covered elsewhere, default to "create".'
    : item.type === "suggestion"
      ? 'This is a suggestion for improvement or a new topic. Decide if it should be researched further or if a new page should be created.'
      : item.type === "contradiction"
        ? 'This flags a contradiction. Typically needs human judgment — if the contradiction is clear and resolvable, consider "create" with corrected content; otherwise "hold".'
        : item.type === "duplicate"
          ? 'This flags a possible duplicate. If content is truly redundant, "skip". If there are distinct aspects worth capturing, "create" or "research".'
          : 'This is a general confirmation item. Use judgment.'

  return [
    "You are an automated wiki review agent. Evaluate the following review item and decide what to do.",
    "",
    "---",
    `Type: ${item.type}`,
    `Title: ${item.title}`,
    `Description: ${item.description}`,
    affected,
    searchHint,
    "",
    typeGuidance,
    "",
    "Available options from the review:",
    optionList,
    "",
    "Decide on ONE of the following actions:",
    "",
    '1. "skip" — The issue is not actionable. Resolve and move on.',
    '2. "create" — A new wiki page should be created. Provide the FULL page content in the "content" field.',
    '   - Use Markdown with YAML frontmatter (title, type, tags, created date).',
    '   - The TYPE in frontmatter should be one of: entity, concept, comparison, synthesis, query.',
    '   - Write in the same language as the review title and description.',
    '   - Keep it concise but thorough.',
    '3. "research" — The topic needs Deep Research (web search + synthesis). Only use this for open-ended questions.',
    '4. "hold" — This needs human judgment. Explain why in "reason".',
    "",
    "Respond with a JSON object in this exact shape (no markdown fences, no extra text):",
    '{ "action": "skip" | "create" | "research" | "hold", "reason": "short justification", "content": "full page markdown (only for create)" }',
    "",
    "If choosing 'create', the content field MUST contain valid Markdown with frontmatter.",
    "If choosing 'research' or 'hold', the content field can be omitted or empty.",
  ].join("\n")
}

// ── Response parsing ─────────────────────────────────────────────────────

function parseAutoReviewDecision(raw: string): ReviewDecision | null {
  const text = raw.trim()

  // Try to extract a JSON object
  let json: string | undefined

  // 1. Try fenced code block ```json ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    json = fenceMatch[1].trim()
  } else {
    // 2. Try bare object starting with {
    const braceStart = text.indexOf("{")
    if (braceStart !== -1) {
      // Find the matching closing brace (handling nested braces)
      let depth = 0
      let end = -1
      for (let i = braceStart; i < text.length; i++) {
        if (text[i] === "{") depth++
        else if (text[i] === "}") {
          depth--
          if (depth === 0) {
            end = i + 1
            break
          }
        }
      }
      if (end !== -1) {
        json = text.slice(braceStart, end)
      }
    }
  }

  if (!json) return null

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>

    const action = String(parsed.action ?? "").toLowerCase().trim() as ReviewDecision["action"]
    if (!["skip", "dismiss", "create", "research", "hold"].includes(action)) {
      return null
    }

    const reason =
      typeof parsed.reason === "string" ? parsed.reason.trim() : undefined
    const content =
      typeof parsed.content === "string" ? parsed.content.trim() : undefined

    return { action, reason, content }
  } catch {
    return null
  }
}

// ── Page creation ────────────────────────────────────────────────────────

async function createPagesFromReview(
  item: ReviewItem,
  projectPath: string,
  content?: string,
): Promise<string[]> {
  const pp = normalizePath(projectPath)

  // If the LLM supplied content, write it directly
  if (content && content.length > 50) {
    const clean = cleanAssistantContentForWikiSave(content)
    const title = extractTitleFromContent(clean) || item.title
    const { fileName } = makeQueryFileName(title)

    // Determine the subdirectory based on review type
    const drafts = createReviewPageDrafts(item, "Create")
    const dir = drafts.length > 0 ? drafts[0].dir : "queries"

    const filePath = `${pp}/wiki/${dir}/${fileName}`
    await createDirectory(`${pp}/wiki/${dir}`).catch(() => {})

    // Only write if not already existing (prevent overwriting)
    if (await fileExists(filePath)) {
      return [filePath]
    }

    await writeFile(filePath, clean)
    await updateWikiIndex(pp, title, dir, fileName)
    return [filePath]
  }

  // Fallback: use the review drafts to infer page type and write a stub
  const drafts = createReviewPageDrafts(item, "Create")
  const written: string[] = []

  for (const draft of drafts) {
    const dir = draft.dir
    const { fileName } = makeQueryFileName(draft.title)
    const filePath = `${pp}/wiki/${dir}/${fileName}`
    await createDirectory(`${pp}/wiki/${dir}`).catch(() => {})

    if (await fileExists(filePath)) {
      written.push(filePath)
      continue
    }

    // Write a minimal stub — the LLM-generated content would be better,
    // but a stub with a research prompt is the safe fallback.
    const frontmatter = [
      "---",
      `title: "${draft.title.replace(/"/g, '\\"')}"`,
      `type: ${draft.pageType}`,
      `created: ${new Date().toISOString().slice(0, 10)}`,
      "tags: []",
      "---",
      "",
      `# ${draft.title}`,
      "",
      item.description
        ? `> ${item.description.replace(/\n/g, "\n> ")}`
        : "",
      "",
      "<!-- This page was auto-created from a review item. -->",
      "",
    ].join("\n")

    await writeFile(filePath, frontmatter)
    await updateWikiIndex(pp, draft.title, dir, fileName)
    written.push(filePath)
  }

  return written
}

function extractTitleFromContent(content: string): string | undefined {
  // Try YAML frontmatter title
  const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*"(.+?)"\s*$/m)
  if (titleMatch) return titleMatch[1]
  const titleMatch2 = content.match(/^---\n[\s\S]*?^title:\s*(.+?)\s*$/m)
  if (titleMatch2) return titleMatch2[1]

  // Fallback: first heading
  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  return undefined
}

async function updateWikiIndex(
  projectPath: string,
  title: string,
  dir: string,
  fileName: string,
): Promise<void> {
  const indexPath = `${projectPath}/wiki/index.md`
  let indexContent = ""
  try {
    indexContent = await readFile(indexPath)
  } catch {
    indexContent = "# Wiki Index\n"
  }

  const linkTarget = fileName.replace(/\.md$/, "")
  const entry = `- [[${dir}/${linkTarget}|${title}]]`

  // Find the section header that matches this dir
  const sectionHeader = dir === "queries" ? "Queries" :
    dir === "entities" ? "Entities" :
    dir === "concepts" ? "Concepts" :
    dir === "comparisons" ? "Comparisons" :
    dir === "synthesis" ? "Synthesis" : ""

  if (sectionHeader && indexContent.includes(`## ${sectionHeader}`)) {
    indexContent = indexContent.replace(
      new RegExp(`(## ${sectionHeader}\n)`),
      (match) => `${match}${entry}\n`,
    )
  } else if (sectionHeader) {
    indexContent = indexContent.trimEnd() + `\n\n## ${sectionHeader}\n${entry}\n`
  } else {
    indexContent = indexContent.trimEnd() + `\n\n${entry}\n`
  }

  await writeFile(indexPath, indexContent)
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractResearchTopic(
  item: ReviewItem,
  decision: ReviewDecision,
): string {
  if (decision.reason && decision.reason.length > 5) {
    return `${item.title}: ${decision.reason}`
  }
  return item.title.replace(
    /^(missing[\s-]?page[:：]\s*|duplicate[:：]\s*|suggestion[:：]\s*)/i,
    "",
  ).trim() || item.title
}
