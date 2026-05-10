/**
 * Sweep pending review items and auto-resolve those whose underlying
 * condition has been addressed by subsequent ingests.
 *
 * Triggered when the ingest queue drains. Two stages:
 *   1. Rule-based matching (filename / frontmatter title / affectedPages)
 *   2. LLM semantic judgment for remaining pending items
 *
 * Conservative: preserves contradiction / suggestion / confirm types
 * that need human judgment.
 */

import { listDirectory, readFile } from "@/commands/fs"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useActivityStore } from "@/stores/activity-store"
import { useWikiStore } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { normalizeReviewTitle } from "@/lib/review-utils"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { isGraphInputExcludedPage, isGraphInputExcludedPath } from "@/lib/graph-exclusions"

// ── Types ─────────────────────────────────────────────────────────────────

interface WikiPageSummary {
  id: string // filename without .md
  title: string | null // from frontmatter
}

interface WikiIndex {
  byId: Set<string>
  byTitle: Set<string>
  pages: WikiPageSummary[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

/** Build an index of wiki pages: id (filename without .md) + title → normalized */
async function buildWikiIndex(projectPath: string): Promise<WikiIndex> {
  const pp = normalizePath(projectPath)
  const byId = new Set<string>()
  const byTitle = new Set<string>()
  const pages: WikiPageSummary[] = []

  try {
    const tree = await listDirectory(`${pp}/wiki`)
    const files = flattenMdFiles(tree)

    for (const file of files) {
      if (isGraphInputExcludedPath(file.path, file.name)) continue
      const id = file.name.replace(/\.md$/, "").toLowerCase()

      let title: string | null = null
      try {
        const content = await readFile(file.path)
        if (isGraphInputExcludedPage(file.path, file.name, content)) continue
        const match = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
        if (match) {
          title = match[1].trim()
          byTitle.add(title.toLowerCase())
        }
      } catch {
        // skip unreadable files
      }

      byId.add(id)
      pages.push({ id, title })
    }
  } catch {
    // no wiki directory yet
  }

  return { byId, byTitle, pages }
}

/**
 * Extract candidate page names from a review item's title / description.
 * Conservative — only flags items where we can confidently identify a page name.
 */
function extractCandidateNames(item: ReviewItem): string[] {
  const names = new Set<string>()

  // The review title itself is often the missing page name
  // e.g. "Missing page: 注意力机制" or "注意力机制"
  const cleaned = normalizeReviewTitle(item.title)
  if (cleaned && cleaned.length <= 100) {
    names.add(cleaned)
  }

  // For missing-page reviews, affectedPages are the pages that contain
  // the broken reference, not the missing target itself. Including them
  // made "Missing wiki page: dify" resolve just because index.md existed.
  if (item.type !== "missing-page") {
    for (const page of item.affectedPages ?? []) {
      const base = page.split("/").pop()?.replace(/\.md$/, "")
      if (base) names.add(base.toLowerCase())
    }
  }

  return Array.from(names)
}

/** Check if a candidate name matches an existing wiki page */
function pageExists(name: string, index: WikiIndex): boolean {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return false

  // Exact filename match, including older hyphenated ids that may still exist.
  if (index.byId.has(normalized)) return true
  if (index.byId.has(normalized.replace(/\s+/g, "-"))) return true

  // Exact title match (from frontmatter)
  if (index.byTitle.has(normalized)) return true

  return false
}

function strictMissingWikiPageTargetExists(item: ReviewItem, index: Pick<WikiIndex, "byId">): boolean {
  const titleName = normalizeReviewTitle(item.title)
  if (!titleName || titleName.length > 100) return false
  const normalized = titleName.trim().toLowerCase()
  return index.byId.has(normalized) || index.byId.has(normalized.replace(/\s+/g, "-"))
}

function affectedPageExists(path: string, index: Pick<WikiIndex, "byId">): boolean {
  const base = path.split("/").pop()?.replace(/\.md$/, "").toLowerCase()
  return Boolean(base && index.byId.has(base))
}

function normalizeWikiTargetName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-")
}

function contentReferencesWikiTarget(content: string, target: string): boolean {
  const normalizedTarget = normalizeWikiTargetName(target)
  for (const match of content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    if (normalizeWikiTargetName(match[1]) === normalizedTarget) return true
  }
  return false
}

async function missingPageReferenceStillPresent(
  projectPath: string,
  item: ReviewItem,
): Promise<boolean> {
  const target = normalizeReviewTitle(item.title)
  if (!target) return true

  const affected = item.affectedPages ?? []
  if (affected.length === 0) return true

  const pp = normalizePath(projectPath)
  for (const affectedPath of affected) {
    const fullPath = affectedPath.startsWith("/")
      ? normalizePath(affectedPath)
      : `${pp}/${affectedPath}`
    try {
      const content = await readFile(fullPath)
      if (contentReferencesWikiTarget(content, target)) return true
    } catch {
      // Keep pending when the affected page exists but cannot be inspected.
      return true
    }
  }

  return false
}

export function canApplyLlmReviewResolution(
  item: ReviewItem,
  index: Pick<WikiIndex, "byId" | "byTitle">,
): boolean {
  if (item.type === "contradiction" || item.type === "confirm") return false

  if (
    item.type === "missing-page" &&
    /^missing\s+wiki\s+page[:：]/i.test(item.title) &&
    !strictMissingWikiPageTargetExists(item, index)
  ) {
    return false
  }

  const affected = item.affectedPages ?? []
  if (affected.length === 0) return true

  return affected.every((path) => affectedPageExists(path, index))
}

/**
 * Extract a JSON object from an LLM response.
 *
 * Handles:
 *   - Bare JSON: `{...}`
 *   - Fenced: ` ```json\n{...}\n``` ` or single-line ` ```{...}``` `
 *   - Wrapped in prose: find the first balanced `{...}` object via brace depth
 *
 * Returns empty string if no balanced object is found.
 *
 * @internal Exported for unit tests only.
 */
export function extractJsonObject(raw: string): string {
  let text = raw.trim()

  // Strip an opening ```json or ``` fence (with or without newline)
  text = text.replace(/^```(?:json)?\s*/i, "")
  // Strip a trailing ``` fence
  text = text.replace(/\s*```\s*$/i, "")
  text = text.trim()

  // Walk brace depth to find the first complete {...}, respecting strings/escapes
  const start = text.indexOf("{")
  if (start === -1) return ""

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\" && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return ""
}

const JUDGE_BATCH_SIZE = 40
const MAX_JUDGE_BATCHES = 5
const MAX_PAGES_IN_PROMPT = 300

/**
 * Ask the LLM to judge a single batch of pending reviews. Returns the set of
 * resolved review IDs (subset of the batch's IDs).
 *
 * Conservative: returns empty set on any error (network, parse, config missing,
 * aborted).
 */
async function judgeBatch(
  batch: ReviewItem[],
  index: WikiIndex,
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (batch.length === 0 || signal?.aborted) return new Set()

  const llmConfig = useWikiStore.getState().llmConfig
  if (!hasUsableLlm(llmConfig)) return new Set()

  const pages = index.pages.slice(0, MAX_PAGES_IN_PROMPT)

  const pageList = pages
    .map((p) => (p.title ? `- ${p.id}  (title: ${p.title})` : `- ${p.id}`))
    .join("\n")

  const reviewList = batch
    .map((r) => {
      const affected = r.affectedPages?.length ? ` | affected: ${r.affectedPages.join(", ")}` : ""
      const desc = r.description ? ` — ${r.description.slice(0, 200)}` : ""
      return `- id=${r.id} [${r.type}] "${r.title}"${desc}${affected}`
    })
    .join("\n")

  const prompt = [
    "You are cleaning up a stale review queue for a personal wiki.",
    "After recent ingests, some review items may no longer be valid because the missing page now exists, the duplicate was resolved, or the referenced concept has been added.",
    "",
    "Current wiki pages (filename, optional title):",
    pageList || "(no pages yet)",
    "",
    "Pending review items to judge:",
    reviewList,
    "",
    "For each review item, decide whether the underlying condition has been RESOLVED by the current wiki state.",
    "Be conservative: only mark as resolved if you are confident the concern no longer applies.",
    "Do not mark a review resolved when any named affected page is missing from the current wiki.",
    "For contradictions, confirmations, or human-judgment items, default to keeping them pending.",
    "",
    'Respond with ONLY a JSON object in this exact shape: {"resolved": ["id1", "id2"]}',
    'If none of the items are resolved, return exactly: {"resolved": []}',
    "Do not wrap in markdown fences. Do not add commentary.",
  ].join("\n")

  let raw = ""
  let hadError = false

  try {
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
          console.warn("[Sweep Reviews] LLM error:", err.message)
        },
      },
      signal,
    )
  } catch (err) {
    console.warn("[Sweep Reviews] LLM call failed:", err)
    return new Set()
  }

  if (hadError || signal?.aborted || !raw.trim()) return new Set()

  try {
    const cleaned = extractJsonObject(raw)
    if (!cleaned) {
      console.warn("[Sweep Reviews] No JSON object in response:", raw.slice(0, 300))
      return new Set()
    }
    const parsed = JSON.parse(cleaned) as { resolved?: unknown }
    if (!parsed || !Array.isArray(parsed.resolved)) return new Set()

    const validIds = new Set(batch.map((i) => i.id))
    const resolved = new Set<string>()
    for (const id of parsed.resolved) {
      if (typeof id === "string" && validIds.has(id)) {
        resolved.add(id)
      }
    }
    return resolved
  } catch (err) {
    console.warn("[Sweep Reviews] Failed to parse LLM response:", err, raw.slice(0, 300))
    return new Set()
  }
}

/**
 * Judge all remaining pending reviews by processing them in batches.
 *
 * - Caps at MAX_JUDGE_BATCHES to avoid unbounded LLM calls per drain.
 * - Breaks early if a batch resolves nothing (likely nothing else will either).
 * - Stops immediately on abort.
 */
async function llmJudgeReviews(
  pending: ReviewItem[],
  index: WikiIndex,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const resolved = new Set<string>()
  if (pending.length === 0) return resolved

  const remaining = [...pending]
  let batches = 0

  while (remaining.length > 0 && batches < MAX_JUDGE_BATCHES) {
    if (signal?.aborted) break
    const batch = remaining.splice(0, JUDGE_BATCH_SIZE)
    const batchResolved = await judgeBatch(batch, index, signal)
    batches++

    if (batchResolved.size === 0) {
      // Nothing resolved in this batch — further batches likely same result.
      break
    }
    for (const id of batchResolved) resolved.add(id)
  }

  return resolved
}

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the given path still matches the currently-open project.
 * Used to bail mid-sweep if the user has switched projects under us —
 * the sweep's wiki index is for the old project and would falsely match
 * the new project's reviews if we kept going.
 */
function matchesCurrentProject(projectPath: string): boolean {
  const current = useWikiStore.getState().project?.path
  if (!current) return false
  return normalizePath(current) === normalizePath(projectPath)
}

/**
 * Scan pending review items and auto-resolve those whose condition
 * no longer holds. Called when the ingest queue drains.
 *
 * Guards against two races:
 *   - `signal` aborted mid-flight (e.g. project switch triggered clearQueueState)
 *   - The current project changed while we were awaiting I/O — the wiki index
 *     we built is for the wrong project and must not be applied.
 */
export async function sweepResolvedReviews(
  projectPath: string,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) return 0
  if (!matchesCurrentProject(projectPath)) return 0

  const store = useReviewStore.getState()
  const pending = store.items.filter((i) => !i.resolved)

  if (pending.length === 0) return 0

  const index = await buildWikiIndex(projectPath)

  // Re-check after async I/O: user may have switched projects while we
  // were reading the wiki directory.
  if (signal?.aborted || !matchesCurrentProject(projectPath)) return 0

  let ruleResolved = 0
  const stillPending: ReviewItem[] = []

  // Stage 1: rule-based matching
  for (const item of pending) {
    // Bail mid-loop on project switch / abort — applying rules to new
    // project's reviews with old project's wiki index would corrupt state.
    if (signal?.aborted || !matchesCurrentProject(projectPath)) return ruleResolved

    let resolvedByRule = false

    if (item.type === "missing-page") {
      const strictAppMissingPage = /^missing\s+wiki\s+page[:：]/i.test(item.title)
      let resolvedMissingPage = strictAppMissingPage
        ? strictMissingWikiPageTargetExists(item, index)
        : extractCandidateNames(item).some((n) => pageExists(n, index))
      if (strictAppMissingPage && !resolvedMissingPage) {
        resolvedMissingPage = !(await missingPageReferenceStillPresent(projectPath, item))
      }
      if (resolvedMissingPage) {
        store.resolveItem(item.id, "auto-resolved")
        ruleResolved++
        resolvedByRule = true
      }
    } else if (item.type === "duplicate") {
      // If any affected page no longer exists, the duplicate situation changed —
      // auto-resolve (user or cascade-delete took care of it).
      const affected = item.affectedPages ?? []
      if (affected.length > 0) {
        const allStillExist = affected.every((p) => {
          const base = p.split("/").pop()?.replace(/\.md$/, "").toLowerCase()
          return base ? index.byId.has(base) : false
        })
        if (!allStillExist) {
          store.resolveItem(item.id, "auto-resolved")
          ruleResolved++
          resolvedByRule = true
        }
      }
    }

    if (!resolvedByRule) {
      stillPending.push(item)
    }
  }

  // Stage 2: LLM semantic judgment on what's left
  let llmResolved = 0
  const activity = useActivityStore.getState()
  let activityId: string | null = null

  if (stillPending.length > 0 && !signal?.aborted && matchesCurrentProject(projectPath)) {
    // Surface a running indicator so a multi-second LLM judgment doesn't
    // feel like the app froze.
    activityId = activity.addItem({
      type: "query",
      title: "Review cleanup",
      status: "running",
      detail: `Judging ${stillPending.length} pending review${stillPending.length > 1 ? "s" : ""}…`,
      filesWritten: [],
    })

    try {
      const resolvedIds = await llmJudgeReviews(stillPending, index, signal)
      // Final guard: do not write results if the user switched projects
      // or aborted between the LLM call starting and finishing.
      if (!signal?.aborted && matchesCurrentProject(projectPath)) {
        for (const id of resolvedIds) {
          const item = stillPending.find((pendingItem) => pendingItem.id === id)
          if (item && canApplyLlmReviewResolution(item, index)) {
            store.resolveItem(id, "llm-judged")
            llmResolved++
          }
        }
      }
    } catch (err) {
      activity.updateItem(activityId, {
        status: "error",
        detail: `Review cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      activityId = null
    }
  }

  const total = ruleResolved + llmResolved
  const parts: string[] = []
  if (ruleResolved > 0) parts.push(`${ruleResolved} by rules`)
  if (llmResolved > 0) parts.push(`${llmResolved} by LLM`)
  const detail = total > 0
    ? `Auto-resolved ${total} stale review item${total > 1 ? "s" : ""} (${parts.join(", ")})`
    : "No stale review items to clean up"

  if (activityId !== null) {
    activity.updateItem(activityId, {
      status: signal?.aborted ? "error" : "done",
      detail: signal?.aborted ? "Review cleanup cancelled" : detail,
    })
  } else if (total > 0) {
    // Rule-only path: no in-progress indicator was shown, add a done item.
    activity.addItem({
      type: "query",
      title: "Review cleanup",
      status: "done",
      detail,
      filesWritten: [],
    })
  }

  if (total > 0) console.log(`[Sweep Reviews] ${detail}`)

  return total
}
